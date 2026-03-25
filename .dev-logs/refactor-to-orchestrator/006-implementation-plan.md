# Harmonia 重构实施计划

> 创建时间: 2026-03-24
> 状态: 执行中 — Phase 1, 2, 3, 4 已完成，Phase 5 待开始

基于 001-005 文档的设计讨论和 FAQ 决策，本文档是完整的实施计划。

## 总体原则

- **在现有仓库上改造**，不另起新项目
- **底层模块直接复用**，中间层扩展，上层替换
- 每个 Phase 结束时应有可运行的测试验证
- 步骤按依赖关系排序，靠前的是被依赖项

## 依赖关系

```
Phase 1 (Core 改造)
  └── Phase 2 (适配器层) ← 依赖 Phase 1 的 EventBus + AgentAdapter 接口
        └── Phase 3 (HTTP 服务) ← 依赖 Phase 2 的 AdapterRegistry
              └── Phase 4 (E2E 验证) ← 依赖 Phase 3 的 API
                    └── Phase 5 (清理与打磨)
                          └── Phase 6 (远期，不在本次范围)
```

---

## Phase 1: Core 改造 — 从被动响应到主动驱动 ✅ 完成

**目标**: 工作流引擎从"被 coordinator 调用"变为"自己驱动流程"

**完成时间**: 2026-03-24
**提交**: `17696b1` (主体) + `07324ee` (测试完善)
**结果**: 新增 4 个核心文件、修改 4 个现有文件、新增 6 个测试文件（91 个新测试）。全部 507 个测试通过。

### 1.1 新增事件系统

- 创建 `EventBus` 类（typed EventEmitter，基于 Node.js 内置 EventEmitter）
- 定义所有业务事件类型：
  - Phase 1 立即实现（有生产者和消费者）：
    - `node.activated` — 节点被激活
    - `node.completed` — 节点完成
    - `node.failed` — 节点失败
    - `artifact.written` — artifact 被写入
    - `artifact.approved` — artifact 被审批通过
    - `gate.evaluated` — gate 条件被评估
  - Phase 2+ 按需实现（依赖适配器，类型先定义，payload 和 handler 在有真实消费者时再实现）：
    - `task.dispatched` — 任务已派发给 agent
    - `task.timeout` — 任务超时（定时器触发）
    - `task.stalled` — agent 存活但无进展
    - `agent.unreachable` — agent 不可达
- 当前 `WorkflowEvent` 类型（`node_completed`, `node_failed` 等）是事件的数据定义，EventBus 是其运行时承载
- 现在这些事件由 coordinator 通过 MCP 工具调用"灌"进来，重构后由 Harmonia 内部产生和消费

**涉及文件**: 新建 `src/core/event-bus.ts`

### 1.2 扩展类型定义

- 新增 `TaskPayload` 类型（派发给 agent 的任务包）：
  - `nodeId`, `role`, `prompt`（由 PromptBuilder [1.7] 组装的完整 prompt，包含角色指令 + 上下文 artifact + 产出要求；不同于 003 草案中的 `description`）, `inputArtifacts`, `outputExpectations`, `constraints`, `timeout`
- 新增 `TaskResult` 类型（agent 返回的结果）：
  - `status`, `artifacts`, `error`, `metadata`
- 新增 `AgentStatus` 类型：`running | idle | exited | unreachable`
- 新增 `ValidationConfig` 类型替代 `unmanaged` 概念：
  ```ts
  type ValidationConfig =
    | { type: 'schema' } // JSON Schema 校验（复用现有 schema 系统）
    | { type: 'command'; command: string } // 执行自定义校验命令
    | { type: 'none' }; // 不校验（默认）
  ```
- `ArtifactDefinition` 中 `unmanaged?: boolean` 替换为 `validation?: ValidationConfig`
- 保留所有现有类型不变（`WorkflowNode`, `WorkflowState`, `NextAction` 等）
- `WorkflowDefinition.coordinator` 字段保留，但语义需要澄清：
  - **旧架构**："流程驱动者"的 role ID（coordinator 通过 MCP 调用引擎推进流程）
  - **新架构**："用户沟通桥梁"的 role ID（Orchestrator 接管流程驱动，coordinator 角色退化为用户交互的主要通道）
  - Orchestrator 使用此字段识别哪个已连接 agent 是 coordinator，用于推送审批请求、状态通知等用户交互消息
  - 字段名和类型不变（`coordinator: string`），仅语义调整，代码注释更新
