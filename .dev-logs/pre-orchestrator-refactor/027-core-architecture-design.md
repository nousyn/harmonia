# 027 — Core 架构设计

> 状态：设计确认
> 日期：2026-03-18

## 背景

Harmonia 从一个硬编码的开发流程引擎重构为**通用多智能体协作框架**。架构分为两大块：Core（核心引擎）+ Workflows（可插拔工作流插件）。

本文档记录 Core 的完整设计决策。

## 核心理念

**Core 提供可组合的协作原语。Workflow plugin 使用这些原语定义具体流程。**

---

## 一、节点类型（4 种）

工作流由树状结构定义，支持 4 种节点类型：

| 类型         | 语义     | 说明                              |
| ------------ | -------- | --------------------------------- |
| **task**     | 工作单元 | 分配给角色执行                    |
| **sequence** | 顺序执行 | 子节点按顺序执行                  |
| **parallel** | 并行执行 | 子节点同时执行，failStrategy 必填 |
| **gate**     | 条件检查 | 根据条件走 pass/fail 两条路径     |

### 节点标识

- 统一用 `id` 字段，全局唯一，由工作流定义者自定义
- 用于状态追踪、日志、goto 引用

### 示例结构

```json
{
  "root": {
    "type": "sequence",
    "id": "main",
    "children": [
      { "type": "task", "id": "clarify", "role": "pm" },
      {
        "type": "parallel",
        "id": "design-tasks",
        "failStrategy": "wait-all",
        "children": [
          { "type": "task", "id": "data-model", "role": "architect" },
          { "type": "task", "id": "api-design", "role": "architect" }
        ]
      },
      {
        "type": "gate",
        "id": "design-review",
        "conditions": [{ "type": "artifact_approved", "artifact": "tech-design" }],
        "pass": { "type": "task", "id": "develop", "role": "developer" },
        "fail": {
          "goto": "data-model",
          "maxRetries": 3,
          "onExhausted": "escalate"
        }
      }
    ]
  }
}
```

---

## 二、Gate 机制

### 条件类型（3 种）

| 条件类型            | 说明                       | 示例                                                                                                            |
| ------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `artifact_exists`   | 检查 artifact 是否已写入   | `{ "type": "artifact_exists", "artifact": "tech-design" }`                                                      |
| `artifact_approved` | 检查 artifact 是否通过审批 | `{ "type": "artifact_approved", "artifact": "prd" }`                                                            |
| `artifact_field`    | 检查 artifact 中某字段的值 | `{ "type": "artifact_field", "artifact": "test-report", "field": "result", "operator": "eq", "value": "pass" }` |

