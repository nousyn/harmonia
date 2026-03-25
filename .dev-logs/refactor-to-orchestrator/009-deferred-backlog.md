# 009 延迟事项与待实现计划

> 本文档记录 Harmonia 重构过程中搁置的功能、延迟的计划，以及相关设计讨论的结论，供后续开发参考。

---

## 一、System Prompt 注入问题

### 1.1 问题背景

Coordinator（如 dev workflow 中的 PM 角色）需要在 agent 的 system prompt 中维持角色身份，使其在所有用户交互中都保持角色定位，而不仅仅是在 dispatch 的任务中。这引出了"如何将 role prompt 注入 agent 的 system prompt"的问题。

### 1.2 Agent CLI System Prompt 支持调研

| Agent       | `--system-prompt` CLI 参数                                             | 通用方法                                           |
| ----------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| opencode    | **不支持**                                                             | `AGENTS.md` 文件 / config `instructions`           |
| claude code | **完全支持**（`--system-prompt`、`--append-system-prompt` 及文件变体） | `CLAUDE.md` / `.claude/rules/`                     |
| codex       | **不支持**（变通方案：`-c instructions="..."`）                        | `AGENTS.md` 文件 / `config.toml`                   |
| openclaw    | **不支持**                                                             | `AGENTS.md` 文件 / Gateway RPC `extraSystemPrompt` |

**关键发现**：只有 claude code 支持 CLI 系统提示参数。`AGENTS.md` 是跨 4 个 agent 唯一通用的方法，但各 agent 对其 scope（global / project）的支持程度不同。

### 1.3 设计讨论摘要

讨论过程中形成了以下设计方案（最终未实现，仅作记录）：

**a) `inject` 字段**

在 RoleFrontmatter 中增加 `inject` 字段控制注入模式：

```yaml
---
role: coordinator
agent: openclaw
inject: system # system | dispatch (默认: dispatch)
---
```

- `system`：写入 `AGENTS.md`，适用于常驻角色（如 coordinator）
- `dispatch`：通过 TaskPayload.prompt 注入，适用于任务驱动角色（默认）

**b) 基于 marker 的幂等写入机制**

```markdown
<!-- harmonia:coordinator:start -->

（coordinator prompt 内容）

<!-- harmonia:coordinator:end -->
```

- 文件不存在 → 创建文件，写入 marker block
- 文件存在，无 marker block → 追加 marker block
- 文件存在，marker block 存在 → 替换 block 内容（幂等）

**c) scope 字段**

- `global`：写入全局配置目录（如 `~/.config/opencode/AGENTS.md`）
- `project`：写入项目目录的 `AGENTS.md`

### 1.4 发现的核心问题

**问题 1：Project 级别多角色冲突**

当多个角色共享同一个 agent 时，project 级别的 `AGENTS.md` 会出现冲突。例如 developer 和 tester 都使用 opencode，它们的 system prompt 会被写入同一个 `AGENTS.md`，导致 agent 在执行 developer 任务时看到 tester 的指令，造成角色混淆。

**问题 2：openclaw 不支持 project 级别 system prompt**

openclaw 只有智能体级别的 workbench 区分，不支持 project 级别的 system prompt 文件。它需要通过 agentId 路由来指定目标智能体，这与其他 agent 的机制完全不同。

**问题 3：除 coordinator 外的角色不适合写入 system prompt**

Task-driven 角色（developer、tester 等）按需激活，不需要常驻 system prompt。同时注入多个角色 prompt 会导致角色混淆，实际上只有 coordinator 这类常驻角色有此需求。

### 1.5 结论

**暂不实现。** System prompt 注入机制复杂度较高，涉及多 agent 兼容性、角色冲突等问题，当前阶段搁置。

**当前措施**：由用户手动将角色 prompt（如 coordinator）复制到对应 agent 的 system prompt 配置文件中（如 `AGENTS.md`、`CLAUDE.md` 等）。

### 1.6 openclaw 的特殊性（后续关注）

openclaw 的多智能体架构要求 dispatch/pushMessage 时支持传入 agentId，指定使用 openclaw 中的哪个智能体。这一点在当前 adapter 接口中未体现，留作后续实现。

---

## 二、006 延迟计划汇总

以下内容来自 006-implementation-plan.md 中明确标记为延迟/远期的事项。

### 2.1 WebSocket 状态推送

- **来源**：006 Phase 3.5
- **状态**：推迟到 Phase 6
- **说明**：当前阶段非必需。Coordinator 通过 HTTP API 操作，Harmonia 通过适配器 pushMessage 主动通知 Coordinator，不依赖 WebSocket。WebSocket 的核心价值是给 Web UI 做实时状态推送，与 Web UI 一起实现更合理。

