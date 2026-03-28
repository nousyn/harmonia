# Harmonia 对外接口设计

> 创建时间: 2026-03-23
> 状态: 讨论确认

## 一、背景

前序文档确定了：

- 001：Harmonia 从 MCP Server 转为独立编排应用
- 002：Coordinator 只负责用户通信，Harmonia core 驱动流程
- 003：四个 agent 的对接方式（对内，适配器层）

本文档讨论 Harmonia 的**对外接口**——外部系统如何连接 Harmonia。

## 二、愿景驱动的决策

### 2.1 远期愿景

公司内部每个部门部署一个 Harmonia 实例，各自管理一个 agent 团队：

```
营销 Harmonia ←→ 技术 Harmonia ←→ 财务 Harmonia
     ↕                ↕                ↕
  agent 团队       agent 团队       agent 团队
```

关键特征：

- **网状拓扑**：部门间 Harmonia 可以直接通信（营销需要技术数据时直接请求）
- **总控层**：未来可能有一个总控应用连接所有部门
- **标准化**：各 Harmonia 实例之间需要统一的通信协议

### 2.2 为什么选 A2A 而不是自建 API

评估了两个选项：

| 维度       | 自建 API         | A2A 协议                        |
| ---------- | ---------------- | ------------------------------- |
| 部门间通信 | 需要自定义协议   | 标准协议，直接互通              |
| 能力发现   | 自己设计         | Agent Card 标准格式             |
| 总控对接   | 总控需要专门适配 | 总控用 A2A Client 即可          |
| 第三方接入 | 学你的私有 API   | 任何 A2A 兼容系统直接对接       |
| SDK 生态   | 自己写           | Python/JS/Go/Java/.NET SDK 已有 |
| 实现工作量 | 差不多           | 差不多（A2A SDK 可用）          |

**结论：Harmonia 对外暴露 A2A Server 接口。**

工作量与自建 API 相当，但标准化程度高得多，且天然支持远期愿景。

## 三、A2A 协议简介

A2A（Agent-to-Agent）是 Google 发起、Linux Foundation 托管的开放协议，v1.0.0 于 2026 年 3 月发布。

### 3.1 核心概念

| 概念           | 说明                                                                 | Harmonia 映射                  |
| -------------- | -------------------------------------------------------------------- | ------------------------------ |
| **Agent Card** | JSON 元数据，声明 agent 身份、能力、接口地址                         | Harmonia 实例的工作流能力声明  |
| **Task**       | 工作单元，有状态机 `submitted → working → completed/failed/canceled` | 一次工作流执行实例             |
| **Message**    | 通信轮次，分 user/agent 两种角色                                     | 外部系统与 Harmonia 的消息交换 |
| **Part**       | 消息内容最小单位（文本、文件、结构化 JSON）                          | 任务描述、artifact 内容        |
| **Artifact**   | agent 产出物                                                         | 工作流产出的 artifacts         |
| **Skill**      | agent 的能力描述                                                     | Harmonia 加载的各个 workflow   |

### 3.2 核心操作

| 操作                   | 说明                      | Harmonia 用途             |
| ---------------------- | ------------------------- | ------------------------- |
| `SendMessage`          | 发送消息，创建或推进 Task | 启动工作流 / 发送用户回复 |
| `SendStreamingMessage` | 流式消息，SSE 实时更新    | 实时跟踪工作流进度        |
| `GetTask`              | 查询 Task 状态            | 查询工作流执行状态        |
| `ListTasks`            | 列出 Task                 | 列出所有工作流实例        |
| `CancelTask`           | 取消 Task                 | 取消工作流执行            |
| `SubscribeToTask`      | 订阅 Task 更新            | 持续监听工作流进度        |

### 3.3 协议绑定

A2A 支持三种协议绑定，任选其一：

- **JSON-RPC 2.0 over HTTP(S)**——最简单，推荐起步用
- **gRPC**——高性能
- **HTTP+JSON/REST**——最易理解

### 3.4 发现机制

- **Well-Known URI**：`https://{domain}/.well-known/agent-card.json`
- **注册中心**：集中管理 Agent Card（A2A 未定义标准 API，需自建）
- **直接配置**：硬编码/配置文件

### 3.5 与 MCP/ACP 的关系

| 协议    | 解决什么问题       | 方向           |
| ------- | ------------------ | -------------- |
| **MCP** | Agent ↔ 工具       | agent 调用工具 |
| **ACP** | IDE/编辑器 ↔ Agent | IDE 调用 agent |
| **A2A** | Agent ↔ Agent      | agent 之间协作 |

三者互补，不冲突。Harmonia 的场景是"系统间协作"，A2A 最契合。

## 四、Harmonia 作为 A2A Server

### 4.1 架构位置