- `RoleFrontmatter` 中 `agent` 字段已存在，无需修改

**涉及文件**: 修改 `src/core/types.ts`

### 1.3 改造 workflow-engine

- 移除文件头 "Core is passive (MCP server)" 注释，更新为主动驱动的描述
- **不改变现有纯函数签名**（`initNodeStates`, `computeNextAction`, `startWorkflow`, `evaluateGate` 等）
- 新增 `Engine` 类，包装现有纯函数：
  - 内部持有 `WorkflowDefinition` + `WorkflowState` + `EngineContext` + `EventBus`
  - 方法：`start()`, `handleEvent(event)`, `getState()`, `getNextAction()`
  - 状态变更时自动通过 EventBus 发出对应事件
- 现有纯函数保留为 Engine 的内部实现，测试继续直接测纯函数

**涉及文件**: 修改 `src/core/workflow-engine.ts`

### 1.4 扩展 dispatch 模块

现有 `dispatch.ts`（290 行）已是功能完整的 CRUD + 状态机模块（`DISPATCH_TRANSITIONS`、`isValidTransition`、`isTerminalStatus`、`hasRunningDispatch` 等），**保留全部现有逻辑**，在此基础上扩展：

- 接入 EventBus：dispatch 创建时触发 `task.dispatched` 事件，状态变更时触发 `node.completed` / `node.failed`
- 增加超时定时器注册逻辑：
  - 派发任务时注册定时器（timeout 来自 `TaskNode.timeout` 或全局默认值）
  - 到期触发时通过适配器 `checkStatus()` 检查 agent 实际状态
  - 根据状态决定：续期 / `task.stalled` / `task.failed`
- Session 概念简化：Harmonia 控制 agent 生命周期，不再依赖 coordinator 创建 session
- 现有 `SessionRecord` / `DispatchRecord` 类型保留，按需扩展

**涉及文件**: 扩展 `src/core/dispatch.ts`

### 1.5 改造 artifacts 模块

- 写入流程反转：
  - 旧：agent 调 MCP `artifact_write` 工具 → Harmonia 被动接收
  - 新：agent 直接写文件到指定位置 → Harmonia 主动检测/收取
- 新增 `validateArtifact(artifactId, content, config: ValidationConfig)` 函数：
  - `schema` → 调用现有 `schema.ts` 的校验逻辑
  - `command` → `child_process.exec()` 执行自定义命令
  - `none` → 直接通过
- `writeArtifact` 保留供引擎内部使用（校验通过后存档）
- `readArtifact` / `listArtifacts` / `resolveArtifactDir` 不变，直接复用

**涉及文件**: 修改 `src/core/artifacts.ts`

### 1.6 迁移 tools/ 中的可复用逻辑到 core/

现有 `src/tools/engine-helpers.ts` 和 `src/tools/utils.ts` 中包含大量非 MCP 特定的通用逻辑，Orchestrator 和 HTTP API 层都需要使用。**在 Phase 3 删除 tools/ 之前就要完成迁移**：

从 `engine-helpers.ts` 迁移：

- `buildGateContext()` — gate 评估上下文构建
- `buildEngineContext()` — 加载 artifact + reviews，组装完整 EngineContext
- `processWorkflowEvent()` — 状态加载 → 引擎计算 → 状态持久化的完整流程
- `resolveFieldPath()` — JSON 字段路径解析（gate 条件用）
- `findTaskNode()` — 在定义树中查找 task 节点
- `formatNextAction()` — nextAction 格式化输出

从 `utils.ts` 迁移：

- `ResolvedContext` 类型 — 项目上下文解析结果
- `resolveActive()` — 解析当前活跃的 iteration/patch 上下文
- `buildOverrideSection()` — override 指令注入（需评估在新架构下是否保留）

迁移目标：合并到 `src/core/engine-helpers.ts`（新文件），剥离 MCP ToolResult 格式依赖。