### 2.2 Phase 6: A2A + Web UI

整体标记为"远期，不在本次重构范围"。

**6.1 A2A JSON-RPC 端点**

- 在 HTTP 层新增 `/a2a/*` 路由
- 实现 A2A 标准方法（`SendMessage`、`GetTask` 等）
- JSON-RPC 2.0 over HTTPS

**6.2 Agent Card 生成**

- 从 workflow 定义自动生成 A2A Agent Card

**6.3 Harmonia 作为 A2A Client**

- 部门间协作场景
- workflow 节点中定义"调用外部 Harmonia 实例"

**6.4 Web UI**

- React/Vue 管理控制台
- 消费 HTTP API + WebSocket
- 功能：全局概览、历史记录可视化、状态监控
- 是否支持审批操作待讨论

### 2.3 真实 Agent E2E 验证

- **来源**：006 Phase 5 执行记录
- **状态**：延迟
- **说明**：需要真实 agent CLI 环境的端到端测试。当前 E2E smoke tests（6 个）标记为 skipped，需要配置真实 agent 环境后运行。

### 2.4 Override 系统评估

- **来源**：006 Phase 5
- **状态**：待定
- **说明**：如果 override 系统整体需要重做，记录为后续任务。当前 `OverrideToolType = 'skill' | 'mcp'` 已评估并保留。

### 2.5 Coordinator 可选化 + 消息回复路由

- **状态**：待实现
- **背景**：重构为 orchestrator 架构后，coordinator 的职责从"流程驱动者"变为"用户通信桥梁"。工作流推进完全由 Orchestrator 驱动，coordinator 是否在线不影响执行。因此 coordinator 不应再是工作流定义的强制字段。

#### 2.5.1 Coordinator 可选化

将 `WorkflowDefinition.coordinator` 从必填改为可选，涉及 3 处修改：

1. `src/core/types.ts` — `coordinator: string` → `coordinator?: string`
2. `src/core/workflow-validator.ts` — 校验改为仅在 coordinator 存在时才检查角色引用
3. `src/core/plugin.ts` — 加载时处理 `undefined` 值

`orchestrator.ts` 和 `routes.ts` 已天然兼容 coordinator 缺失（`notifyCoordinator()` 在 coordinator 未连接时静默返回）。

#### 2.5.2 消息回复路由设计

当前 `notifyCoordinator()` 是广播式设计（固定找 coordinator 角色推送），但实际存在多种消息来源场景，需要更精细的回复路由机制。

**场景分析：**

| 场景                             | 来源           | 问题                                                    |
| -------------------------------- | -------------- | ------------------------------------------------------- |
| coordinator agent 发消息触发操作 | 已连接的 agent | 结果应回复给发起操作的 agent，不一定是 coordinator 角色 |
| 外部系统通过 API 触发工作流      | HTTP 请求      | 调用者不是 agent，无 adapter，无法 pushMessage          |
| 多个 coordinator 同时在线        | 多项目并发     | 需按项目/请求维度区分通知目标                           |

**设计方向：引入 `replyTo` 概念**

```
请求来源 → Harmonia → 处理 → 通过 replyTo 回复
```

`replyTo` 可以是：

- **已连接 agent 的 key** — 通过 `adapter.pushMessage` 回复
- **HTTP 回调 URL（webhook）** — 外部系统场景
- **无** — fire-and-forget，不需要通知

具体设计点：

1. **API 请求层面**：HTTP 请求可携带 `replyTo` 信息，标识结果回复目标
2. **连接层面**：agent 通过 `/connect` 注册后有连接 ID + adapter，后续该 agent 发起的请求，Harmonia 知道回复给这个连接
3. **项目层面**：项目级通知订阅列表，多个 agent 或外部系统可订阅某项目的事件

---

## 三、优先级建议

| 优先级 | 事项                      | 理由                               |
| ------ | ------------------------- | ---------------------------------- |
| **高** | Coordinator 可选化        | 消除不必要的工作流约束，改动量小   |
| **高** | openclaw agentId 路由支持 | 直接影响 openclaw adapter 的可用性 |
| **高** | 真实 Agent E2E 验证       | 验证整个系统的端到端功能           |
| **中** | 消息回复路由（replyTo）   | 多来源场景的基础设施               |
| **中** | System Prompt 自动注入    | 提升用户体验，但当前可手动替代     |
| **中** | WebSocket 状态推送        | Web UI 的前置依赖                  |
| **低** | A2A 协议支持（6.1-6.3）   | 远期目标，依赖生态成熟度           |
| **低** | Web UI（6.4）             | 依赖 WebSocket + A2A               |
| **低** | Override 系统重做         | 当前系统可用，视需求决定           |