`artifact_field` 支持的 operator：`eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `contains`, `in`

### 评估方式

- **Core 自动评估**，不依赖 manager agent 判断
- 每次 artifact 写入、artifact 审批、task 完成时触发相关 gate 的条件检查

### Fail 路径

两种模式：

**模式 1：内联新分支**

```json
{
  "type": "gate",
  "conditions": [...],
  "pass": { "type": "task", "id": "deliver" },
  "fail": { "type": "task", "id": "escalate", "role": "pm" }
}
```

**模式 2：goto 跳回**

```json
{
  "type": "gate",
  "conditions": [...],
  "pass": { "type": "task", "id": "deliver" },
  "fail": {
    "goto": "write-design",
    "maxRetries": 3,
    "onExhausted": "escalate-node"
  }
}
```

### Goto 约束规则

- 目标必须是当前 gate 的**祖先节点**，或祖先所在 sequence 中**排在祖先前面的兄弟节点**
- 简言之：只能跳回执行顺序上在自己之前的、可达的节点
- 不能跳进别的并行分支内部

### Goto 状态处理

- 跳回时：目标节点及其后续节点状态重置为 pending
- **Artifact 处理由工作流定义**，Core 不决定是删除还是保留
- Gate 的判断结果（conditions 评估详情）**传递给跳回的目标节点**，作为上下文

---

## 三、游离节点

- 不在工作流树上的独立节点
- 只能被 `onExhausted` 或 `onFailed` 引用
- **单个节点，不支持嵌套**
- 跨工作流跳转能力留后续迭代

```json
{
  "floatingNodes": [{ "type": "task", "id": "escalate", "role": "pm" }]
}
```

---

## 四、通用失败处理（onFailed）

| 节点类型     | 失败处理方式              |
| ------------ | ------------------------- |
| **task**     | 可选 `onFailed`           |
| **parallel** | 可选 `onFailed`           |
| **sequence** | 不需要 — 失败冒泡给父节点 |
| **gate**     | 已有自己的 fail 机制      |

### onFailed 配置

```json
{
  "onFailed": {
    "goto": "some-node",
    "maxRetries": 3,
    "onExhausted": "escalate-node"
  }
}
```

- `goto`：跳回重试，受祖先链约束；task 额外允许 goto 自己（自重试）
- `maxRetries`：选填，默认 3
- `onExhausted`：引用游离节点 id

---

## 五、Parallel 节点

- `failStrategy` 必填：
  - `fail-fast`：一个子节点失败，立即标记 parallel 为 failed，其他子节点取消
  - `wait-all`：等所有子节点完成（成功或失败），然后汇总结果
- 可选 `onFailed`

---

## 六、Task 节点

- `role`：执行角色
- `timeout`：可选，秒，超时后标记为 failed
- `onFailed`：可选失败处理

---

## 七、Role 系统

| 职责                                           | 归属                 |
| ---------------------------------------------- | -------------------- |
| 角色内容（prompt、能力、身份）                 | Workflow plugin 定义 |
| 角色管理（注册、dispatch、session 追踪、验证） | Core                 |

- Core 维护 **role registry**，由 workflow plugin 填充
- Dispatch/session 工具基于 registry 做验证
- "PM" 重命名为更通用的名称（如 "manager" 或 "leader"）

---

## 八、Artifact 系统

- 原 "doc" 重命名为 **"artifact"**，更通用（代码、文档、数据都是 artifact）
- Core 提供通用的读写/审批机制
- Schema 由 workflow plugin 定义

---

## 九、工作流验证

加载工作流定义时做完整的静态分析：

- id 全局唯一性检查
- goto 目标合法性检查（是否存在、是否满足祖先链约束）
- 环检测
- failStrategy 必填检查（parallel 节点）
- 游离节点引用检查
- 角色引用检查（是否在 role registry 中）

非法定义直接拒绝加载。

---

## 十、Plugin 接口

- Workflow plugin 提供：
  - 节点树定义（工作流结构）
  - 角色定义（prompt、能力）
  - Artifact schema
  - Manager prompt
  - 可选的工作流特定工具
- Core 暴露通用工具：dispatch、artifact、status 等
- 工作流特定工具（如原 phase_update、set_scale）由 plugin 注册

---

## 十一、移除项

- **Scale 系统完全移除**

---

## 待定（后续迭代）

- 游离节点跨工作流跳转
- 更多 gate 条件类型（按需扩展）

---

## 十二、Workflow Plugin 机制

### 集成方式：混合模式

声明式内容放目录结构，自定义工具通过 TS 模块注册。

### Plugin 目录结构

```
workflows/<workflow-name>/
├── workflow.json          # 工作流树定义 + 游离节点
├── roles/                 # 角色 prompt（.md 文件）
│   ├── architect.md
│   ├── developer.md
│   └── coordinator.md     # coordinator prompt
├── schemas/               # artifact schema（.json 文件）
│   ├── prd.json
│   ├── tech-design.json
│   └── test-report.json
└── tools.ts               # 可选，导出注册函数，注册工作流特定工具
```

### Core 加载流程

1. 读 `workflow.json` → 解析节点树 + 游离节点 → 静态验证
2. 扫描 `roles/` → 注册到 role registry
3. 扫描 `schemas/` → 注册到 artifact schema registry
4. 如果存在 `tools.ts` → 动态 import，调用导出的注册函数

### Plugin 发现机制

配置文件中注册多个可用的 workflow plugin：

```json
{
  "workflows": {
    "dev": { "path": "./workflows/dev" },
    "devops": { "path": "./workflows/devops" },
    "custom": { "path": "/absolute/path/to/custom-workflow" }
  }
}
```

创建项目时选择一个：`project_init(project_name, project_dir, workflow="dev")`

### 多工作流支持

- 当前版本：注册多个 workflow，项目创建时选择一个
- 后续迭代：游离节点跨工作流跳转 → 一个项目多工作流

### Coordinator 角色

- Core 层面的概念：每个工作流必须有一个 coordinator
- coordinator 是与用户直接对话的角色，负责驱动工作流推进
- Core 知道谁是 coordinator（用于用户交互路由等）
- coordinator 的 prompt 和具体能力由 workflow plugin 定义

### 自定义工具接口

Plugin 的 `tools.ts` 导出一个注册函数，接收 Core 提供的 tool registry：

```typescript
// workflows/dev/tools.ts
import type { ToolRegistry } from 'harmonia/core';

