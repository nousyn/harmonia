# Agent 适配器方案分析

> 创建时间: 2026-03-23
> 状态: 已确认（核心结论），接口草案待后续细化

## 一、背景

002 确定了 Harmonia 对外只有两种动作：**派发任务**（等结果）和**推送消息**（单向通知）。本文档基于对四个 agent（OpenCode、OpenClaw、Claude Code、Codex）的源码/文档分析，整理各自的对接方式，并提出统一适配器接口设计。

**重要原则：Agent 与角色解耦。** Harmonia 不固定"某个 agent 只能做某种角色"。Workflow 定义决定谁扮演什么角色——OpenCode 可以做 coordinator，OpenClaw 也可以做开发执行者。因此适配器的设计目标是评估每个 agent 的**完整能力覆盖**，而非预设用途。

## 二、四个 Agent 对接方式总览

### 2.1 对接方式对比矩阵

| 维度         | OpenCode             | OpenClaw                        | Claude Code                      | Codex                       |
| ------------ | -------------------- | ------------------------------- | -------------------------------- | --------------------------- |
| **推荐对接** | `opencode run` CLI   | Gateway WebSocket JSON-RPC      | `claude -p` CLI                  | `codex exec` CLI            |
| **输出格式** | JSON 事件流          | JSON-RPC 响应                   | JSON / stream-json               | JSON Lines                  |
| **会话续接** | `--session`          | session ID                      | `--continue` / `--resume`        | `codex exec resume --last`  |
| **权限控制** | 自动拒绝权限请求     | 工具策略 allow/deny             | `--dangerously-skip-permissions` | `--full-auto` + `--sandbox` |
| **费用控制** | 无直接参数           | 无直接参数                      | `--max-budget-usd`               | 无直接参数                  |
| **轮次限制** | 无直接参数           | 无直接参数                      | `--max-turns`                    | 无直接参数                  |
| **备选方案** | ACP / HTTP API + SDK | ACP / OpenAI 兼容 API / Webhook | Agent SDK                        | TypeScript SDK              |
| **成熟度**   | 高（源码已读）       | 高（源码已读）                  | 高（文档已读）                   | 中（文档已读）              |

### 2.2 完整能力矩阵（角色无关）

每个 agent 在 Harmonia 需要的各维度上的能力评估：

| 能力                     | OpenCode                                     | OpenClaw                                   | Claude Code                                                      | Codex                   |
| ------------------------ | -------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- | ----------------------- |
| **派发任务（等结果）**   | ✅ `opencode run`                            | ✅ `agent` RPC（同步/异步双模式）          | ✅ `claude -p`                                                   | ✅ `codex exec`         |
| **推送消息（单向通知）** | ⚠️ 需 `serve` + `prompt_async`，仅限空闲会话 | ✅ `agent --deliver`                       | ⚠️ Channels（research preview，需自建 MCP bridge）               | ❌ 无任何机制           |
| **多渠道用户交互**       | ⚠️ 通过外部包（Slack/飞书），非核心          | ✅ 原生支持飞书/Slack/TUI/WebChat          | ⚠️ Channels 支持 Telegram/Discord + Remote Control，preview 阶段 | ❌ 纯终端单用户         |
| **中途消息注入**         | ❌ BusyError，运行中不可注入                 | ✅ `agent --deliver` 可随时注入            | ⚠️ Channels 可以，但需 MCP bridge 且 preview                     | ❌ turn 执行中无法注入  |
| **沙箱/代码执行**        | ✅ 内置                                      | ✅ Docker 沙箱 + bash/python/git           | ✅ 内置                                                          | ✅ 内置（默认只读沙箱） |
| **文件读写**             | ✅ 内置                                      | ✅ read/write/edit/grep/find/ls 完整工具集 | ✅ 内置                                                          | ✅ 内置                 |
| **HTTP API**             | ✅ `opencode serve`                          | ✅ Gateway WebSocket + HTTP                | ❌ 无原生 HTTP 服务                                              | ❌ 无                   |
| **SDK**                  | ✅ `@opencode-ai/sdk`                        | ✅ Gateway JSON-RPC                        | ✅ Python/TS SDK（headless）                                     | ✅ `@openai/codex-sdk`  |

**关键结论**：

1. **四个 agent 都能做"被派发任务的执行者"**——这个方向无障碍
2. **能做 coordinator（用户交互 + 消息接收）的只有 OpenClaw 完全具备**，Claude Code 勉强可以（preview 阶段），OpenCode 有条件限制，Codex 完全不行
3. **OpenClaw 能力最全**——既能做 coordinator（原生多渠道），也能做编码执行（Docker 沙箱 + 完整工具集）
4. **Codex 能力最窄**——纯粹的"单次任务执行器"