**涉及文件**: 新建 `src/core/engine-helpers.ts`，从 `src/tools/engine-helpers.ts` 和 `src/tools/utils.ts` 迁移

### 1.7 Prompt 组装逻辑

设计并实现 agent prompt 组装方案。Phase 2 适配器的 `dispatchTask(payload)` 需要 `TaskPayload.prompt` 已经是完整可用的 prompt，因此组装逻辑必须在适配器之前就绑定。

- 组装内容：
  - 角色 system prompt（来自 `roles/*.md`）
  - 上下文 artifact 内容（来自 `inputArtifacts`，按 Q5 默认传完整内容，大文件传路径）
  - 产出要求（期望的 artifact ID、格式、写入路径）
  - 校验规则说明（如果配了 schema/command，告知 agent 产出需要满足什么要求）
- 复用现有 `workflow-engine.ts` 中 `EngineContext.getRolePrompt` 接口定义，以及 `engine-helpers.ts` 中 `buildEngineContext` 的内联实现（注：`getRolePrompt` 不在 `plugin.ts` 中，而是分散在 engine-helpers、iteration-start、patch-start 中的内联实现）
- prompt 组装作为 Orchestrator 的内部方法或独立模块

**涉及文件**: 新建 `src/core/prompt-builder.ts`（`getRolePrompt` 逻辑来自 engine-helpers.ts，不在 plugin.ts 中）

### 1.8 创建 Orchestrator

- 创建 `Orchestrator` 类，这是"指挥官"的具体实现
- 组合：`Engine` + `EventBus` + `AdapterRegistry`（Phase 2）+ `DispatchManager` + `PromptBuilder`（1.7）
- 职责：
  - 监听 EventBus 上的事件
  - 根据 Engine 的 `nextAction` 执行调度决策
  - 组装 TaskPayload（调用 1.7 的 prompt 组装）
  - 调用适配器派发任务 / 推送消息
  - 管理超时定时器
  - **管理已连接的 agent 信息**（agent type + session ID + 连接参数）——外部 agent（特别是 coordinator）通过 `connect` API 注册自身，Orchestrator 记录连接信息，推送消息时据此选择适配器和目标（参见 002 §4.2）
  - **收取 agent 产出**：适配器 `dispatchTask()` resolve 后，根据节点的 `outputExpectations`（artifact 定义列表）到指定路径读取文件，调用 `validateArtifact` 校验（如配置了 validation），校验通过 → emit `artifact.written`，校验失败 → emit `node.failed` + 通知 coordinator
  - EventBus 事件自动输出结构化日志（至少 console，开发阶段能在终端看到事件流即可）
- Phase 1 中 AdapterRegistry 可以是占位接口，Phase 2 填充实现
- 使用 1.6 迁移过来的 `processWorkflowEvent` 等逻辑作为内部实现

**涉及文件**: 新建 `src/core/orchestrator.ts`

### 1.9 更新现有测试

- 确保 workflow-engine 的 149 个测试继续通过（纯函数签名不变）
- 新增 EventBus 单元测试
- 新增 Engine 类单元测试（事件触发验证）
- 新增 Orchestrator 集成测试（mock 适配器）
- 新增 artifact 校验测试（三种 validation 类型）
- 新增 prompt 组装单元测试

**涉及文件**: 修改 + 新增测试文件

---

## Phase 2: 适配器层 ✅

> **完成时间**: 2026-03-24
> **提交**: `2e829cb` — feat: Phase 2 适配器层
>
> **实现清单**:
>
> - 2.1 AgentAdapter / AgentAdapterFactory / AdapterRegistry 接口 → `src/adapters/types.ts`
> - 2.2 DefaultAdapterRegistry + `createDefaultRegistry()` → `src/adapters/registry.ts`
> - 2.3 OpenCode 适配器 → `src/adapters/opencode.ts`
> - 2.4 OpenClaw 适配器（含 pushMessage） → `src/adapters/openclaw.ts`
> - 2.5 Claude Code 适配器 → `src/adapters/claude-code.ts`
> - 2.6 Codex 适配器 → `src/adapters/codex.ts`
> - 2.7 适配器测试: 38 个单元测试 + 7 个 cli-runner 集成测试 + 6 个 E2E 冒烟占位
> - cli-runner 基础设施: `spawnCliProcess()` → `CliProcessHandle`（真实 checkStatus/terminate）
> - PlaceholderAdapterRegistry → deprecated alias for DefaultAdapterRegistry