```
外部系统（总控 / 其他部门 Harmonia / 任何 A2A Client）
    │
    │  A2A 协议（JSON-RPC / gRPC / REST）
    ▼
┌─────────────────────────────────────┐
│  Harmonia A2A Server 层             │  ← 本文档讨论的范围
│  - Agent Card 发布                  │
│  - SendMessage → 启动/推进工作流     │
│  - Task 生命周期管理                 │
│  - Streaming / Push Notification    │
├─────────────────────────────────────┤
│  Harmonia Core：工作流引擎           │  ← 001/002 已讨论
├─────────────────────────────────────┤
│  Harmonia Agent 适配器层             │  ← 003 已讨论
│  - OpenCode / OpenClaw / ...        │
└─────────────────────────────────────┘
```

### 4.2 Agent Card 设计

每个 Harmonia 实例根据加载的 workflows 自动生成 Agent Card：

```json
{
  "name": "营销部门工作流引擎",
  "description": "负责营销策略制定、市场分析、营销活动策划的自动化工作流",
  "url": "https://marketing.internal.company.com/a2a",
  "version": "1.0.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": true
  },
  "skills": [
    {
      "id": "marketing-plan",
      "name": "营销计划制定",
      "description": "从需求分析到完整营销计划的全流程",
      "inputModes": ["text/plain", "application/json"],
      "outputModes": ["application/json"],
      "examples": ["制定下个月的社交媒体营销计划"]
    },
    {
      "id": "market-analysis",
      "name": "市场分析报告",
      "description": "针对指定市场的竞品分析和趋势报告",
      "inputModes": ["text/plain"],
      "outputModes": ["application/json"]
    }
  ]
}
```

关键设计点：

- **skills 来自 workflows 目录**：每个加载的 workflow 对应一个 skill
- **Agent Card 自动生成**：Harmonia 启动时扫描 workflows 目录，动态构建
- **Well-Known URI 发布**：`/.well-known/agent-card.json` 自动可访问

### 4.3 A2A 概念到 Harmonia 概念的映射

| A2A 概念            | Harmonia 概念                    | 说明                                                       |
| ------------------- | -------------------------------- | ---------------------------------------------------------- |
| Agent Card          | Harmonia 实例 + 加载的 workflows | 自动生成                                                   |
| Skill               | 单个 workflow 定义               | 一个 workflow = 一个 skill                                 |
| SendMessage（首次） | 启动指定 workflow                | 根据 skill id 匹配 workflow                                |
| SendMessage（后续） | 向运行中的 workflow 发送消息     | 用户回复、审批等                                           |
| Task                | workflow 执行实例                | 一次 workflow 运行                                         |
| TaskState           | workflow 整体进度                | submitted/working/input-required/completed/failed/canceled |
| Artifact            | workflow 产出的 artifacts        | PRD、架构文档、代码等                                      |
| Multi-turn          | 需要用户交互的节点               | 需求澄清、Gate 审批 → Task 进入 input-required             |
| Context             | 一组相关的 workflow 执行         | 可选，用于关联多个任务                                     |

### 4.4 关键交互流程

#### 4.4.1 启动工作流

```
Client                          Harmonia (A2A Server)
  │                                   │
  │  SendMessage({                    │
  │    message: {                     │
  │      role: "user",                │
  │      parts: [{ text: "制定下月营销计划" }]  │
  │    },                             │
  │    metadata: { skill: "marketing-plan" }   │
  │  })                               │
  │ ─────────────────────────────────> │
  │                                   │  匹配 workflow，创建执行实例
  │  Task {                           │
  │    id: "task-123",                │
  │    status: { state: "working" }   │
  │  }                                │
  │ <───────────────────────────────── │
```

#### 4.4.2 需要用户输入（Gate/审批）

```
Client                          Harmonia (A2A Server)
  │                                   │
  │  (通过 SSE 或 GetTask 发现)        │
  │  Task {                           │
  │    id: "task-123",                │
  │    status: {                      │
  │      state: "input-required",     │
  │      message: {                   │
  │        role: "agent",             │
  │        parts: [{ text: "PRD 已完成，请审批",  │
  │                  data: { artifact_id: "prd" } }]  │
  │      }                            │
  │    }                              │
  │  }                                │
  │ <───────────────────────────────── │
  │                                   │
  │  SendMessage({                    │
  │    message: {                     │
  │      role: "user",                │
  │      parts: [{ text: "approved" }]│
  │    },                             │
  │    taskId: "task-123"             │
  │  })                               │
  │ ─────────────────────────────────> │
  │                                   │  Gate 通过，继续执行
  │  Task {                           │
  │    status: { state: "working" }   │
  │  }                                │
  │ <───────────────────────────────── │
```

#### 4.4.3 工作流完成

```
Client                          Harmonia (A2A Server)
  │                                   │
  │  Task {                           │
  │    id: "task-123",                │
  │    status: { state: "completed" },│
  │    artifacts: [                   │
  │      { name: "PRD", parts: [...] },        │
  │      { name: "架构设计", parts: [...] },    │
  │      { name: "代码实现", parts: [...] }     │
  │    ]                              │
  │  }                                │
  │ <───────────────────────────────── │
```