### 2.3 Harmonia 的两种动作在各 agent 上的实现

| 动作         | OpenCode                            | OpenClaw                                                     | Claude Code                             | Codex                      |
| ------------ | ----------------------------------- | ------------------------------------------------------------ | --------------------------------------- | -------------------------- |
| **派发任务** | `opencode run "任务" --format json` | `agent` RPC 方法                                             | `claude -p "任务" --output-format json` | `codex exec "任务" --json` |
| **推送消息** | N/A（不做通信）                     | `openclaw agent --session-id <id> --message "..." --deliver` | N/A（不做通信）                         | N/A（不做通信）            |

## 三、各 Agent 详细分析

### 3.1 OpenCode

**能力概述**：CLI 非交互执行、HTTP API 服务模式、ACP 协议、TypeScript SDK。派发任务能力完备，消息注入受限（运行中 BusyError），多渠道用户交互需借助外部包。

**推荐对接方式**：`opencode run` CLI 非交互模式

```bash
opencode run "实现用户认证模块，要求..." --format json
```

特点：

- 非交互批处理模式，自动拒绝所有权限请求
- JSON 事件流输出，可解析进度和最终结果
- 支持 `--model` 指定模型、`--agent` 指定 agent 配置
- 支持 `--session` 续接已有会话

**备选方式 A**：ACP 协议

```bash
opencode acp  # stdin/stdout ndJSON 双向通信
```

- 更细粒度的会话控制
- 适合需要中途干预的场景
- 复杂度较高

**备选方式 B**：HTTP REST API

```bash
opencode serve --port 3100  # 启动 HTTP 服务
```

- 长期运行的服务模式
- 配套 TypeScript SDK（`@opencode-ai/sdk`）
- 适合 Harmonia 作为常驻进程时使用

**备选方式 C**：Plugin SDK

- `@opencode-ai/plugin` 可扩展 OpenCode 的能力
- 可以为 OpenCode 编写 Harmonia 专用 plugin，让 OpenCode 主动回报进度
- 但这让 OpenCode 感知 Harmonia 的存在，增加耦合

**推荐理由**：

- `opencode run` 最简单直接，符合"派发任务 → 等结果"的模式
- 不需要 OpenCode 预先启动为服务
- Harmonia 完全控制生命周期（启动 → 等完成 → 收结果）

### 3.2 OpenClaw

**能力概述**：能力最全面的 agent。Gateway JSON-RPC 全功能接口（105+ 方法）、Docker 沙箱代码执行、完整文件工具集（read/write/edit/grep/find/ls）、原生多渠道用户交互（飞书/Slack/TUI/WebChat）、运行中消息注入（`--deliver`）、OpenAI 兼容 API、ACP 协议。既能做被派发任务的执行者（`agent` RPC 同步/异步双模式），也能做 coordinator 载体（原生多渠道 + 消息注入）。

**推荐对接方式**：Gateway WebSocket JSON-RPC（全功能）+ CLI（推送消息 / 派发任务）

**作为执行者时**：

```bash
# 派发编码任务
openclaw agent --message "实现用户认证模块，要求..." --timeout 300
```

**作为 coordinator 载体时**：

入站（OpenClaw → Harmonia）：

- Coordinator 通过 OpenClaw skill 调用 Harmonia API
- Harmonia 侧暴露 API，不需要 OpenClaw 适配器参与

出站（Harmonia → OpenClaw）：

```bash
openclaw agent --session-id <coordinator-session> --message "..." --deliver
```

**Gateway JSON-RPC 关键方法**（105+ 方法，以下列出最相关的）：

| 方法         | 用途                                              |
| ------------ | ------------------------------------------------- |
| `agent`      | 发起 agent 运行（可用于在 OpenClaw 上启动新任务） |
| `send`       | 发送消息到指定 channel                            |
| `chat.send`  | WebChat 交互                                      |
| `sessions.*` | 会话管理                                          |

**备选方式 A**：OpenAI 兼容 HTTP API

```
POST /v1/chat/completions
```

- 任何 OpenAI SDK 可直接调用
- 适合需要和 OpenClaw 进行 chat 交互的场景

**备选方式 B**：ACP 协议

```bash
openclaw acp  # stdin/stdout ndJSON
```

- 用于桌面客户端/IDE 集成场景
- 对 Harmonia 场景不太适用

**备选方式 C**：Inbound Webhook

```
POST /hooks/agent  # 外部事件触发 agent
POST /hooks/wake   # 唤醒 agent
```