**目标**: 实现统一的 AgentAdapter 接口 + 首批适配器（CLI 子进程模式）

### 2.1 定义 AgentAdapter 接口

```ts
interface AgentAdapter {
  /** 派发任务给 agent，等待结果 */
  dispatchTask(payload: TaskPayload): Promise<TaskResult>;
  /** 推送消息给 agent（可选，非所有 agent 支持） */
  pushMessage?(message: string): Promise<void>;
  /** 检查 agent 当前状态 */
  checkStatus(): Promise<AgentStatus>;
  /** 终止 agent */
  terminate(): Promise<void>;
}

interface AgentAdapterFactory {
  /** 创建适配器实例 */
  create(config: AdapterConfig): AgentAdapter;
}
```

- 引擎直接检查方法是否存在（`pushMessage` 可选），不需要 capabilities 声明

**涉及文件**: 新建 `src/adapters/types.ts`

### 2.2 创建 AdapterRegistry

- 按 agent type（字符串 key）注册/查找适配器工厂
- 硬编码注册四个适配器，代码结构预留插拔空间
- 提供 `getFactory(agentType: string): AgentAdapterFactory` 方法
  > **实现偏离说明**: 计划原文为 `getAdapter()`，实际命名为 `getFactory()`，因为返回值是 Factory 而非 Adapter，`getFactory` 语义更准确。

**涉及文件**: 新建 `src/adapters/registry.ts`

### 2.3 OpenCode 适配器

- CLI 子进程模式：`spawn('opencode', [...])`
- **stdin 管道注入 prompt**（优于 003 原设计的位置参数方案）
  > **实现改进说明**: 003 设计文档原文为 `opencode run "prompt" --format json`（prompt 作为位置参数），
  > 实现改用 stdin 管道传入 prompt。原因：Harmonia 的 prompt 由 PromptBuilder 组装，
  > 可能包含完整源码文件（Q5 决策 50,000 字符阈值），轻松超过 shell 参数长度限制
  > （macOS ~256KB），stdin 管道无长度限制且无需 shell 转义，是更好的工程选择。
- 等待进程退出，收取结果
- `checkStatus()`：检查子进程是否存活
- `terminate()`：kill 子进程

**涉及文件**: 新建 `src/adapters/opencode.ts`

### 2.4 OpenClaw 适配器

与其他三个适配器不同，OpenClaw 是唯一需要实现 `pushMessage()` 的适配器（Coordinator 推送路径的基础）：

- 派发任务：CLI `openclaw agent --message "..." --timeout 300`
- 推送消息：CLI `openclaw agent --session-id <id> --message "..." --deliver`（002 §4.4 的出站路径）
- 实现 `pushMessage()` 方法——接收 Orchestrator 的推送请求（审批通知、状态变更等），通过 `--deliver` 注入到 coordinator 的活跃 session
- `checkStatus()`：检查子进程或查询 session 状态
- `terminate()`：kill 子进程

**涉及文件**: 新建 `src/adapters/openclaw.ts`

### 2.5 Claude Code 适配器

- CLI 子进程模式：`spawn('claude', [...])`
- 按 Claude Code CLI 规格对接

**涉及文件**: 新建 `src/adapters/claude-code.ts`

### 2.6 Codex 适配器

- CLI 子进程模式：`spawn('codex', [...])`
- 按 Codex CLI 规格对接

**涉及文件**: 新建 `src/adapters/codex.ts`

### 2.7 适配器测试

- 每个适配器的单元测试（mock 子进程 spawn）
- AdapterRegistry 集成测试
- 端到端冒烟测试（实际调用 agent CLI，可选/CI 跳过）

**涉及文件**: 新建测试文件

---

## Phase 3: 入口重写 — MCP → HTTP 服务 ✅ 完成

**目标**: 替换 MCP Server 入口，建立 HTTP API 层

### 3.1 选择 HTTP 框架

- 候选：Hono / Fastify（需评估）
- 原则：薄壳，Harmonia HTTP 层预计 10-20 个端点
- 评估维度：TypeScript 支持、WebSocket 支持、轻量程度、生态

