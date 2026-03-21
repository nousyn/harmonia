# 工作流搭建指南

本文档指导你从零搭建一个 Harmonia 工作流插件。读完后你将了解：

- 工作流的目录结构和必需文件
- 节点树的设计与编写
- 角色提示词的编写规范
- 产出定义与 Schema 校验
- Hook 和 Action 的扩展机制
- 校验规则与常见错误排查

---

## 目录

- [快速示例](#快速示例)
- [目录结构](#目录结构)
- [workflow.json 详解](#workflowjson-详解)
  - [根字段](#根字段)
  - [节点树](#节点树)
  - [节点类型](#节点类型)
  - [Gate 条件](#gate-条件)
  - [Loop 终止机制](#loop-终止机制)
  - [节点钩子](#节点钩子)
  - [游离节点](#游离节点floating-nodes)
  - [产出定义](#产出定义)
- [角色提示词](#角色提示词)
  - [文件格式](#文件格式)
  - [Frontmatter 字段](#frontmatter-字段)
  - [动态内容注入](#动态内容注入)
- [产出 Schema](#产出-schema)
  - [命名规则](#命名规则)
  - [Schema 结构](#schema-结构)
  - [Markdown Schema](#markdown-schema)
  - [JSON Schema](#json-schema)
  - [步骤 Schema](#步骤-schema)
- [Hooks 扩展](#hooks-扩展)
  - [createHooks 接口](#createhooks-接口)
  - [上下文参数](#上下文参数)
  - [各 Agent 的 Hook 格式](#各-agent-的-hook-格式)
- [Actions 扩展](#actions-扩展)
  - [registerActions 接口](#registeractions-接口)
  - [ActionContext](#actioncontext)
  - [在节点钩子中引用](#在节点钩子中引用)
- [覆盖配置](#覆盖配置)
  - [review 覆盖](#review-覆盖)
  - [角色覆盖](#角色覆盖)
- [校验规则](#校验规则)
- [工作流查找与部署](#工作流查找与部署)
- [内置 dev 工作流参考](#内置-dev-工作流参考)

---

## 快速示例

一个最简工作流只需要 2 个文件：

```
workflows/my-flow/
├── workflow.json
└── roles/
    └── coordinator.md
```

**workflow.json：**

```json
{
  "name": "my-flow",
  "description": "一个最简单的工作流",
  "version": "1.0.0",
  "coordinator": "coordinator",
  "root": {
    "type": "task",
    "id": "do-work",
    "role": "coordinator"
  },
  "artifacts": {
    "result": { "name": "工作成果" }
  }
}
```

**roles/coordinator.md：**

```markdown
---
model: claude-sonnet-4
session: none
parallel: false
---

# Coordinator

你是项目协调者，负责完成工作并产出结果。
```

这就是一个可运行的工作流。下面逐一讲解每个组件。

---

## 目录结构

```
workflows/<workflow-name>/
├── workflow.json           # [必需] 工作流定义
├── roles/                  # [必需] 角色提示词
│   ├── coordinator.md      #   至少包含 coordinator 角色
│   ├── architect.md
│   └── ...
├── schemas/                # [可选] 产出 Schema
│   ├── prd.json            #   产出级 Schema
│   ├── prd.requirements.json  # 步骤级 Schema
│   └── ...
├── hooks/                  # [可选] Agent 平台钩子
│   └── index.js            #   入口，导出 createHooks()
└── tools/                  # [可选] 节点钩子动作
    └── index.js            #   入口，导出 registerActions()
```

| 文件             | 必需 | 说明                                   |
| ---------------- | ---- | -------------------------------------- |
| `workflow.json`  | 是   | 节点树 + 产出定义                      |
| `roles/*.md`     | 是   | 每个角色一个文件，文件名 = 角色 ID     |
| `schemas/*.json` | 否   | 产出 Schema 校验规则                   |
| `hooks/index.js` | 否   | 导出 `createHooks(agentType, context)` |
| `tools/index.js` | 否   | 导出 `registerActions(api)`            |

---

## workflow.json 详解

### 根字段

```typescript
{
  name: string;           // 工作流名称（与目录名一致）
  description: string;    // 工作流描述
  version?: string;       // 版本号
  author?: string;        // 作者
  coordinator: string;    // 协调者角色 ID（必填）
  root: WorkflowNode;     // 根节点
  floatingNodes?: TaskNode[];  // 游离节点
  artifacts: Record<string, ArtifactDefinition>;  // 产出定义
}
```

`coordinator` 是特殊角色——它是驱动整个工作流的"调度员"。工作流树中的所有 `role` 值和 `coordinator` 值都必须在 `roles/` 目录下有对应的 `.md` 文件。

### 节点树

工作流的核心是一棵节点树。根节点 `root` 可以是任意节点类型，子节点通过 `children`（sequence / parallel）、`pass` / `fail`（gate）或 `body`（loop）嵌套。

### 节点类型

Harmonia 支持 5 种节点类型：

#### task — 工作单元

最基本的节点，代表一个需要某个角色执行的任务。

```json
{
  "type": "task",
  "id": "design",
  "role": "architect",
  "timeout": 3600,
  "onFailed": {
    "goto": "clarify",
    "maxRetries": 3,
    "onExhausted": "escalate"
  },
  "beforeDispatch": { ... },
  "afterComplete": { ... }
}
```

| 字段             | 类型             | 必需 | 说明                |
| ---------------- | ---------------- | ---- | ------------------- |
| `type`           | `"task"`         | 是   |                     |
| `id`             | `string`         | 是   | 全局唯一标识        |
| `role`           | `string`         | 是   | 执行此任务的角色 ID |
| `timeout`        | `number`         | 否   | 超时时间（秒）      |
| `onFailed`       | `FailureHandler` | 否   | 失败后的处理策略    |
| `beforeDispatch` | `NodeHook`       | 否   | 分派前钩子          |
| `afterComplete`  | `NodeHook`       | 否   | 完成后钩子          |

#### sequence — 顺序执行

子节点按声明顺序依次执行。

```json
{
  "type": "sequence",
  "id": "main",
  "children": [
    { "type": "task", "id": "step-1", "role": "coordinator" },
    { "type": "task", "id": "step-2", "role": "developer" }
  ]
}
```

| 字段       | 类型             | 必需 | 说明         |
| ---------- | ---------------- | ---- | ------------ |
| `type`     | `"sequence"`     | 是   |              |
| `id`       | `string`         | 是   | 全局唯一标识 |
| `children` | `WorkflowNode[]` | 是   | 子节点数组   |

#### parallel — 并行执行

子节点同时执行。

```json
{
  "type": "parallel",
  "id": "concurrent-work",
  "failStrategy": "fail-fast",
  "children": [
    { "type": "task", "id": "task-a", "role": "developer" },
    { "type": "task", "id": "task-b", "role": "developer" }
  ],
  "onFailed": { "goto": "design" }
}
```

| 字段           | 类型                        | 必需   | 说明                                                                |
| -------------- | --------------------------- | ------ | ------------------------------------------------------------------- |
| `type`         | `"parallel"`                | 是     |                                                                     |
| `id`           | `string`                    | 是     | 全局唯一标识                                                        |
| `failStrategy` | `"fail-fast" \| "wait-all"` | **是** | `fail-fast`：任一子节点失败则立即失败；`wait-all`：等所有子节点完成 |
| `children`     | `WorkflowNode[]`            | 是     | 子节点数组                                                          |
| `onFailed`     | `FailureHandler`            | 否     | 失败后的处理策略                                                    |

#### gate — 条件检查

检查条件是否满足，决定走 pass 还是 fail 分支。所有条件需同时满足（AND 逻辑）。

```json
{
  "type": "gate",
  "id": "prd-gate",
  "conditions": [
    { "type": "artifact_exists", "artifact": "prd" },
    { "type": "artifact_approved", "artifact": "prd" }
  ],
  "pass": {
    "type": "task",
    "id": "design",
    "role": "architect"
  },
  "fail": {
    "goto": "clarify",
    "maxRetries": 5,
    "onExhausted": "escalate"
  }
}
```

| 字段         | 类型                         | 必需 | 说明                                |
| ------------ | ---------------------------- | ---- | ----------------------------------- |
| `type`       | `"gate"`                     | 是   |                                     |
| `id`         | `string`                     | 是   | 全局唯一标识                        |
| `conditions` | `GateCondition[]`            | 是   | 条件数组（AND 逻辑）                |
| `pass`       | `WorkflowNode`               | 是   | 条件通过时的分支（内联节点）        |
| `fail`       | `WorkflowNode \| GotoTarget` | 是   | 条件失败时的分支（内联节点或 goto） |

#### loop — 循环执行

重复执行 `body` 子树，直到收到 `loop_done` 信号或达到 `maxIterations` 上限。每次迭代前，body 内所有节点状态自动重置为 `pending`。

```json
{
  "type": "loop",
  "id": "refine-loop",
  "maxIterations": 10,
  "body": {
    "type": "sequence",
    "id": "refine-cycle",
    "children": [
      { "type": "task", "id": "refine", "role": "developer" },
      { "type": "task", "id": "verify", "role": "tester" }
    ]
  },
  "onFailed": { "goto": "design", "maxRetries": 2 }
}
```

| 字段            | 类型             | 必需   | 说明                                                                   |
| --------------- | ---------------- | ------ | ---------------------------------------------------------------------- |
| `type`          | `"loop"`         | 是     |                                                                        |
| `id`            | `string`         | 是     | 全局唯一标识                                                           |
| `maxIterations` | `number`         | **是** | 最大迭代次数（正整数），安全上限。达到上限时 loop **失败**而非成功     |
| `body`          | `WorkflowNode`   | **是** | 每次迭代执行的子工作流，可以是任意节点类型。必须包含至少一个 task 节点 |
| `onFailed`      | `FailureHandler` | 否     | 失败后的处理策略（达到 maxIterations 或 body 内节点失败冒泡时触发）    |

**终止机制：**

- **正常终止** — body 内的角色通过 `dispatch_report` 触发 `loop_done` 事件，标记当前迭代为最后一轮。当前迭代正常完成后 loop 标记为 `completed`
- **达到上限** — 如果迭代次数达到 `maxIterations` 且未收到 `loop_done`，loop 标记为 `failed`（可被 `onFailed` 捕获）
- **body 失败** — body 内节点失败且无法自行处理时，失败冒泡到 loop 节点

### Gate 条件

Gate 支持 3 种条件类型：

#### artifact_exists — 产出是否存在

```json
{ "type": "artifact_exists", "artifact": "prd" }
```

检查指定产出是否已通过 `artifact_write` 写入。

#### artifact_approved — 产出是否已审批

```json
{ "type": "artifact_approved", "artifact": "prd" }
```

检查指定产出是否已通过 `artifact_approve` 审批。只有 `review: true` 的产出才需要审批。

#### artifact_field — 产出字段值判断

```json
{
  "type": "artifact_field",
  "artifact": "test-report",
  "field": "result",
  "operator": "eq",
  "value": "pass"
}
```

读取 JSON 格式产出的某个字段，与期望值比较。仅适用于 JSON 格式的产出。

| 字段       | 类型     | 说明                                                                 |
| ---------- | -------- | -------------------------------------------------------------------- |
| `artifact` | `string` | 产出 ID                                                              |
| `field`    | `string` | JSON 字段路径（支持 `.` 分隔的嵌套路径，如 `result`、`stats.total`） |
| `operator` | `string` | 比较运算符                                                           |
| `value`    | `any`    | 期望值                                                               |

**支持的运算符：**

| 运算符     | 含义                | 示例                                    |
| ---------- | ------------------- | --------------------------------------- |
| `eq`       | 等于                | `"value": "pass"`                       |
| `neq`      | 不等于              | `"value": "fail"`                       |
| `gt`       | 大于                | `"value": 80`                           |
| `lt`       | 小于                | `"value": 10`                           |
| `gte`      | 大于等于            | `"value": 90`                           |
| `lte`      | 小于等于            | `"value": 5`                            |
| `contains` | 包含（字符串/数组） | `"value": "error"`                      |
| `in`       | 在列表中            | `"value": ["pass", "conditional-pass"]` |

### 节点钩子

task 节点可定义 `beforeDispatch` 和 `afterComplete` 钩子：

```json
{
  "type": "task",
  "id": "design",
  "role": "architect",
  "beforeDispatch": {
    "inject": ["请基于 PRD 和用户故事进行技术设计。"],
    "actions": ["check-prerequisites"]
  },
  "afterComplete": {
    "inject": ["设计阶段完成。请确认产出已写入。"]
  }
}
```

| 字段      | 类型       | 说明                                                                                 |
| --------- | ---------- | ------------------------------------------------------------------------------------ |
| `inject`  | `string[]` | 静态提示文本，追加到角色提示词（beforeDispatch）或 Coordinator 指引（afterComplete） |
| `actions` | `string[]` | 要执行的已注册 Action 名称（见 [Actions 扩展](#actions-扩展)）                       |

**执行流程：**

1. 收集 `inject` 中的静态文本
2. 按顺序执行 `actions` 中的每个 Action
3. 每个 Action 返回的 `inject` 文本被追加
4. 所有文本合并后注入到提示词或指引中

### 游离节点（Floating Nodes）

不在主节点树上的独立 task 节点，只能被 `onExhausted` 或 `onFailed` 引用。用于异常处理和升级路径。

```json
{
  "root": { ... },
  "floatingNodes": [
    {
      "type": "task",
      "id": "escalate",
      "role": "coordinator"
    }
  ]
}
```

在 gate 的 `fail` 中通过 `onExhausted` 引用：

```json
{
  "fail": {
    "goto": "clarify",
    "maxRetries": 5,
    "onExhausted": "escalate"
  }
}
```

当 `clarify` 被重试 5 次仍然失败后，工作流跳转到 `escalate` 节点处理。

> **约束：** 游离节点只能是 `task` 类型。`onExhausted` 引用的 ID 必须存在于 `floatingNodes` 数组中。

### 产出定义

产出在 `workflow.json` 的 `artifacts` 字段中声明：

```json
{
  "artifacts": {
    "prd": {
      "name": "需求文档",
      "format": "md",
      "review": true,
      "steps": [
        {
          "id": "requirements",
          "name": "需求结构化",
          "format": "json",
          "description": "将需求整理为结构化 JSON"
        },
        {
          "id": "draft",
          "name": "PRD 草稿",
          "format": "md",
          "description": "基于结构化需求生成 PRD 文档"
        }
      ]
    },
    "code": {
      "name": "代码实现",
      "unmanaged": true
    },
    "test-report": {
      "name": "测试报告",
      "format": "json"
    }
  }
}
```

#### 产出字段

| 字段        | 类型                       | 必需 | 默认值  | 说明                                                           |
| ----------- | -------------------------- | ---- | ------- | -------------------------------------------------------------- |
| `name`      | `string`                   | 是   | —       | 人类可读名称                                                   |
| `format`    | `"md" \| "html" \| "json"` | 否   | `"md"`  | 文件格式                                                       |
| `review`    | `boolean`                  | 否   | `false` | 写入后是否需要用户审批                                         |
| `unmanaged` | `boolean`                  | 否   | `false` | 非托管产出（如代码），不经 `artifact_write` 管理               |
| `output`    | `string`                   | 否   | —       | 输出目录模板，支持 `{global}`、`{project}`、`{context}` 占位符 |
| `steps`     | `ArtifactStep[]`           | 否   | —       | 分步写入定义                                                   |

#### 步骤字段

| 字段          | 类型             | 必需 | 说明                            |
| ------------- | ---------------- | ---- | ------------------------------- |
| `id`          | `string`         | 是   | 步骤 ID，对应 Schema 文件名后缀 |
| `name`        | `string`         | 是   | 人类可读名称                    |
| `format`      | `"json" \| "md"` | 是   | 该步骤的输出格式                |
| `description` | `string`         | 是   | 给 Agent 的指引说明             |

**步骤执行规则：**

- 定义了 `steps` 后，`artifact_write` 需要提供 `step` 参数
- 步骤按定义顺序执行
- 重写已完成的步骤会自动清除后续步骤的完成记录（rollback）
- 所有步骤完成后，还需写入最终产出

---

## 角色提示词

### 文件格式

角色文件位于 `roles/<roleId>.md`，采用 **YAML frontmatter + Markdown 正文** 格式：

```markdown
---
model: claude-sonnet-4
session: none
parallel: false
capabilities:
  - id: analyze-codebase
    description: 分析项目代码结构
  - id: write-design
    description: 撰写技术方案
    artifact: tech-design
---

# 架构师

你是项目架构师，负责代码分析和技术方案设计。

## 职责

1. 深入分析现有代码结构
2. 设计合理的技术方案
3. 拆解开发任务

## 约束

- 不要直接修改代码文件
- 使用 Harmonia 工具进行任务交接
```

### Frontmatter 字段

> **定位说明：** `model`、`session`、`parallel`、`agent` 由 Harmonia Core 在 `role_dispatch` 中强制执行。Core 根据这些值决定是否查找可复用 session、是否强制新会话、以及在 Session Guidance 中给出何种指示。Coordinator 收到的 dispatch 数据包中已包含基于这些字段计算出的操作指引。

| 字段           | 类型                                   | 必需 | 默认值   | 说明                                                                                                                                                                                                                                             |
| -------------- | -------------------------------------- | ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model`        | `string`                               | 否   | —        | 拉起该角色 agent 时使用的模型。应填写具体模型名称（如 `claude-sonnet-4`、`claude-opus-4`）。未指定时不输出模型建议，由宿主工具使用其默认模型。可被 `overrides.json` 中的 `roles.<role>.model` 覆盖                                               |
| `agent`        | `string`                               | 否   | —        | 推荐使用的 agent 类型（如 `opencode`、`claude-code`、`openclaw`、`codex`）。未指定时不输出 agent 建议。可被 `overrides.json` 中的 `roles.<role>.agent` 覆盖                                                                                      |
| `session`      | `"none" \| "persistent" \| "optional"` | 否   | `"none"` | 会话复用模式，Core 强制执行：`none` — 不查找空闲 session，始终指示启动新会话；`persistent` — 查找空闲 session，找到则指示 Coordinator 复用（含 `--resume` 命令）；`optional` — 查找空闲 session，找到则以建议性语气呈现，由 Coordinator 自行决定 |
| `parallel`     | `boolean`                              | 否   | `false`  | 是否支持并行调度，Core 强制执行：`true` 且同角色已有运行中的 dispatch 时，跳过空闲 session 查找，强制启动新会话；`true` 但无运行中的 dispatch 时，按 `session` 字段正常处理；`false` 时无特殊处理                                                |
| `capabilities` | `RoleCapability[]`                     | 否   | —        | 角色能力列表                                                                                                                                                                                                                                     |

**Capability 字段：**

| 字段          | 类型     | 必需 | 说明                                  |
| ------------- | -------- | ---- | ------------------------------------- |
| `id`          | `string` | 是   | 能力 ID                               |
| `description` | `string` | 是   | 能力描述                              |
| `artifact`    | `string` | 否   | 关联的产出 ID（该能力负责产出此文档） |

> 如果 `.md` 文件没有 frontmatter（即省略 `---` 块），加载器会使用默认值（session: none, parallel: false），整个文件内容作为 prompt。`model` 和 `agent` 无默认值——未指定时 dispatch 数据包中不会包含模型/agent 建议。

### 动态内容注入

角色提示词没有内置模板变量替换机制，但有两种动态注入方式：

1. **节点钩子注入** — `beforeDispatch.inject` 中的文本和 Action 返回的 `inject` 文本会追加到角色提示词末尾
2. **Override 注入** — 如果项目配置了 capability override，会在提示词末尾追加 "Enhanced Capabilities" 章节

---

## 产出 Schema

Schema 用于校验 `artifact_write` 写入的内容。如果不提供 Schema，写入时不做内容校验。

### 命名规则

Schema 文件位于 `schemas/` 目录，命名规则：

| 格式                     | 用途          | 示例                                              |
| ------------------------ | ------------- | ------------------------------------------------- |
| `<产出ID>.json`          | 产出级 Schema | `prd.json`、`test-report.json`                    |
| `<产出ID>.<步骤ID>.json` | 步骤级 Schema | `prd.requirements.json`、`tech-design.draft.json` |

### Schema 结构

所有 Schema 文件遵循统一的 `ArtifactSchema` 结构：

```json
{
  "guidance": "给 Agent 的写作指引",
  "minLength": 200,
  "sections": [ ... ],
  "jsonFields": [ ... ]
}
```

| 字段         | 类型                        | 说明                        |
| ------------ | --------------------------- | --------------------------- |
| `guidance`   | `string`                    | 给 Agent 的人类可读写作指引 |
| `minLength`  | `number`                    | 最小内容长度（字符数）      |
| `sections`   | `ArtifactSchemaSection[]`   | Markdown 文档必需章节       |
| `jsonFields` | `ArtifactSchemaJsonField[]` | JSON 文档必需字段           |
| `htmlTags`   | `string[]`                  | HTML 文档必需标签           |

### Markdown Schema

用于 Markdown 格式的产出，校验必需章节是否存在：

```json
{
  "guidance": "PRD 需要包含完整的需求描述和验收标准",
  "minLength": 200,
  "sections": [
    { "heading": "项目概述", "required": true },
    { "heading": "功能需求", "required": true, "aliases": ["功能列表"] },
    { "heading": "非功能需求", "required": false },
    { "heading": "验收标准", "required": true }
  ]
}
```

**Section 字段：**

| 字段       | 类型       | 必需 | 说明                                            |
| ---------- | ---------- | ---- | ----------------------------------------------- |
| `heading`  | `string`   | 是   | 标题文本（如 `"## 项目概述"`，前缀 `#` 可省略） |
| `required` | `boolean`  | 是   | 是否必需                                        |
| `aliases`  | `string[]` | 否   | 可替代的标题文本                                |

校验时会自动处理标题层级和大小写，并检查 `aliases` 中的替代写法。

> **校验语义说明：**
>
> - `required: true` — 该章节必须出现，缺少时 `artifact_write` 会拒绝写入并返回 `missing_section` 错误
> - `required: false` — 该章节可有可无，不会校验其是否存在。定义它的意义在于通过 Schema guidance 提示 Agent 可以包含此章节
> - Schema **不会限制额外章节** — Agent 可以自由添加 schema 中未定义的章节，校验只检查"必需章节是否缺失"
> - Schema 内容会通过 `role_dispatch` 以格式化文本注入 dispatch 数据包中（由 `formatSchemaGuidance()` 生成人类可读的写作指引），同时在 `artifact_write` 时执行实际校验

### JSON Schema

用于 JSON 格式的产出，校验必需字段是否存在及类型是否正确：

```json
{
  "guidance": "测试报告需包含测试结果和覆盖率",
  "jsonFields": [
    { "field": "result", "required": true, "type": "string" },
    { "field": "totalTests", "required": true, "type": "number" },
    { "field": "passedTests", "required": true, "type": "number" },
    { "field": "failures", "required": false, "type": "array", "minItems": 0 },
    { "field": "coverage", "required": false, "type": "object" }
  ]
}
```

**JsonField 字段：**

| 字段       | 类型      | 必需 | 说明                                                           |
| ---------- | --------- | ---- | -------------------------------------------------------------- |
| `field`    | `string`  | 是   | JSON 顶层字段名                                                |
| `required` | `boolean` | 是   | 是否必需                                                       |
| `type`     | `string`  | 否   | 预期类型：`string` / `number` / `boolean` / `array` / `object` |
| `minItems` | `number`  | 否   | 若 type=array，最少元素数                                      |

### 步骤 Schema

步骤 Schema 和产出 Schema 结构完全相同，只是文件名不同、应用时机不同：

- **产出 Schema**（`prd.json`）→ 校验最终合成产出
- **步骤 Schema**（`prd.requirements.json`）→ 校验单个步骤的中间产出

在角色调度时，Core 会将产出 Schema 和所有步骤 Schema 合并为一份写作指引，自动注入到 dispatch 数据包中。Agent 无需手动查询 Schema。

---

## Hooks 扩展

Hooks 用于在 Agent 平台级别安装边界守卫和主动提醒。这是**可选功能**——如果你的工作流不需要拦截越权操作或注入提醒，可以不提供 `hooks/` 目录。

### createHooks 接口

在 `hooks/index.js` 中导出 `createHooks` 函数：

```javascript
/**
 * @param {string} agentType - Agent 类型：'opencode' | 'claude-code' | 'openclaw' | 'codex'
 * @param {HookCreatorContext} context
 * @returns {unknown} Agent 特定的 Hook 集合
 */
export function createHooks(agentType, context) {
  // 根据 agentType 生成对应平台的 Hook
  const hooks = context.defineHooks(agentType, ...);
  return hooks;
}
```

此函数在 `project_init` 时被调用，由 Core 传入 `agentType` 和 `context`。

### 上下文参数

`context` 包含以下字段：

| 字段          | 类型       | 说明                                                               |
| ------------- | ---------- | ------------------------------------------------------------------ |
| `defineHooks` | `Function` | 来自 `@s_s/agent-kit` 的钩子定义函数，用于生成平台特定的 Hook 格式 |
| `dataDir`     | `string`   | Harmonia 数据目录路径                                              |
| `projectName` | `string`   | 项目名称                                                           |

> **重要：** `defineHooks` 由 Core 通过依赖注入传入，工作流插件**不应直接 import `@s_s/agent-kit`**。

### 各 Agent 的 Hook 格式

不同 Agent 平台的 Hook 格式不同，通过 `defineHooks` 函数统一封装：

**Claude Code / Codex：**

```javascript
context.defineHooks('claude-code', [
  {
    events: ['PreToolUse'], // 工具调用前拦截
    content: '#!/bin/bash\n...', // Shell 脚本
  },
  {
    events: ['UserPromptSubmit'], // 用户提交时注入提醒
    content: '#!/bin/bash\n...', // Shell 脚本
  },
]);
```

**OpenCode：**

```javascript
context.defineHooks('opencode', {
  events: ['tool.execute.before', 'experimental.chat.messages.transform'],
  content: 'export default { ... }', // TypeScript 插件源码
});
```

**OpenClaw：**

```javascript
context.defineHooks('openclaw', {
  events: ['message_received', 'before_tool_call'],
  content: 'export default { ... }', // TypeScript handler 源码
  description: '边界守卫与状态提醒',
});
```

---

## Actions 扩展

Actions 是在节点钩子中调用的同步操作，用于在 dispatch 或 complete 时执行自定义逻辑。这是**可选功能**——如果只需要静态的 `inject` 文本，不需要 `tools/` 目录。

### registerActions 接口

在 `tools/index.js` 中导出 `registerActions` 函数：

```typescript
export function registerActions(api: { register: (name: string, handler: ActionHandler) => void }): void {
  api.register('check-prerequisites', async (context) => {
    // 检查前置产出是否存在
    const artifacts = await context.artifacts.list();
    if (!artifacts.includes('prd')) {
      return { inject: ['警告：PRD 尚未写入，请先完成需求阶段。'] };
    }
    return { inject: ['所有前置产出已就绪。'] };
  });

  api.register('summarize-progress', async (context) => {
    const state = context.workflowState;
    return {
      inject: [`当前重试次数：${context.retryCount}`],
      data: { currentNode: context.nodeId },
    };
  });
}
```

### ActionContext

每个 Action 执行时收到的上下文：

| 字段                 | 类型                          | 说明                                      |
| -------------------- | ----------------------------- | ----------------------------------------- |
| `nodeId`             | `string`                      | 当前节点 ID                               |
| `role`               | `string`                      | 当前节点的角色                            |
| `retryCount`         | `number`                      | 当前重试次数（0 = 首次执行）              |
| `projectName`        | `string`                      | 项目名称                                  |
| `pluginConfig`       | `unknown`                     | 插件配置                                  |
| `gateResults`        | `GateEvaluationResult?`       | Gate 评估结果（从 gate fail/goto 到达时） |
| `workflowState`      | `WorkflowState`               | 当前工作流状态快照                        |
| `artifacts.read(id)` | `(string) => Promise<string>` | 读取产出内容                              |
| `artifacts.list()`   | `() => Promise<string[]>`     | 列出已有产出                              |
| `taskResult`         | `unknown?`                    | 任务完成结果（仅 afterComplete 中可用）   |

Action 的返回值：

```typescript
interface ActionResult {
  inject?: string[]; // 动态注入的提示文本
  data?: unknown; // 传递给下游的额外数据
}
```

### 在节点钩子中引用

通过 `beforeDispatch.actions` 或 `afterComplete.actions` 数组引用已注册的 Action 名称：

```json
{
  "type": "task",
  "id": "develop",
  "role": "developer",
  "beforeDispatch": {
    "inject": ["静态提示文本"],
    "actions": ["check-prerequisites", "summarize-progress"]
  }
}
```

Action 按声明顺序依次执行，每个 Action 返回的 `inject` 追加到最终提示词中。

---

## 覆盖配置

使用者可以通过项目级 `overrides.json` 覆盖工作流中的默认配置，无需修改工作流插件本身。

配置文件位于 `<data_dir>/<project_name>/overrides.json`，合并优先级：

```
项目级 overrides.json  >  工作流默认值
```

### review 覆盖

控制哪些产出在写入后需要用户审批：

```json
{
  "review": true
}
```

| 写法                                              | 含义               |
| ------------------------------------------------- | ------------------ |
| `"review": true`                                  | 所有产出都需审批   |
| `"review": false`                                 | 所有产出无需审批   |
| `"review": { "prd": true, "tech-design": false }` | 按产出 ID 逐一控制 |

解析优先级：overrides 中的按 ID 配置 > overrides 中的全局布尔值 > workflow.json 中的 `review` 字段 > 默认 `false`。

### 角色覆盖

覆盖角色的 Agent 类型、模型和能力：

```json
{
  "roles": {
    "architect": {
      "agent": "claude-code",
      "model": "claude-opus-4",
      "capabilities": {
        "analyze-codebase": {
          "type": "mcp",
          "tool": "code_analysis",
          "server": "my-analysis-server",
          "params": { "depth": 3 },
          "notes": "使用外部分析服务"
        }
      }
    }
  }
}
```

| 字段                       | 类型               | 说明                                 |
| -------------------------- | ------------------ | ------------------------------------ |
| `agent`                    | `string`           | 覆盖该角色使用的 Agent 类型          |
| `model`                    | `string`           | 覆盖该角色的模型级别                 |
| `capabilities.<id>.type`   | `"skill" \| "mcp"` | 能力类型                             |
| `capabilities.<id>.tool`   | `string`           | 工具名称                             |
| `capabilities.<id>.server` | `string`           | MCP 服务器名称（type 为 mcp 时必填） |
| `capabilities.<id>.params` | `object`           | 固定参数                             |
| `capabilities.<id>.notes`  | `string`           | 附加说明（注入到提示词中）           |

---

## 校验规则

Harmonia 在加载工作流插件时会自动校验 `workflow.json`。校验不通过时抛出 `PluginValidationError`，包含详细错误列表。

**9 条校验规则：**

| #   | 规则               | 错误类型                | 说明                                                                          |
| --- | ------------------ | ----------------------- | ----------------------------------------------------------------------------- |
| 1   | ID 唯一性          | `duplicate_id`          | 节点树 + floatingNodes 中所有 ID 不能重复                                     |
| 2   | Goto 目标合法性    | `invalid_goto`          | goto 目标必须存在，且是祖先或执行顺序上的前驱节点；不允许从外部跳入 loop body |
| 3   | 循环检测           | `cycle`                 | 没有 maxRetries 的 goto 边不能构成无出口循环                                  |
| 4   | failStrategy 必填  | `missing_fail_strategy` | parallel 节点必须设置 `failStrategy`                                          |
| 5   | 游离节点引用有效性 | `invalid_floating_ref`  | `onExhausted` 引用的 ID 必须存在于 `floatingNodes` 中                         |
| 6   | 角色引用有效性     | `invalid_role_ref`      | task 节点的 `role` 必须在 `roles/` 目录中有对应文件                           |
| 7   | 协调者有效性       | `invalid_coordinator`   | `coordinator` 字段的值必须在 `roles/` 目录中有对应文件                        |
| 8   | Loop 迭代上限      | `other`                 | loop 节点的 `maxIterations` 必须是正整数                                      |
| 9   | Loop body 有效性   | `other`                 | loop 节点的 `body` 必须存在且包含至少一个 task 节点（防止同步栈溢出）         |

**Goto 目标的具体约束：**

- 可以 goto 到当前节点的**祖先节点**
- 可以 goto 到同一 sequence 中**位于当前节点之前**的兄弟节点
- task 节点可以 goto 到**自身**（自重试）
- **不允许**跨并行分支跳转
- **不允许**从 loop 外部跳转到 loop body 内部节点（loop 视为不透明边界，外部只能 goto 到 loop 节点本身）
- loop body 内部**允许** goto 到 loop 自身或 loop 的祖先/前序节点

**错误信息示例：**

```
Workflow validation failed for "/path/to/workflow":
  - [duplicate_id] Duplicate node ID "design" — found in ...
  - [invalid_goto] Node "test-gate" has goto target "nonexistent" which does not exist
  - [invalid_role_ref] Node "develop" references role "coder" but no role file found
```

---

## 工作流查找与部署

### 查找规则

Harmonia 从 `<data_dir>/harmonia/.workflows/<name>/workflow.json` 查找工作流。未找到则报错。

内置工作流（如 `dev`）在 setup 时自动复制到该目录，无需手动部署。

### 部署方式

将工作流目录复制到 `<data_dir>/harmonia/.workflows/<name>/`。数据目录的位置取决于操作系统：

| 平台    | 路径                                                 |
| ------- | ---------------------------------------------------- |
| macOS   | `~/Library/Application Support/harmonia/.workflows/` |
| Linux   | `~/.local/share/harmonia/.workflows/`                |
| Windows | `%APPDATA%/harmonia/.workflows/`                     |

### 工作流选择

- 只有一个可用工作流时：`project_init` 自动选中
- 多个可用工作流时：需在 `project_init` 中指定 `workflow` 参数

---

## 内置 dev 工作流参考

内置的 `dev` 工作流（软件开发流程）是一个完整的参考实现，可作为搭建自定义工作流的模板。

### 节点树

```
sequence(main)
├── task(clarify)          → Coordinator 澄清需求，产出 PRD
├── gate(prd-gate)         → 检查 PRD 存在 + 审批通过
│   ├── pass → task(design) → 架构师设计方案
│   └── fail → goto clarify（最多 5 次）
├── gate(design-gate)      → 检查 tech-design + task-breakdown 存在
│   ├── pass → task(develop) → 开发者编码实现
│   └── fail → goto design（最多 3 次）
├── task(test)             → 测试编写测试、执行、产出 test-report
├── gate(test-gate)        → 检查 test-report.result == "pass"
│   ├── pass → task(deliver) → Coordinator 验收交付
│   └── fail → goto develop（最多 3 次）
└── floating: escalate     → 重试耗尽时升级处理
```

### 角色

| 角色        | model           | session    | parallel | 说明                         |
| ----------- | --------------- | ---------- | -------- | ---------------------------- |
| coordinator | claude-sonnet-4 | none       | false    | 需求澄清、任务分派、验收交付 |
| architect   | claude-opus-4   | persistent | false    | 代码分析、技术方案、任务拆解 |
| developer   | claude-sonnet-4 | persistent | true     | 编码实现、单元测试、代码质量 |
| tester      | claude-sonnet-4 | optional   | false    | 测试计划、测试执行、测试报告 |

### 产出

| 产出 ID           | 名称                | 格式 | 审批 | 逐步写入                                                  |
| ----------------- | ------------------- | ---- | ---- | --------------------------------------------------------- |
| `prd`             | 需求文档            | md   | 是   | 4 步（requirements → completeness-check → draft → final） |
| `user-stories`    | 用户故事 + 验收标准 | json | 否   | —                                                         |
| `fsd`             | 功能规格            | md   | 否   | —                                                         |
| `prototype`       | 高保真原型          | html | 是   | —                                                         |
| `project-plan`    | 项目计划            | json | 否   | —                                                         |
| `tech-design`     | 技术方案            | md   | 否   | 4 步（analysis → api-contract → draft → final）           |
| `data-model`      | 数据模型设计        | json | 否   | —                                                         |
| `api-design`      | API 设计            | json | 否   | —                                                         |
| `task-breakdown`  | 任务拆解            | json | 否   | 4 步（coarse → dependencies → detailed → final）          |
| `risk-assessment` | 技术风险评估        | json | 否   | —                                                         |
| `code`            | 代码实现            | —    | 否   | 外部产出                                                  |
| `test-plan`       | 测试计划            | json | 否   | —                                                         |
| `test-report`     | 测试报告            | json | 否   | —                                                         |
| `deploy`          | 部署文档            | md   | 否   | —                                                         |
| `retrospective`   | 复盘记录            | md   | 否   | —                                                         |

### 文件结构

```
workflows/dev/
├── workflow.json            # 节点树定义
├── hooks/                   # Hook 模块
│   ├── index.js             #   入口，导出 createHooks()
│   ├── content.js           #   共享常量（被阻止的工具/扩展名/超时阈值）
│   ├── claude.js            #   Claude Code / Codex hook 生成器
│   ├── opencode.js          #   OpenCode hook 生成器
│   └── openclaw.js          #   OpenClaw hook 生成器
├── tools/                   # Action 模块
│   └── index.js             #   registerActions()（当前为空实现）
├── roles/
│   ├── coordinator.md
│   ├── architect.md
│   ├── developer.md
│   └── tester.md
└── schemas/                 # 26 个 Schema 文件
```

dev 工作流的 Hook 实现了两大功能：

1. **边界守卫** — 阻止 Coordinator 直接修改代码文件或运行开发命令
2. **主动提醒** — 扫描数据目录，提醒 Dispatch 超时（30min）、工作流空闲（15min）、Review 待审核（10min）