export function registerTools(registry: ToolRegistry) {
  registry.register({
    name: 'phase_update',
    description: '...',
    inputSchema: { ... },
    handler: async (params) => { ... }
  });
}
```

---

## 十三、核心定位修正

### Core 是"流程顾问"，不是"自动执行引擎"

Core 是 MCP server，本质上是被动的。不能主动推进流程、不能主动通知协调者。

**真实流转模式**：

1. 协调者调用工具（dispatch、dispatch_report、artifact_write 等）
2. Core 在处理调用时，同步评估当前流程状态（节点状态、gate 条件等）
3. Core 在返回值中附带 `nextAction` — 告诉协调者下一步该做什么

**协调者是执行驱动方，Core 是决策计算方。**

### nextAction 返回结构

每个 Core 工具的返回值都包含统一的 nextAction 字段：

```typescript
{
  data: { ... },  // 工具本身的返回数据

  nextAction: {
    type: "dispatch" | "write_artifact" | "approve_artifact" | "wait" | "completed",
    nodeId: string,
    role: string,

    // 给协调者的操作指引
    instructions: string,

    // 给组员的完整 prompt（Core 组装好的）
    // 包含：角色 prompt + inject 内容 + gate 结果 + 任务上下文
    rolePrompt: string,

    // 组员需要参考的输入 artifact
    inputArtifacts: string[],

    // gate 评估结果（如果从 gate fail 跳回）
    gateResults?: GateEvaluationResult
  }
}
```

Core 组装 rolePrompt 时，将以下内容合并：

- Plugin 定义的角色 prompt（roles/architect.md）
- 节点钩子中的 inject 内容
- Gate 评估结果
- 任务上下文（输入 artifact 等）
- 完成后的操作指引（告诉组员完成后该调用什么工具）

### MCP 架构的本质限制

涉及 agent（协调者/组员）的行为，只能通过 prompt 引导，无法主动控制。这是硬伤，设计上必须接受。

---

## 十四、节点钩子

### 两个钩子时机

| 钩子               | 触发时机                          | 说明                                                                      |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------- |
| **beforeDispatch** | Core 组装 rolePrompt 时           | inject 合并到组员 prompt，actions 同步执行并将结果合并到上下文            |
| **afterComplete**  | Core 收到完成报告、计算下一步之前 | inject 附带在返回给协调者的指引中，actions 同步执行并将结果附带在返回值中 |

### 统一配置接口

```json
{
  "type": "task",
  "id": "write-design",
  "role": "architect",
  "beforeDispatch": {
    "inject": ["请特别注意安全性设计", "上次评审意见：{gate.results}"],
    "actions": ["collect-review-comments"]
  },
  "afterComplete": {
    "inject": ["请确认产出是否完整"],
    "actions": ["notify-reviewer"]
  }
}
```

### Actions 执行方式

- Actions 由 **Core 同步执行**（在处理工具调用的过程中）
- Actions 在 plugin 的 `tools.ts` 中注册
- Actions 可以做：数据操作（读 artifact、查状态）、外部 API 调用（发邮件、通知）
- Actions **不能做**：要求 agent 执行某个行为（这只能通过 inject prompt 引导）

---

## 十五、设计修正汇总

| 原设计                                | 修正后                                            |
| ------------------------------------- | ------------------------------------------------- |
| Core 自动评估 gate 条件               | Core 在被调用时同步评估，结果附带在返回值中       |
| Core 主动推进节点                     | 协调者每次报告后，Core 计算下一步并返回指引       |
| beforeDispatch 是 Core 主动执行的钩子 | Core 组装 rolePrompt 时合并 inject 和 action 结果 |
| afterComplete 是 Core 主动执行的钩子  | Core 处理完成报告时合并 inject 和 action 结果     |
| maxRetries 默认 3                     | maxRetries 可选，不填 = 无限重试                  |
| 自定义工具是给协调者用的 MCP 工具     | 自定义工具是节点钩子中的 action，Core 同步执行    |

---

## 十六、Hook 系统（边界守卫 & 提醒）

### 拆分方式

与 Role、Artifact 一致：**Core 提供机制，Plugin 提供内容**。

### Core 提供

- Hook 注册表
- Hook 生成器（为不同 agent 平台生成 hook 代码）
- Hook 安装器（调用 agent-kit 写入配置）
- 通用提醒检查逻辑（dispatch 超时、审核待处理等）

### Plugin 提供

在 plugin 目录中增加 `hooks.json`：

```json
{
  "guard": {
    "blockedTools": ["Write", "Edit", "Bash", "Terminal"],
    "blockedCommands": ["npm run", "npm test", "node ", "python "],
    "blockedExtensions": [".ts", ".js", ".py", ".rs"]
  },
  "reminders": {
    "dispatchTimeout": 30,
    "reviewPendingTimeout": 10,
    "custom": [
      {
        "id": "phase-idle",
        "check": "stateField",
        "field": "updatedAt",
        "thresholdMinutes": 15,
        "message": "当前阶段已空闲超过 {threshold} 分钟"
      }
    ]
  }
}
```

Plugin 只声明规则，不写平台特定代码。Core 的 hook 生成器根据规则为各平台生成对应的 hook 代码。

---

## 十七、Hook 系统完整设计

### 生成时机

Hook 不在 setup 时生成，而是在 **project_init（选择工作流）时生成并安装**。

### 作用范围

**Hook 只对协调者生效**。组员不需要边界守卫（developer 恰恰需要写代码），也不需要提醒。

### 多项目合并规则

多个项目使用不同工作流时，hook 规则**累积合并**：

| 规则类型          | 合并方式           |
| ----------------- | ------------------ |
| blockedTools      | 取并集             |
| blockedCommands   | 取并集             |
| blockedExtensions | 取并集             |
| reminders         | 全部保留，独立检查 |

每次 project_init 或工作流变更时，Core 重新计算合并结果，重新生成 + 安装 hook。

### 各平台能力差异

| 能力           | Claude Code |        OpenCode        | OpenClaw |
| -------------- | :---------: | :--------------------: | :------: |
| 工具拦截       |   硬拦截    |   软拦截（参数替换）   |  硬拦截  |
| 命令拦截       |   硬拦截    | 软拦截（替换为 echo）  |  硬拦截  |
| 文件扩展名拦截 |   硬拦截    | 软拦截（写入警告文本） |  硬拦截  |
| 提醒注入       |    支持     |          支持          |   支持   |

OpenCode 的软拦截是平台限制，非 Harmonia 设计问题。合并规则的实现方式三个平台一致，拦截效果因平台而异。

### Plugin 配置

Plugin 目录中的 `hooks.json`：

```json
{
  "guard": {
    "blockedTools": ["Write", "Edit", "Bash", "Terminal"],
    "blockedCommands": ["npm run", "npm test", "node ", "python "],
    "blockedExtensions": [".ts", ".js", ".py", ".rs"]
  },
  "reminders": {
    "dispatchTimeout": 30,
    "reviewPendingTimeout": 10,
    "custom": [
      {
        "id": "phase-idle",
        "check": "stateField",
        "field": "updatedAt",
        "thresholdMinutes": 15,
        "message": "当前阶段已空闲超过 {threshold} 分钟"
      }
    ]
  }
}
```

### 完整流程

```
project_init(project_name, project_dir, workflow="dev")
  → Core 加载 workflows/dev/hooks.json
  → 合并所有已注册工作流的 hook 规则
  → hook 生成器根据合并规则 + 当前 agent 平台生成 hook 代码
  → 调用 agent-kit 安装到协调者的 agent 平台