**涉及文件**: `package.json` 依赖变更

### 3.2 创建 HTTP 服务入口

- `harmonia serve` 命令启动 HTTP 服务
- 检查并拷贝内置 workflow 到用户数据目录（从 setup 迁移至此，参见 3.7）
- 创建 Orchestrator 实例
- 挂载 API 路由
- 启动 WebSocket 服务

**涉及文件**: 新建 `src/server.ts`

### 3.3 重写 CLI 入口

- `harmonia` 或 `harmonia serve` → 启动 HTTP 服务（不再是 MCP stdio）
- `harmonia setup` → 注册项目到 registry + 创建项目数据目录（不再注入 MCP 配置）
- `harmonia unregister` → 保留不变
- `harmonia --help` / `--version` → 更新说明文字

**涉及文件**: 重写 `src/index.ts`

### 3.4 实现核心 API 端点

从新架构的需求出发设计 HTTP API，**不是 1:1 迁移 MCP 工具**。重构后部分 MCP 工具已变为引擎内部行为，不再需要外部端点。

#### 外部 API（coordinator / 管理操作需要）

| HTTP 端点                                        | 说明                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `POST /api/connect`                              | Agent 注册自身到 Harmonia（agent type + session ID + 连接参数），Coordinator 入站的基础（002 §4.2） |
| `DELETE /api/connect/:id`                        | Agent 断开连接                                                                                      |
| `POST /api/projects`                             | 初始化项目（原 `project_init`）                                                                     |
| `POST /api/projects/:name/iterations`            | 开始新迭代（原 `iteration_start`）                                                                  |
| `POST /api/projects/:name/patches`               | 开始新补丁（原 `patch_start`）                                                                      |
| `GET /api/projects/:name/status`                 | 查询项目状态（原 `get_project_status`）                                                             |
| `GET /api/projects/:name/artifacts/:id`          | 读取 artifact（原 `artifact_read`）                                                                 |
| `GET /api/projects/:name/artifacts`              | 列出 artifacts（原 `artifact_list`）                                                                |
| `POST /api/projects/:name/artifacts/:id/approve` | 审批 artifact（原 `artifact_approve`）                                                              |
| `GET /api/projects/:name/artifacts/:id/schema`   | 获取 artifact schema（原 `artifact_schema`）                                                        |
| `POST/GET /api/projects/:name/issues`            | Issue CRUD（原 `issue_*`）                                                                          |

#### 不再暴露为外部 API（变为引擎内部行为）

| 原 MCP 工具       | 理由                                                          |
| ----------------- | ------------------------------------------------------------- |
| `dispatch_role`   | 引擎根据 nextAction 自动调度，外部不应触发                    |
| `report_dispatch` | Agent 通过适配器 `dispatchTask()` 返回结果，不再需要 API 上报 |
| `artifact_write`  | Agent 直接写文件到指定位置，Harmonia 主动收取（Q13）          |
| `get_role_prompt` | 引擎内部 PromptBuilder 组装完整 prompt，外部无理由单独调用    |
| `loop_done`       | 引擎内部根据状态判断循环结束                                  |

实施时逐个 MCP 工具文件对照，确保外部 API 覆盖了所有仍需暴露的业务逻辑（参数校验、错误处理、边角 case）。**3.6 删除 tools/ 前做一次全量对照确认**。

**涉及文件**: 新建 `src/api/` 目录及路由文件

### 3.5 WebSocket 状态推送（可选，可推迟到 Phase 6）

- **当前阶段非必需**：Coordinator 通过 HTTP API 操作，Harmonia 通过适配器 `pushMessage` 主动通知 Coordinator，不依赖 WebSocket
- WebSocket 的核心价值是给 Web UI 做实时状态推送，而 Web UI 是 Phase 6 远期目标
- 如果 Phase 3 时间充裕可以顺手实现，否则推迟到 Phase 6 与 Web UI 一起做
- 实现方案（备忘）：
  - EventBus 事件 → WebSocket 广播，简单转发
  - 推送内容：节点状态变更、任务派发/完成、审批请求等

**涉及文件**: 新建 `src/api/ws.ts`（如实现）

