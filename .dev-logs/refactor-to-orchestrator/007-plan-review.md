# 006 实施计划复查修正

> 创建时间: 2026-03-24
> 状态: 已应用

对 006-implementation-plan.md 的逐项复查结果。对照 005 FAQ 决策、001-004 架构文档、代码现状，找出偏离、遗漏、不合理和过度优化。

---

## 一、偏离（计划描述与实际决策/代码不一致）

### P1. dispatch.ts 的改造程度被高估

**006 原文**: 1.4 标题"改造 dispatch 模块"，附录写"重写为主动管理模式"

**问题**: 实际代码（290 行）已经是功能完整的 CRUD + 状态机模块——有 `DISPATCH_TRANSITIONS`、`isValidTransition`、`isTerminalStatus`、`hasRunningDispatch` 等主动逻辑。称之为"被动记录"不准确，"重写"的措辞与 Q15"底层复用、中间扩展"原则冲突。

**修正**: 将 1.4 定位从"重写"改为"扩展"——保留现有 CRUD 和状态机，新增：

- EventBus 事件触发（状态变更时 emit）
- 超时定时器注册/管理
- Session 概念简化

附录文件变更表中 dispatch.ts 从"重写为主动管理模式"改为"扩展：新增事件触发和超时管理"。

---

### P2. OpenClaw 适配器描述过于笼统

**006 原文**: 2.4 只写"CLI 子进程模式：`spawn('openclaw', [...])`，类似 OpenCode 模式"

**问题**: 003 §5.1 明确区分了 OpenClaw 与其他三个 agent 的差异——OpenClaw 走 `agent` 命令派发任务 + `--deliver` 推送消息。006 把它写成和 OpenCode/Claude Code/Codex 一样的模式，丢失了关键差异：

1. OpenClaw 是唯一需要实现 `pushMessage()` 的适配器
2. 推送消息的 CLI 调用方式不同（`--session-id <id> --message "..." --deliver`）
3. OpenClaw 作为 coordinator 载体时的推送路径是整个 Phase 4.2 的基础

**修正**: 2.4 应改为：

> **OpenClaw 适配器**
>
> - 派发任务：CLI `openclaw agent --message "..." --timeout 300`
> - 推送消息：CLI `openclaw agent --session-id <id> --message "..." --deliver`
> - 实现 `pushMessage()` 方法（其他三个适配器不需要）
> - `checkStatus()`：检查子进程或查询 session 状态
> - `terminate()`：kill 子进程

---

### P3. TaskPayload 类型定义与 003 草案不一致但未说明

**006 原文**: 1.2 中 TaskPayload 包含 `prompt` 字段

**问题**: 003 §六的接口草案中 TaskPayload 包含的是 `description`（自然语言任务描述）+ `context`（工作流上下文）。006 改为 `prompt`（完整 prompt），这反映了 1.7 PromptBuilder 的设计意图——适配器拿到的应该是组装好的完整 prompt，而非原始描述。变更本身合理，但两处定义不一致可能在实现时造成混淆。

**修正**: 1.2 中 TaskPayload 的 `prompt` 字段添加注释说明：

```ts
/** 由 PromptBuilder (1.7) 组装的完整 prompt，包含角色指令 + 上下文 artifact + 产出要求。
 *  不同于 003 草案中的 description（原始任务描述）。*/
prompt: string;
```

---

## 二、遗漏（文档讨论了但计划没覆盖）

### M1. Connect 机制缺失【严重】

**来源**: 002 §4.2

**问题**: 002 明确讨论了外部 agent（特别是 coordinator）通过 `connect()` 接口注册到 Harmonia 的机制——Coordinator 主动来连接 Harmonia，Harmonia 记录连接信息，后续需要推送消息时根据 agent 类型选择适配器推送。

006 完全没有覆盖这一点：

- Phase 3.4 的 API 端点表没有 connect 端点
- Phase 4.2 的 Coordinator 对接验证假设了 Harmonia 能"推送审批请求给 OpenClaw"，但没说 OpenClaw 怎么先注册自己
- Orchestrator (1.8) 没有描述 agent 连接管理

**这是功能性遗漏**。Harmonia 需要知道 coordinator 的 session ID 才能往回推送消息，不可能凭空知道。

**修正**: 两处需要补充：

1. Phase 1.8（Orchestrator）中补充连接管理职责：

   > - 管理已连接的 agent 信息（agent type + session ID + 连接参数）
   > - 推送消息时根据已注册信息选择适配器和目标

2. Phase 3.4 的 API 端点表新增：
   > | `POST /api/connect` | agent 注册自身到 Harmonia（agent type + session 信息） |
   > | `DELETE /api/connect/:id` | agent 断开连接 |

---

### M2. Agent 产出收取的触发时机未明确

**来源**: Q13（005），1.5（006）

