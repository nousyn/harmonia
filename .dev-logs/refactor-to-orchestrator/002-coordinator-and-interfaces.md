# Coordinator 定位与对外接口设计

> 创建时间: 2026-03-23
> 状态: 已确认（核心结论），部分细节待实施验证

## 一、背景

001 确定了 Harmonia 从 MCP Server 转为独立编排应用的方向。本次讨论聚焦于：

- 重构后 coordinator 的角色定位
- Harmonia 如何与外部 agent 交互（入站 + 出站）
- 对外接口的形态

## 二、Coordinator 的重新定位

### 2.1 原有定位（MCP 架构下）

Coordinator 承担两个职责：

1. **流程推进**：调用 MCP 工具驱动状态机前进
2. **用户交互**：需求澄清、方案确认、审批、进度汇报

这两个职责耦合在一个 LLM agent 里，导致不可控。

### 2.2 新定位（独立编排架构下）

**流程推进由 Harmonia core 自己完成**，coordinator 只保留用户交互职责。

Coordinator 的新定义：**Harmonia 和用户之间的通信桥梁**。

- 不做流程决策
- 不调度其他 agent
- 不推进状态机
- 只负责：传达用户意图给 Harmonia、传达 Harmonia 的信息给用户

### 2.3 Coordinator 的运行环境

Coordinator 运行在 OpenClaw 上，用户通过任意 channel（飞书、Slack、TUI 等）与之交互。

关键认识：**Coordinator 不是被 Harmonia 调度起来的**。用户发起对话时，coordinator 已经在 OpenClaw 中运行了。它是主动来连接 Harmonia 的，不是被 Harmonia 拉起的。

## 三、Harmonia 与 Agent 的两种交互模式

### 3.1 任务派发（调度执行 agent）

场景：Harmonia 调度 OpenCode 写代码、调度其他 agent 执行任务。

特征：

- Harmonia 主动拉起 agent
- 发送任务 + 上下文
- 等待结果返回
- 生命周期由 Harmonia 控制

### 3.2 消息推送（通知 coordinator）

场景：流程执行中需要用户确认，Harmonia 通知 coordinator 去和用户沟通。

特征：

- 单向推送，不等回复
- Coordinator 收到后自己决定怎么和用户沟通
- 用户的回答由 coordinator 通过 Harmonia 的 API 回传（coordinator 主动调用，不是 Harmonia 等待）

### 3.3 两种模式的统一

两种模式都通过 **agent 适配器**实现。适配器是 Harmonia core 的一部分，封装了对接不同 agent 的具体方式。

## 四、对外接口设计

### 4.1 核心决策：Harmonia 开放接口，不做协议适配

~~之前考虑过 MCP 外置接口~~ → **已否决**。

Harmonia 只开放通用接口（API/SDK），不绑定任何协议。如果某个 agent 需要对接 Harmonia，**由 agent 侧自己实现 skill/plugin 来适配**。

类比：

- Harmonia 的 workflows 是插拔式的 → 工作流定义由 workflows/ 目录提供
- Harmonia 的对外接口也是开放式的 → 对接方式由 agent 侧的 skill 实现

### 4.2 Connect 机制

外部 agent 通过 `connect` 接口注册到 Harmonia：

```
connect({
  agent: "openclaw",        // agent 类型，用于选择适配器
  sessionId: "xxx",         // agent 侧的 session 标识
  ...其他适配器所需参数
})
```

Harmonia 记录这个连接信息。后续需要推送消息时，根据 agent 类型选择对应的适配器推送。

### 4.3 信息流总结

```
入站（agent → Harmonia）：
  Agent 侧的 skill 调用 Harmonia API
  例：OpenClaw skill 调用 harmonia.submitRequirement(...)
  例：OpenClaw skill 调用 harmonia.approveArtifact(...)

出站（Harmonia → agent）：
  Harmonia 通过适配器推送
  例：需要用户确认时，通过 openclaw 适配器推送消息给 coordinator
  具体实现：openclaw agent --session-id <id> --message "..." --deliver
```