### 3.6 删除 MCP 相关代码

- **前置条件**：3.4 的 API 端点已全量覆盖原 MCP 工具中仍需暴露的业务逻辑，逐个工具文件对照确认无遗漏
- 删除 `src/tools/` 目录全部 14 个文件
- 删除 `@modelcontextprotocol/sdk` 依赖
- `src/tools/engine-helpers.ts` 和 `src/tools/utils.ts` 中有用的逻辑已在 Phase 1.6 迁移到 `src/core/`

**涉及文件**: 删除 `src/tools/*`，修改 `package.json`

### 3.7 重写 setup 逻辑

- 旧 setup：注入 MCP 配置到 agent 的配置文件 + 注入 prompt + 拷贝内置 workflow
- 新 setup：只做注册项目到 registry + 创建项目数据目录
- agent 不再需要知道 Harmonia 的存在（Harmonia 主动调 agent，不是 agent 调 Harmonia）
- `src/setup/inject.ts` 和 `src/setup/templates.ts` 中的 MCP 注入逻辑删除
- 当前 `setup.ts` 中的内置 workflow 拷贝逻辑（将 `workflows/` 拷贝到用户数据目录）移到 `harmonia serve` 启动流程中（3.2），HTTP 服务启动时检查并确保 workflow 可用

**涉及文件**: 重写 `src/cli/setup.ts`，重写或删除 `src/setup/*`

### 3.8 API 测试

- 每个端点的集成测试（启动 HTTP 服务 → 发请求 → 验证响应）
- WebSocket 推送测试

**涉及文件**: 新建测试文件

> **Phase 3 执行记录** (2026-03-25)
>
> 提交: `30cd946` — feat: Phase 3 入口重写 — MCP → HTTP 服務
>
> 关键实现:
>
> - `src/server.ts` — Hono HTTP 服务入口 (createApp, ensureWorkflows, startServer)
> - `src/api/routes.ts` — 全部 HTTP API 路由处理器 (286 行)
> - `src/core/operations.ts` — 提取的业务逻辑层 (1333 行, transport-agnostic)
> - `src/index.ts` — 重写 CLI 入口 (harmonia serve)
> - `src/cli/setup.ts` — 重写为纯项目注册
> - `tests/api.test.ts` — 22 个 API 集成测试
>
> 删除: `src/tools/` (14 文件, 3509 行), `src/setup/inject.ts`, `src/setup/templates.ts`, `@modelcontextprotocol/sdk`
>
> 测试: 576 passed, 6 skipped (E2E), tsc 零错误
>
> 偏离:
>
> - `artifact_write` 端点保留(006 标记为"不再暴露")——过渡期仍需外部写入能力,Phase 5 再决定去留
> - `connect` 端点为 501 占位——依赖 Phase 4 Orchestrator 集成
> - 额外端点: `GET /api/projects`, `GET /reviews`, `PATCH /issues/:id`——合理增补
> - WebSocket 按计划推迟到 Phase 6

---

## Phase 4: Coordinator 对接验证 ✅

> **完成时间**: 2026-03-25
> **执行偏离**:
>
> - 006 计划中 4.1-4.4 设想用真实 agent 做集成验证。实际实施为集成测试（mock adapter），
>   验证 Orchestrator 通过完整 workflow fixture 的 prompt 组装、pushMessage 链路、
>   E2E 序列推进、以及所有错误路径。真实 agent E2E 验证留待 Phase 6。
> - 增加 4.A（OrchestratorPool 集成到 server/routes）和 4.B（connect/disconnect 端点实现）
>   作为前置步骤，替换 Phase 3 的 501 占位。
>   **产出**: `src/core/orchestrator-pool.ts`, `tests/phase4-integration.test.ts`(22 tests),
>   修改 `src/server.ts` + `src/api/routes.ts`

**目标**: 端到端跑通一个完整工作流

### 4.1 验证 Prompt 注入效果

- Phase 1.7 已实现 prompt 组装逻辑，此步验证实际效果
- 用真实 agent 验证组装出的 prompt 是否：
  - 包含完整的角色指令
  - 正确传递了上下文 artifact 内容
  - 清晰指明了产出要求（写入位置、格式、校验规则）
  - agent 能正确理解并执行