**问题**: Q13 确认了"agent 直接写文件 → Harmonia 主动检测/收取"。1.5 描述了 `validateArtifact`，但没有回答一个关键问题：**Harmonia 怎么知道 agent 已经写完了文件？**

CLI 子进程模式下，答案是"适配器 `dispatchTask()` 返回（即进程退出）= 任务完成 → 此时去指定路径读取文件"。这个逻辑隐含在适配器和 Orchestrator 的衔接中，但 006 没有显式描述。

**修正**: 在 1.8（Orchestrator）的职责中补充：

> - 适配器 `dispatchTask()` resolve 后，根据节点的 `outputExpectations`（artifact 定义列表）到指定路径收取文件
> - 收取后调用 `validateArtifact` 进行校验（如配置了 validation）
> - 校验通过 → emit `artifact.written` → 触发后续 gate 评估
> - 校验失败 → emit `node.failed` + 通知 coordinator

---

### M3. 日志/可观测性缺失

**问题**: 006 没有任何步骤涉及日志系统。Q14 提到"错误排查：终端日志或 HTTP API"，Phase 4 的 E2E 验证如果没有结构化日志，调试会极其困难。

这不是奢侈品，是基本运维需求。

**修正**: 不需要专门一个步骤，但在 1.8（Orchestrator）中追加一条：

> - EventBus 事件自动输出结构化日志（至少 console，后续可扩展到文件/外部系统）

开发阶段能在终端看到事件流就够了，不需要设计日志框架。

---

## 三、不合理（顺序/依赖/逻辑问题）

### U1. Phase 3.4 与 3.6 的关系不够明确

**006 原文**: 3.4 "从现有 14 个 MCP 工具映射为 HTTP API"，3.6 "删除 `src/tools/` 目录全部 14 个文件"

**问题**: 1.6 迁移了 engine-helpers 和 utils 的可复用逻辑，但剩下的 14 个 tool handler 文件中仍有业务逻辑（参数校验、错误处理、边角 case）。3.4 实现 API 端点时需要参考这些文件，如果 3.6 删除太草率可能遗漏功能。

**修正**: 3.4 中追加注明：

> 实施时逐个 MCP 工具文件对照实现 HTTP 端点，确保所有业务逻辑（参数校验、错误处理、边角 case）被 API 层覆盖。3.6 删除前做一次全量对照确认。

---

### U2. Phase 5.1 与 3.6 职责重复

**006 原文**: 3.6 "删除 `@modelcontextprotocol/sdk` 依赖"，5.1 "确认 `package.json` 中依赖已移除"

**问题**: 5.1 实质上是 3.6 的验证步骤，不是独立工作。单独列一步显得 Phase 5 有内容填充嫌疑。

**修正**: 5.1 改为"MCP 零残留确认"——全局搜索 `@modelcontextprotocol`、`McpServer`、`ToolResult`、`StdioServerTransport` 等关键词，确认代码库中无残留引用。合并到一个验证动作即可。

---

## 四、过度优化（当前不需要做的事）

### O1. 1.1 事件类型定义过早过细

**006 原文**: 1.1 列了 10 种事件类型

**问题**: Phase 1 阶段适配器还不存在，`task.dispatched`、`task.timeout`、`task.stalled`、`agent.unreachable` 这些事件在 Phase 1 中没有实际的生产者和消费者。TypeScript 类型定义本身开销为零，但实现时需要设计每种事件的数据结构（payload shape），这些在没有真实消费者时是猜测性设计。

**修正**: 1.1 中将事件类型分两批标注：

Phase 1 立即实现（有生产者和消费者）：

- `node.activated`, `node.completed`, `node.failed`
- `artifact.written`, `artifact.approved`
- `gate.evaluated`

Phase 2+ 按需实现（依赖适配器）：

- `task.dispatched`, `task.timeout`, `task.stalled`
- `agent.unreachable`

类型定义可以先全部写出来，但事件的 payload 结构和 handler 只实现第一批。

---

### O2. 3.4 的 API 端点 1:1 映射 MCP 工具

**006 原文**: 14 个 MCP 工具一一映射为 14 个 HTTP 端点

**问题**: 重构后部分 MCP 工具的语义已经变了，不应该再暴露为外部 API：

| MCP 工具          | 重构后状态   | 理由                                        |
| ----------------- | ------------ | ------------------------------------------- |
| `dispatch_role`   | 变为内部行为 | 引擎自己调度，外部不应该触发                |
| `report_dispatch` | 变为内部行为 | agent 通过适配器返回结果，不再需要 API 上报 |
| `artifact_write`  | 变为内部行为 | agent 直接写文件，Harmonia 主动收取（Q13）  |
| `get_role_prompt` | 变为内部行为 | 引擎内部 PromptBuilder 组装，外部无理由调用 |
| `loop_done`       | 需评估       | 可能变为引擎内部判断                        |

1:1 迁移是 MCP 思维惯性，不是从新架构的需求出发。