- 适合事件驱动场景
- 但不支持 Outbound Webhook（OpenClaw 无法主动回调 Harmonia）

**已知限制**：

- 没有 Outbound Webhook——不支持外部系统注册回调 URL 接收推送
- `openclaw agent --deliver` 推送消息会在用户消息列表中出现伪用户消息（体验瑕疵，不影响功能）
- `openclaw message send` 绑定具体 channel，TUI 用户收不到
- `openclaw system event` 是心跳级系统提示，不适合实时通信

### 3.3 Claude Code

**能力概述**：CLI 非交互执行、原生费用/轮次控制、强大的系统提示注入、工具权限白名单/黑名单、管道输入、Agent SDK。Channels（preview）理论上支持多渠道交互，但尚不成熟。

**推荐对接方式**：`claude -p` 非交互 print 模式

```bash
claude -p "实现用户认证模块，要求..." \
  --output-format json \
  --max-turns 20 \
  --max-budget-usd 5.00 \
  --dangerously-skip-permissions
```

特点：

- 非交互模式，输出结果后退出
- 支持 JSON / stream-json 输出
- 内置费用上限（`--max-budget-usd`）和轮次限制（`--max-turns`）
- 支持自定义系统提示（`--system-prompt` / `--append-system-prompt`）
- 支持工具权限控制（`--allowedTools` / `--disallowedTools`）
- 支持管道输入：`cat context.md | claude -p "基于此上下文..."`
- 支持 `--continue` / `--resume` 续接会话
- 支持 `--mcp-config` 加载 MCP 服务器

**备选方式**：Agent SDK

- `platform.claude.com/docs/en/agent-sdk`
- 用于构建自定义 agent
- 适合深度集成，但复杂度高

**推荐理由**：

- `claude -p` 与 `opencode run` 模式高度一致
- 费用/轮次控制是 OpenCode 不具备的优势
- 系统提示注入能力强，适合传递工作流上下文

### 3.4 Codex

**能力概述**：CLI 非交互执行、默认只读沙箱（安全性最强）、JSON Schema 结构化输出（可直接对齐 Harmonia artifact schema）、TypeScript SDK。能力最窄——纯粹的单次任务执行器，无消息注入、无用户交互、无 HTTP API。

**推荐对接方式**：`codex exec` 非交互模式

```bash
codex exec "实现用户认证模块，要求..." \
  --json \
  --full-auto \
  --sandbox workspace-write
```

特点：

- 非交互模式，进度输出到 stderr，最终结果输出到 stdout
- JSON Lines 事件流输出
- 默认在只读沙箱中运行（安全）
- `--full-auto` 允许编辑，`--sandbox` 控制权限级别
  - `workspace-write`：可写工作区
  - `danger-full-access`：完全访问
- 支持 `--output-schema schema.json` 结构化 JSON 输出（符合 JSON Schema）
- 支持 `--ephemeral` 不持久化 session
- 支持 `codex exec resume --last "继续"` 续接

**备选方式**：TypeScript SDK

```typescript
import { Codex } from '@openai/codex-sdk';
const thread = Codex.startThread();
const result = await thread.run('任务描述');
```

- 编程化集成
- 适合 Harmonia 作为 Node.js 常驻进程时使用

**推荐理由**：

- `codex exec` 与 `opencode run`、`claude -p` 模式高度一致
- 沙箱化执行是独特优势，适合不信任场景
- `--output-schema` 可以直接对齐 Harmonia 的 artifact schema

## 四、关键发现与模式提取

### 4.1 派发任务：四个 agent 高度一致

所有 agent 在"派发任务（等结果）"这个方向上模式完全一致：

```
CLI 非交互模式 → 传入任务描述 → 等待完成 → 收取 JSON 结果
```

差异在细节层面：

- **权限控制粒度**：Codex（沙箱）> Claude Code（工具白名单）> OpenCode（自动拒绝）> OpenClaw（工具策略 allow/deny）
- **费用控制**：Claude Code 有原生 `--max-budget-usd`，其他均无
- **输出结构化**：Codex 支持 `--output-schema` JSON Schema 约束，最适合对齐 Harmonia artifact schema
- **会话续接**：四者都支持，但实现方式不同

**关键结论**：适配器的 `dispatchTask()` 方法可以是统一接口，所有 agent 都能实现。

### 4.2 推送消息与用户交互：能力分化严重

这是四个 agent 差异最大的维度：