#### 4.4.4 部门间协作（远期）

营销 Harmonia 执行到需要技术数据的节点：

```
营销 Harmonia                    技术 Harmonia
(A2A Client)                    (A2A Server)
  │                                   │
  │  1. 查询 Agent Card               │
  │  GET /.well-known/agent-card.json │
  │ ─────────────────────────────────> │
  │  Agent Card { skills: [...] }     │
  │ <───────────────────────────────── │
  │                                   │
  │  2. 发起任务                       │
  │  SendMessage({                    │
  │    message: { parts: [{ text: "提供最新技术趋势分析" }] },  │
  │    metadata: { skill: "tech-trend-report" }                │
  │  })                               │
  │ ─────────────────────────────────> │
  │                                   │
  │  3. 等待结果                       │
  │  Task { status: "completed",      │
  │         artifacts: [...] }        │
  │ <───────────────────────────────── │
  │                                   │
  │  4. 将结果注入自己的工作流继续执行   │
```

## 五、粒度决策

### 5.1 对外只暴露 workflow 级别

A2A Task 对应一次完整的 workflow 执行。内部的节点流转、Gate 阻塞、agent 调度对外不可见。

外部系统看到的状态变化：

```
submitted → working → input-required → working → completed
```

内部实际经历的：

```
需求澄清节点(active) → PRD撰写节点(active) → PRD审批Gate(blocked)
→ 架构设计节点(active) → 开发节点(active) → 测试节点(active) → completed
```

外部只在 Gate 需要用户输入时感知到 `input-required`，其余时间只看到 `working`。

### 5.2 理由

- **封装性**：Harmonia 内部实现对外不可见，符合 A2A 的 "opaque execution" 原则
- **简洁性**：外部系统不需要理解 Harmonia 的节点/Gate/artifact 概念
- **灵活性**：内部工作流可以随时重构，不影响外部接口

## 六、Coordinator 在 A2A 架构下的角色

### 6.1 两种入口并存

A2A Server 的引入不替代 Coordinator，而是增加一个入口：

```
入口 A：用户 → Coordinator（OpenClaw）→ Harmonia
入口 B：外部系统 → A2A Server → Harmonia
```

- **入口 A**：人类用户直接使用的场景（飞书对话、TUI）
- **入口 B**：系统间协作的场景（总控调度、部门间请求）

两个入口最终都进入同一个 Harmonia Core。

### 6.2 入口 B 的 Coordinator 问题

通过 A2A 进来的请求，如果工作流执行到需要"用户确认"的 Gate：

- **入口 A**：Coordinator 直接问用户
- **入口 B**：Harmonia 将 Task 状态设为 `input-required`，等外部系统回复 SendMessage

入口 B 不需要 Coordinator——外部系统（总控）自己决定怎么获取用户输入。

## 七、实施优先级

### 7.1 当前阶段不需要实现 A2A

当前重构的优先级：

1. 工作流引擎从被动变主动（event loop）
2. Agent 适配器层（对内）
3. Coordinator 对接验证

A2A Server 层是在以上基础之上的**薄壳**——引擎跑通后加上去很快。

### 7.2 架构上需要预留的

虽然不现在实现，但 core 设计时需要确保：

- **workflow 执行实例有唯一 ID**——对应 A2A Task ID
- **工作流状态可映射到 A2A TaskState**——submitted/working/input-required/completed/failed/canceled
- **artifacts 可序列化为 A2A Artifact 格式**——Parts（text/file/data）
- **支持外部触发的消息输入**——不仅 Coordinator 能发消息，A2A SendMessage 也能

这些在现有 types.ts 的设计中大部分已经具备。

## 八、与前序文档的关系

### 001 中相关的

- ~~Harmonia 作为独立应用的运行形态~~ → 需要是 HTTP 服务（A2A Server 要求）
- ~~用户交互界面~~ → 两个入口：Coordinator（人类用户）+ A2A（系统间）

### 002 中相关的

- Coordinator 定位不变——只负责用户通信
- 新增 A2A 入口作为系统间通信的标准接口
- ~~对外开放 API，不内置 MCP~~ → 对外开放 A2A 协议

### 003 中相关的

- Agent 适配器层（对内）的设计不受影响
- A2A 是对外接口，适配器是对内接口，两层独立

## 九、待后续讨论

1. **A2A 协议绑定选择**：JSON-RPC vs gRPC vs REST？（推荐 JSON-RPC，与 A2A 主推方向一致）
2. **认证方案**：公司内部系统间用什么认证？（mTLS / OAuth2 / API Key）
3. **Agent Card 的自动生成逻辑**：如何从 workflow.json 提取 skill 描述
4. **Harmonia 作为 A2A Client**：部门间协作时如何在工作流节点中定义"调用外部 Harmonia"
5. **注册中心**：各部门 Harmonia 如何互相发现（远期）