```

### 更新的 Plugin 目录结构

```
workflows/<workflow-name>/
├── workflow.json          # 工作流树定义 + 游离节点
├── roles/                 # 角色 prompt（.md 文件）
│   ├── architect.md
│   ├── developer.md
│   └── coordinator.md     # coordinator prompt
├── schemas/               # artifact schema（.json 文件）
│   ├── prd.json
│   ├── tech-design.json
│   └── test-report.json
├── hooks.json             # hook 规则（边界守卫 + 提醒）
└── tools.ts               # 可选，注册节点钩子中的 action
```

---

## 十七（修订）、Hook 系统完整设计

### 核心原则

**Hook 完全外置：Plugin 提供 hook 内容，Core 只负责传递和安装。**

Core 不理解 hook 内容（不知道什么是"边界守卫"、"提醒"），只负责：

1. 加载 plugin 的 hooks.ts
2. 传递 context（含 defineHooks 等 agent-kit API）
3. 收集各 plugin 返回的 HookSet
4. 合并后调用 agent-kit 安装

### 生成时机

**project_init（选择工作流）时生成并安装。**

### 作用范围

**Hook 只对协调者生效。**

### Plugin 接口

```typescript
// workflows/dev/hooks.ts
export function createHooks(agentType, context) {
  const { defineHooks, dataDir, projectName } = context;

  switch (agentType) {
    case 'claude-code':
      return defineHooks('claude-code', [
        { events: ['PreToolUse'], content: `...拦截脚本...` },
        { events: ['UserPromptSubmit'], content: `...提醒脚本...` }
      ]);
    case 'opencode':
      return defineHooks('opencode', { ... });
    case 'openclaw':
      return defineHooks('openclaw', { ... });
  }
}
```

### Core 调用流程

```typescript
// project_init 时
const pluginHooks = await import('workflows/dev/hooks.ts');
const hookSets = pluginHooks.createHooks(agentType, {
  defineHooks, // 从 Core 的 agent-kit 依赖传递
  dataDir,
  projectName,
});
await kit.installHooks(agentType, hookSets);
```

### 多项目合并

多个 plugin 各自返回 HookSet，Core 合并成一个数组传给 installHooks。

### Plugin 目录结构（最终版）

```
workflows/<workflow-name>/
├── workflow.json          # 工作流树定义 + 游离节点
├── roles/                 # 角色 prompt（.md 文件）
│   ├── architect.md
│   ├── developer.md
│   └── coordinator.md     # coordinator prompt
├── schemas/               # artifact schema（.json 文件）
│   ├── prd.json
│   ├── tech-design.json
│   └── test-report.json
├── hooks.ts               # 导出 createHooks，定义 agent 平台 hook
└── tools.ts               # 可选，导出 registerActions，注册节点钩子 action
```

hooks.ts 和 tools.ts 保持分开：

- hooks.ts — 安装时执行（project_init）
- tools.ts — 运行时执行（节点钩子 action）

---

## 十八、Action Context 设计

### Plugin 注册 Action

```typescript
// workflows/dev/tools.ts
export function registerActions(registry, context) {
  const { pluginConfig } = context;

  registry.register('collect-review-comments', async (ctx) => {
    const review = await ctx.artifacts.read('tech-design-review');
    return {
      inject: [`上次评审意见：${review.comments}`],
    };
  });
}
```

### Core 传给 registerActions 的 context

```typescript
{
  pluginConfig: any,       // 配置文件中 plugin 的自定义配置，透传
  dataDir: string,         // Harmonia 数据目录
  projectName: string,     // 当前项目名
}
```

### Core 传给 action handler 的 ActionContext

```typescript
interface ActionContext {
  // 节点信息
  nodeId: string; // 当前节点 id
  role: string; // 当前节点的角色
  retryCount: number; // 当前重试次数（0 = 首次执行）