| 能力         | OpenClaw    | Claude Code | OpenCode    | Codex |
| ------------ | ----------- | ----------- | ----------- | ----- |
| 推送消息     | ✅ 完整支持 | ⚠️ preview  | ⚠️ 仅限空闲 | ❌    |
| 多渠道交互   | ✅ 原生     | ⚠️ preview  | ⚠️ 需外部包 | ❌    |
| 中途消息注入 | ✅          | ⚠️          | ❌          | ❌    |

**关键结论**：`pushMessage()` 不是所有 agent 都能实现的。适配器需要通过能力声明（capability declaration）让引擎知道哪些 agent 支持哪些动作，而非强制分类为"执行适配器"或"通信适配器"。

### 4.3 能力声明模式

每个 agent 适配器应声明自己支持的能力集合，而非被分入固定类别：

```
OpenClaw 适配器 → capabilities: [dispatchTask, pushMessage, userInteraction]
OpenCode 适配器 → capabilities: [dispatchTask]
Claude Code 适配器 → capabilities: [dispatchTask]
Codex 适配器 → capabilities: [dispatchTask]
```

Workflow 定义中的节点指定需要哪些能力，引擎根据能力匹配选择 agent。这样：

- OpenClaw 既可以被分配编码任务（用 `dispatchTask`），也可以承载 coordinator（用 `pushMessage` + `userInteraction`）
- 未来 Claude Code Channels 成熟后，只需更新 Claude Code 适配器的能力声明，无需修改引擎或工作流
- 新增 agent 只需实现适配器并声明能力

## 五、推荐适配方案总结

| Agent       | 推荐对接方式                          | 声明能力                                   | 备选（长期）    |
| ----------- | ------------------------------------- | ------------------------------------------ | --------------- |
| OpenCode    | `opencode run --format json`          | dispatchTask                               | HTTP API + SDK  |
| OpenClaw    | Gateway RPC `agent` + CLI `--deliver` | dispatchTask, pushMessage, userInteraction | Inbound Webhook |
| Claude Code | `claude -p --output-format json`      | dispatchTask                               | Agent SDK       |
| Codex       | `codex exec --json`                   | dispatchTask                               | TypeScript SDK  |

### 5.1 短期推荐（CLI 模式）

OpenCode、Claude Code、Codex 走 CLI 子进程模式派发任务：

- 简单、无需预启动服务
- 生命周期由 Harmonia 完全控制（`spawn → monitor → collect`）
- JSON 输出解析统一

OpenClaw 走 Gateway RPC `agent` 派发任务 + CLI `--deliver` 推送消息 + coordinator skill 回传。

### 5.2 长期演进（SDK/API 模式）

当 Harmonia 确定为常驻进程后，可考虑：

- OpenCode → HTTP API + `@opencode-ai/sdk`
- Codex → `@openai/codex-sdk`
- Claude Code → Agent SDK
- OpenClaw → Gateway WebSocket JSON-RPC

好处：更细粒度的控制、流式进度、会话复用。

## 六、统一适配器接口草案

基于能力声明模式，所有 agent 实现同一个 `AgentAdapter` 接口，通过 `capabilities` 声明自己支持哪些动作。引擎根据能力匹配选择 agent，而非根据 adapter 类型。

```typescript
// === 能力枚举 ===

type AgentCapability = 'dispatchTask' | 'pushMessage' | 'userInteraction';

// === 统一适配器接口 ===

interface AgentAdapter {
  readonly type: string; // "opencode" | "openclaw" | "claude-code" | "codex"
  readonly capabilities: readonly AgentCapability[];

  connect(config: AdapterConfig): Promise<void>;
  disconnect(): Promise<void>;

  /**
   * 派发任务给 agent，等待结果返回
   * 所有 agent 都应实现此方法
   * @requires capability "dispatchTask"
   */
  dispatchTask(task: TaskPayload): Promise<TaskResult>;

  /**
   * 推送消息给 agent（单向通知，不等回复）
   * 仅 capabilities 包含 "pushMessage" 的 agent 需要实现
   * 典型场景：通知 coordinator 向用户传达信息
   * @requires capability "pushMessage"
   */
  pushMessage?(message: MessagePayload): Promise<void>;

  /**
   * 查询任务执行状态（可选）
   */
  getTaskStatus?(taskId: string): Promise<TaskStatus>;

  /**
   * 取消正在执行的任务（可选）
   */
  cancelTask?(taskId: string): Promise<void>;
}

// === 数据结构 ===

interface TaskPayload {
  taskId: string; // Harmonia 分配的任务 ID
  description: string; // 任务描述（自然语言）
  context: Record<string, any>; // 工作流上下文（依赖的 artifact 等）
  constraints?: {
    maxTurns?: number; // 最大轮次（Claude Code 支持）
    maxBudgetUsd?: number; // 费用上限（Claude Code 支持）
    timeout?: number; // 超时毫秒数
    sandbox?: string; // 沙箱级别（Codex 支持）
    outputSchema?: object; // 输出 JSON Schema（Codex 支持）
  };
  sessionId?: string; // 续接已有会话（可选）
}

interface TaskResult {
  taskId: string;
  status: 'completed' | 'failed' | 'timeout' | 'cancelled';
  output: string; // agent 的输出内容
  artifacts?: Array<{
    // agent 产出的 artifact（由 Harmonia 解析后写入）
    id: string;
    content: string;
  }>;
  sessionId?: string; // agent 侧的 session ID（用于后续续接）
  metadata?: Record<string, any>; // 其他元数据
}

interface MessagePayload {
  sessionId: string; // 目标 agent 的 session ID
  content: string; // 消息内容
  type: 'info' | 'action_required' | 'approval_required';
  metadata?: Record<string, any>; // 附加数据（如需要审批的 artifact 内容）
}

// === 引擎侧的能力查询 ===

interface AdapterRegistry {
  /**
   * 根据所需能力查找可用的 agent 适配器
   * 返回所有满足能力要求的适配器列表
   */
  findByCapabilities(required: AgentCapability[]): AgentAdapter[];

  /**
   * 根据 agent 类型获取特定适配器
   */
  getByType(type: string): AgentAdapter | undefined;
}
```