### 4.4 实际场景走查

以"需求澄清 → 写 PRD → 审批 → 写用户故事"为例：

```
1. 用户在飞书对 OpenClaw 说"我要做一个新功能"
2. OpenClaw coordinator 通过 skill 调用 harmonia.connect(...) 注册自己
3. OpenClaw coordinator 通过 skill 调用 harmonia.startWorkflow(...)
4. Harmonia 推进到"需求澄清"节点
   → 通过 openclaw 适配器推送消息给 coordinator："请和用户澄清需求"
5. Coordinator 在飞书和用户聊，澄清需求
6. Coordinator 通过 skill 调用 harmonia.completeNode({ result: ... })
7. Harmonia 推进到"写 PRD"节点
   → 通过 openclaw 适配器推送消息给 coordinator："请撰写 PRD，schema 如下..."
8. Coordinator 写完 PRD
   → 通过 skill 调用 harmonia.writeArtifact({ id: "prd", content: ... })
9. Harmonia 进入 Gate（PRD 审批）
   → 通过 openclaw 适配器推送消息给 coordinator："PRD 已提交，请让用户审批"
10. Coordinator 把 PRD 展示给用户，用户说 OK
    → 通过 skill 调用 harmonia.approveArtifact({ id: "prd" })
11. Harmonia Gate 通过，推进到"写用户故事"
    → 通过 openclaw 适配器推送消息给 coordinator："请撰写用户故事..."
12. ...
```

中间如果 OpenCode 在架构设计时发现问题需要确认：

```
- Harmonia 调度 OpenCode 做架构设计（通过 opencode 适配器）
- OpenCode 返回结果，标记有待确认问题
- Harmonia 通过 openclaw 适配器推送消息给 coordinator：
  "架构师发现以下问题需要确认：..."
- Coordinator 在飞书问用户
- 用户回答后，coordinator 通过 skill 调用 harmonia API 回传结果
- Harmonia 继续推进
```

## 五、OpenClaw 适配器的具体实现

当前确定使用 `openclaw agent` CLI 命令作为推送手段：

```bash
openclaw agent --session-id <coordinator-session> --message "..." --deliver
```

**已知体验问题**：此命令会在用户的消息列表中出现一条像用户自己发的消息。这是 OpenClaw 侧的局限，不影响功能。后续可以推动 OpenClaw 增加更干净的系统消息注入接口。

## 六、与 001 的关系

### 001 中已确认且不变的

- Harmonia 从 MCP Server 转为独立编排应用
- core + 插拔式 workflows 架构方向
- 工作流引擎从被动变主动
- 指挥官模式（Harmonia 调度，agent 执行）
- Agent 通信层最后实现

### 001 中需要更新的

- ~~四层架构图~~ → 简化为：core（引擎 + 调度）+ 适配器 + workflows
- ~~"Agent 适配层"作为独立第四层~~ → 适配器是 core 的一部分
- ~~MCP 外置接口~~ → 已否决，改为 Harmonia 开放 API，agent 侧自行实现 skill 对接
- ~~OpenClaw 的定位~~ → 不是单纯的"被调度执行者"，而是通过 coordinator 角色承担用户通信桥梁的职责

## 七、仍待讨论的问题

1. **Harmonia 的运行形态**：CLI？常驻进程？
2. **Harmonia API 的具体设计**：connect / startWorkflow / completeNode / writeArtifact / approveArtifact 等接口的参数和行为
3. **Agent 适配器接口**：统一的适配器接口定义（派发任务 vs 推送消息）
4. **OpenCode 的对接方式**：启动方式、任务传递、结果收取
5. **工作流引擎主动驱动的具体实现**：event loop 设计
6. **现有代码的迁移策略**：哪些保留、哪些重写