  // 项目信息
  projectName: string;
  pluginConfig: any; // plugin 自定义配置

  // 流程状态
  gateResults?: GateEvaluationResult; // 上一个 gate 的评估结果（goto 跳回时）
  workflowState: WorkflowState; // 当前工作流完整状态

  // API
  artifacts: {
    read: (artifactId: string) => Promise<any>;
    list: () => Promise<string[]>;
  };

  // afterComplete 时额外提供
  taskResult?: any; // 组员完成任务的产出信息
}
```

### Action Handler 返回值

```typescript
interface ActionResult {
  inject?: string[]; // 动态生成的提示词，合并到 rolePrompt 或协调者指引中
  data?: any; // 附加数据，传递给后续流程
}
```

### 扩展性

ActionContext 是对象结构，后续可以随时添加新字段而不破坏现有 action handler。

### Plugin 配置透传

配置文件中可以为每个 workflow plugin 指定自定义配置：

```json
{
  "workflows": {
    "dev": {
      "path": "./workflows/dev",
      "config": {
        "dispatchTimeout": 60,
        "blockedExtensions": [".ts", ".js"]
      }
    }
  }
}
```

`config` 原样透传给 plugin 的各个入口函数（createHooks、registerActions），Core 不解析其内容。

---

## 十九、全局目录结构

### 目录设计

```
<data_dir>/                              (~/Library/Application Support/harmonia)
├── config.json                          # 全局配置（注册的 workflows 等）
├── registry.json                        # 项目注册表
├── overrides.json                       # 全局 override 配置（可选）
├── workflows/                           # workflow 插件目录
│   ├── dev/                             # 内置 dev workflow（setup 时拷贝）
│   │   ├── workflow.json
│   │   ├── roles/
│   │   ├── schemas/
│   │   ├── hooks.ts
│   │   └── tools.ts
│   └── <custom-workflow>/               # 用户自定义 workflow
│       └── ...
├── <project-name>/                      # 项目数据目录
│   ├── overrides.json                   # 项目级 override（可选）
│   ├── issues.json
│   ├── iter-1/
│   │   ├── state.json
│   │   ├── artifacts/                   # 原 docs/ 重命名
│   │   ├── reviews.json
│   │   ├── dispatches.json
│   │   └── sessions.json
│   ├── iter-2/
│   └── patch-1/
└── <another-project>/
```

### config.json

```json
{
  "workflows": {
    "dev": {
      "path": "<data_dir>/workflows/dev",
      "config": {}
    }
  }
}
```

### setup 流程（重构后）

1. 检测 agent 类型
2. 将内置 dev workflow 从 npm 包拷贝到 `<data_dir>/workflows/dev/`
3. 写入 config.json，注册 dev workflow
4. 注入 coordinator prompt（通用引导）

Hook 安装延迟到 project_init 时执行。

---

## 二十、Override 系统（简化保留）

### 核心定位

Override 是 Core 的**运行时动态配置层**，与 pluginConfig（静态配置）定位不同。

| 配置类型     | 确定时机 | 修改方式         | 用途                 |
| ------------ | -------- | ---------------- | -------------------- |
| pluginConfig | 安装时   | 编辑配置文件     | 给 plugin 代码用     |
| overrides    | 运行时   | MCP 工具动态修改 | 协调者运行时调整行为 |

### 三层合并

```
优先级: 项目级 > 全局级 > 工作流默认值
```

### 覆盖能力

| 功能                  | 说明                            |
| --------------------- | ------------------------------- |
| 审核开关              | 按 artifact 控制是否需要审核    |
| 角色能力覆盖          | 将角色某个能力重定向到外部工具  |
| 角色 agent/model 指定 | 指定角色使用的 agent 类型和模型 |

### MCP 工具（重命名）

| 原名            | 新名                | 功能         |
| --------------- | ------------------- | ------------ |
| guard_set       | override_set        | 设置覆盖配置 |
| guard_get       | override_get        | 查看覆盖配置 |
| review_set_rule | 合并到 override_set | 设置审核规则 |

### 移除项

- Scale 相关的 guard 检查（scale 已移除）
- Phase 相关的 workflow guard 移到 dev workflow plugin

---

## 二十（修订）、Override 系统

### 两层合并

```
优先级: 项目级 > 工作流默认值
```

- **工作流默认值** — workflow plugin 中定义的默认配置（如 dev workflow 默认 PRD 需要审核）
- **项目级** — `<project>/overrides.json`，手动编辑覆盖工作流默认值

全局 overrides.json 移除。不暴露 MCP 工具修改 override。

---

## 二十一、Dev 工作流迁移要求

**硬性要求：当前 dev 工作流的所有功能必须在新架构下完整保留。**

重构不是重写，dev 工作流作为内置 workflow plugin 实现，功能不能丢失。包括：

- 5 个阶段的完整流程（clarify → design → develop → test → deliver）
- 4 个角色（pm→coordinator, architect, developer, tester）
- 14 种文档类型（→ artifact）及其 schema
- 顺序写入机制（prd、tech-design、task-breakdown 的多步骤流程）
- 文档审核机制（prd、prototype 默认需要审核）
- 迭代 + 补丁系统
- Issue 追踪
- 边界守卫（coordinator 不能直接写代码）
- 主动提醒（dispatch 超时、审核待处理、阶段空闲）
- 角色能力覆盖