- 根据验证结果调整 prompt 模板

**涉及文件**: 可能修改 `src/core/prompt-builder.ts` 或 `src/core/plugin.ts`

### 4.2 Coordinator 适配验证

- OpenClaw 作为 coordinator 的链路验证：
  1. Harmonia 推送审批请求（`pushMessage`）→ OpenClaw 收到
  2. OpenClaw 转发给用户（飞书/Slack）
  3. 用户回复审批意见
  4. OpenClaw 调 Harmonia HTTP API 完成审批
- 验证 Q14 的设计（审批主路径是 Coordinator）

**涉及文件**: 集成测试

### 4.3 Dev 工作流端到端测试

- 用现有 dev workflow 插件跑一轮完整流程：
  - `init` → `start iteration` → 引擎自动 dispatch → agent 执行 → 收取 artifact → gate → approve → 下一节点 → ... → workflow completed
- 验证主路径（happy path）完整可用

**涉及文件**: 端到端测试

### 4.4 错误路径验证

- agent 失败 → 标记节点 failed → 通知 coordinator
- 超时 → 检查 agent 状态 → 续期或标记失败
- agent 进程崩溃 → `task.failed` 事件
- 验证 Q2（驱动机制）和 Q8（错误处理）的设计

**涉及文件**: 端到端测试

---

## Phase 5: 清理与打磨

**目标**: 移除遗留代码，完善细节

### 5.1 MCP 零残留确认

- Phase 3.6 已删除代码和依赖，此步做最终扫描确认
- 全局搜索 `@modelcontextprotocol`、`McpServer`、`ToolResult`、`StdioServerTransport` 等关键词
- 确认 `package.json` 中依赖已移除，代码库中无残留 import

**涉及文件**: `package.json`

### 5.2 移除 `unmanaged` 概念

- `ArtifactDefinition` 中的 `unmanaged` 字段在 Phase 1.2 已被 `validation` 替代
- 此步清理所有残留引用：类型定义、dev workflow 的 `workflow.json`、测试代码
- 确认 `unmanaged` 字符串在代码库中不再出现

**涉及文件**: `src/core/types.ts`, `workflows/dev/workflow.json`, 测试文件

### 5.3 移除/重新设计 Override 相关类型

- `OverrideToolType` 的 `'skill' | 'mcp'` 不再适用
- 评估 override 系统在新架构下的需求：
  - 角色级的 agent 覆盖（`RoleOverride.agent`）仍有意义
  - 工具覆盖（`CapabilityOverride`）的 `type: 'mcp'` 需要重新设计或移除
- 如果 override 系统整体需要重做，记录为后续任务

**涉及文件**: `src/core/types.ts`, `src/core/overrides.ts`

### 5.4 更新 dev workflow 插件

- 角色文件确认 `agent` 字段存在且正确
- artifact 定义中 `unmanaged` → `validation` 配置
- 评估 hooks 目录是否仍需要（`@s_s/agent-kit` 的 hooks 机制在新架构下是否仍适用）
- 更新 `workflow.json` 中可能需要调整的字段

**涉及文件**: `workflows/dev/` 目录

### 5.5 评估 `@s_s/agent-kit` 依赖

- **状态**: 待讨论
- 重构完成后检查 `@s_s/agent-kit` 的实际使用情况：
  - `AgentType` 类型 → 是否仍需要，还是用自定义类型替代
  - `getDataDir()` → 是否仍在使用
  - hooks 相关 → 新架构下是否仍适用
- 如果仍有合理用途则保留，否则迁移并移除

**涉及文件**: 全局搜索 `@s_s/agent-kit` 引用

### 5.6 更新 package.json

- 确认所有依赖变更正确：
  - 移除：`@modelcontextprotocol/sdk`
  - 新增：HTTP 框架（Hono/Fastify）
- 更新 `description` 字段（不再是 MCP Server）
- 更新 `bin` 入口（如有变化）
- 更新 `scripts`（如需新增 `serve` 脚本等）

**涉及文件**: `package.json`

### 5.7 全量测试通过

- 运行全部测试，确保通过
- 覆盖率不低于重构前水平
- 修复因重构引入的任何回归问题

**涉及文件**: 所有测试文件

---