**与旧版设计的关键区别**：

1. **不再有 ExecutorAdapter / CommunicatorAdapter 双分类**——统一为 `AgentAdapter`
2. **`pushMessage()` 是可选方法**——通过 `capabilities` 声明是否支持，而非用子类表达
3. **引擎通过 `findByCapabilities()` 选择 agent**——workflow 节点声明需要什么能力，引擎匹配
4. **OpenClaw 适配器同时实现 `dispatchTask()` 和 `pushMessage()`**——不需要两个适配器实例

## 七、待讨论的问题

1. **能力声明的粒度**：当前定义了 `dispatchTask`、`pushMessage`、`userInteraction` 三种。是否需要更细粒度（如 `sandbox`、`budgetControl`、`sessionResume`）？还是保持粗粒度，细节放在 `constraints` 里？
2. **CLI 子进程模式是否足够？** 还是应该从一开始就走 SDK/API？（004 已确认 Harmonia 需要是 HTTP 服务，这会影响适配器选型）
3. **TaskPayload 的 context 如何设计？** 传递完整 artifact 内容，还是只传引用？
4. **多 agent 同能力的选择策略**：如果 OpenCode、OpenClaw、Claude Code 都声明了 `dispatchTask`，workflow 节点如何指定用哪个？需要在节点定义中显式指定 `agent: "opencode"`？还是引擎做负载均衡？
5. **适配器注册机制**：适配器是硬编码在 core 里，还是像 workflow 一样插拔？
6. **错误处理和重试策略**：agent 执行失败后，Harmonia 如何处理？是否支持自动切换到另一个同能力的 agent？
7. **OpenClaw 作为执行者时的差异**：OpenClaw 通过 `agent` RPC 派发任务与其他三个 CLI 模式不同（RPC 是长连接请求-响应，CLI 是子进程生命周期管理），适配器实现差异是否需要在接口层体现？

## 八、与 001/002/004 的关系

### 001 中相关的待确定问题（本文档部分回答）

- ~~Agent 适配层的具体协议~~ → 短期 CLI，长期 SDK/API
- ~~如何处理不同 agent 的能力差异~~ → 能力声明模式，适配器声明 capabilities，引擎按需匹配

### 002 中相关的待确定问题（本文档部分回答）

- ~~OpenCode 的对接方式~~ → `opencode run --format json`
- ~~Agent 适配器接口~~ → 统一 `AgentAdapter` 接口 + 能力声明（取代旧的执行/通信双分类）
- ~~Coordinator 对接方式~~ → OpenClaw `agent --deliver` 推送 + coordinator skill 主动回调

### 004 中相关内容（本文档需对齐）

- 004 确认 Harmonia 需要是 HTTP 服务以支持 A2A → 长期适配器选型应优先 SDK/API 模式
- A2A Task 与 Harmonia workflow 执行实例的映射 → 适配器返回的 `TaskResult` 需能转换为 A2A Artifact
- A2A `input-required` 状态 → 对应 `pushMessage()` 的 `type: "action_required" | "approval_required"`

### 仍需后续文档讨论的

- Harmonia 的运行形态（影响适配器是走 CLI 还是 SDK）
- 工作流引擎主动驱动的 event loop（适配器在其中的调用时机）
- 现有代码的迁移策略