**修正**: 3.4 实施前先做端点筛选，区分：

- **外部 API**（coordinator / 管理操作需要的）：project*init, iteration_start, patch_start, get_project_status, artifact_read, artifact_list, artifact_approve, artifact_schema, issue*\*, connect
- **内部逻辑**（引擎/适配器内部完成的）：dispatch_role, report_dispatch, artifact_write, get_role_prompt

端点数量预计从 14 缩减到 ~10。

---

## 五、确认无问题的部分

以下逐项对照，确认 006 与决策/代码一致，不需要修改：

| 006 步骤                   | 对照来源                                                                                                   | 结论 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- | ---- |
| Phase 依赖顺序 1→2→3→4→5   | 全局                                                                                                       | 正确 |
| 1.1 EventBus               | Q2（事件驱动）                                                                                             | 对齐 |
| 1.2 类型扩展               | Q13（ValidationConfig）、代码（`unmanaged` 已存在于 ArtifactDefinition、`agent` 已存在于 RoleFrontmatter） | 对齐 |
| 1.3 Engine 类包装纯函数    | Q2（主动驱动）、代码（workflow-engine.ts 1127 行纯函数）                                                   | 对齐 |
| 1.5 artifact 校验          | Q13（三种校验类型）                                                                                        | 对齐 |
| 1.6 迁移 engine-helpers    | 代码（无 MCP SDK 依赖，纯移动操作）                                                                        | 对齐 |
| 1.7 Prompt 组装            | Q5（默认传完整内容）、代码（`getRolePrompt` 在 engine-helpers 中）                                         | 对齐 |
| 1.9 测试                   | 代码（416 测试、21 文件）                                                                                  | 对齐 |
| 2.1 接口去掉 capabilities  | Q3/Q6（无能力声明、显式指定 agent）                                                                        | 对齐 |
| 2.2 AdapterRegistry 硬编码 | Q7（硬编码 + 预留插拔）                                                                                    | 对齐 |
| 2.3/2.5/2.6 CLI 子进程     | Q4（CLI 子进程起步）                                                                                       | 对齐 |
| 3.1-3.3 HTTP 服务          | Q1（HTTP 服务、前后端分离）                                                                                | 对齐 |
| 3.5 WebSocket 可选/推迟    | Q14（Web UI 远期）                                                                                         | 对齐 |
| 3.7 重写 setup             | 代码（setup.ts 注入 MCP prompt → 改为纯注册）                                                              | 对齐 |
| 4.2 Coordinator 审批       | Q14（审批主路径是 Coordinator）                                                                            | 对齐 |
| 4.4 错误路径               | Q8（标记失败 + 通知）                                                                                      | 对齐 |
| 5.2 移除 unmanaged         | 代码（`unmanaged?: boolean` 存在于 types.ts:190）                                                          | 对齐 |
| 5.3 Override 重设计        | 代码（`CapabilityOverride` 含 `type: 'mcp'`，需清理）                                                      | 对齐 |
| 5.5 评估 agent-kit         | 代码（5 文件引用）                                                                                         | 对齐 |
| Phase 6 A2A/Web UI         | Q9/Q11/Q12（推迟）                                                                                         | 对齐 |

---

## 六、修正清单

按优先级排列，标注影响范围和严重程度：

| 编号 | 类别     | 严重度 | 影响步骤      | 修正内容                                   |
| ---- | -------- | ------ | ------------- | ------------------------------------------ |
| M1   | 遗漏     | **高** | 1.8, 3.4, 4.2 | 补充 Connect 机制（agent 注册 + 连接管理） |
| M2   | 遗漏     | 中     | 1.5, 1.8      | 明确 agent 产出收取的触发时机和流程        |
| O2   | 过度优化 | 中     | 3.4           | API 端点筛选，去掉变为内部行为的工具       |
| P1   | 偏离     | 中     | 1.4           | dispatch.ts 从"重写"改为"扩展"             |
| P2   | 偏离     | 中     | 2.4           | OpenClaw 适配器补充差异化描述              |
| P3   | 偏离     | 低     | 1.2           | TaskPayload.prompt 字段添加注释            |
| M3   | 遗漏     | 低     | 1.8           | Orchestrator 追加结构化日志输出            |
| O1   | 过度优化 | 低     | 1.1           | 事件类型分两批标注实现优先级               |
| U1   | 不合理   | 低     | 3.4, 3.6      | 明确对照确认后再删除                       |
| U2   | 不合理   | 低     | 5.1           | 合并为"MCP 零残留确认"                     |

---

## 七、应用方式

本文档的修正建议有两种应用方式：

1. **直接修改 006**：将上述修正逐条应用到 006-implementation-plan.md
2. **实施时参照**：006 保持不变，实施每个步骤时对照本文档的修正

建议采用方式 1——直接修改 006，保持单一信息源，避免实施时需要同时看两份文档。本文档保留作为修改记录。