## Phase 6: 远期（A2A + Web UI）

**不在本次重构范围内**，列出以确认架构预留到位。

### 6.1 A2A JSON-RPC 端点

- 在 HTTP 层新增 `/a2a/*` 路由
- 实现 A2A 标准方法（`SendMessage`, `GetTask` 等）
- JSON-RPC 2.0 over HTTPS

### 6.2 Agent Card 生成

- 从 workflow 定义自动生成 A2A Agent Card
- 需要 `workflow.json` 中的 `name` 和 `description` 字段

### 6.3 Harmonia 作为 A2A Client

- 部门间协作场景
- workflow 节点中定义"调用外部 Harmonia 实例"

### 6.4 Web UI

- React/Vue 管理控制台
- 消费 HTTP API + WebSocket
- 功能：全局概览、历史记录可视化、状态监控
- 是否支持审批操作待讨论

---

## 附录：文件变更总览

### 直接复用（不改动）

| 文件                             | 说明                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/core/registry.ts`           | 数据目录管理、路径函数、注册表 CRUD（注：依赖 `@s_s/agent-kit`，如 5.5 评估决定移除则需修改） |
| `src/core/state.ts`              | 工作流状态持久化                                                                              |
| `src/core/reviews.ts`            | 审核状态管理                                                                                  |
| `src/core/steps.ts`              | 分步状态管理                                                                                  |
| `src/core/schema.ts`             | JSON Schema 校验                                                                              |
| `src/core/tree-utils.ts`         | 工作流树遍历工具                                                                              |
| `src/core/workflow-validator.ts` | 工作流定义静态校验                                                                            |
| `src/core/issues.ts`             | Issue 追踪                                                                                    |
| `src/core/action-registry.ts`    | 节点 hook action 注册                                                                         |

### 修改/扩展

| 文件                          | 变更内容                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `src/core/types.ts`           | 新增 TaskPayload/TaskResult/AgentStatus/ValidationConfig，修改 ArtifactDefinition |
| `src/core/workflow-engine.ts` | 新增 Engine 类包装现有纯函数，接入 EventBus                                       |
| `src/core/dispatch.ts`        | 扩展：接入 EventBus 事件触发，新增超时定时器管理，Session 概念简化                |
| `src/core/artifacts.ts`       | 新增 validateArtifact()，调整写入流程                                             |
| `src/core/plugin.ts`          | 扩展 role 加载（确认 agent 字段）                                                 |
| `src/core/overrides.ts`       | 移除 MCP 相关 override 类型                                                       |
| `src/index.ts`                | 重写为 HTTP 服务入口                                                              |
| `src/cli/setup.ts`            | 重写为纯项目注册                                                                  |
| `package.json`                | 依赖变更                                                                          |

### 新增

| 文件                          | 说明                                                        |
| ----------------------------- | ----------------------------------------------------------- |
| `src/core/event-bus.ts`       | 事件系统                                                    |
| `src/core/orchestrator.ts`    | 编排器主类                                                  |
| `src/core/engine-helpers.ts`  | 从 tools/ 迁移的引擎辅助逻辑（gate 上下文、事件处理流程等） |
| `src/core/prompt-builder.ts`  | Prompt 组装逻辑（或合并到 plugin.ts）                       |
| `src/adapters/types.ts`       | AgentAdapter 接口定义                                       |
| `src/adapters/registry.ts`    | 适配器注册表                                                |
| `src/adapters/opencode.ts`    | OpenCode 适配器                                             |
| `src/adapters/openclaw.ts`    | OpenClaw 适配器                                             |
| `src/adapters/claude-code.ts` | Claude Code 适配器                                          |
| `src/adapters/codex.ts`       | Codex 适配器                                                |
| `src/server.ts`               | HTTP 服务启动                                               |
| `src/api/*.ts`                | HTTP API 路由                                               |
| `src/api/ws.ts`               | WebSocket 推送                                              |

### 删除

| 文件                          | 说明             |
| ----------------------------- | ---------------- |
| `src/tools/*.ts`（14 个文件） | MCP 工具全部删除 |
| `src/setup/inject.ts`         | MCP 注入逻辑     |
| `src/setup/templates.ts`      | MCP 模板逻辑     |
