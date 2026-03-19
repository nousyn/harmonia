# Harmonia

> _众声喧哗之中，和谐不是沉默，而是各得其所。_

Harmonia 是一个基于 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 的**通用多代理协作框架**。它为 AI 编程助手（Claude Code、OpenCode、OpenClaw、Codex）提供工作流编排工具，让多个 AI agent 在**可插拔的工作流**中按角色协作完成任务。

## 核心理念

- **节点树驱动** — 工作流定义为节点树（sequence / parallel / task / gate），支持条件分支、失败重试、并行执行
- **角色分离** — Coordinator、架构师、开发者、测试各司其职，通过产出（artifact）交接而非直接对话
- **可插拔工作流** — 工作流以插件形式存在，包含节点树定义、角色提示词、产出 Schema、钩子脚本
- **数据隔离** — 所有项目数据存储在平台数据目录，不污染代码仓库
- **被动式引擎** — Core 是决策计算器，通过 `nextAction` 指导 Coordinator 驱动工作流前进

## 特性

- **节点树工作流** — 4 种节点类型（task / sequence / parallel / gate），声明式定义复杂工作流
- **Gate 条件引擎** — 支持 `artifact_exists`、`artifact_approved`、`artifact_field` 三种条件，自动评估
- **产出系统** — 通用的读写 / 审批机制，Schema 校验，逐步写入支持
- **迭代管理** — 同一项目支持多次迭代，每次迭代独立的状态和产出
- **覆盖配置** — 两层合并（项目级 > 工作流默认值），灵活控制审批规则和角色绑定
- **跨 Agent 边界守卫** — Hook 脚本拦截越权操作 + 角色提示词注入约束上下文

## 架构概览

```
┌─────────────────────────────────────────────┐
│  AI 编程助手（Claude Code / OpenCode / ...）    │
│    └─ Coordinator 角色                        │
│         ↕ MCP Tool 调用                       │
├─────────────────────────────────────────────┤
│  Harmonia Core（MCP Server）                   │
│  ┌─────────────┐  ┌──────────────┐           │
│  │ Workflow     │  │ Artifact     │           │
│  │ Engine       │  │ System       │           │
│  ├─────────────┤  ├──────────────┤           │
│  │ Plugin       │  │ State        │           │
│  │ Loader       │  │ Manager      │           │
│  └─────────────┘  └──────────────┘           │
├─────────────────────────────────────────────┤
│  Workflow Plugin（如 dev）                     │
│  ┌──────────┐ ┌──────┐ ┌───────┐ ┌───────┐  │
│  │workflow  │ │roles/│ │schemas│ │hooks  │  │
│  │.json     │ │*.md  │ │/*.json│ │.js    │  │
│  └──────────┘ └──────┘ └───────┘ └───────┘  │
└─────────────────────────────────────────────┘
```

**核心交互循环：**

1. Coordinator 调用 MCP 工具（dispatch、artifact_write 等）
2. Core 处理调用，同步评估工作流状态（节点状态、Gate 条件）
3. Core 返回结果 + `nextAction` 字段——告知 Coordinator 下一步操作
4. Coordinator 根据 `nextAction` 继续推进

## 快速开始

### 安装

```bash
npm install -g @s_s/harmonia
```

### 配置 MCP 服务器

将 Harmonia 注册为你的 AI 编程助手的 MCP 服务器：

<details>
<summary><strong>Claude Code</strong></summary>

通过命令行：

```bash
claude mcp add --transport stdio harmonia -- harmonia
```

或添加到 `.mcp.json`：

```json
{
  "mcpServers": {
    "harmonia": {
      "command": "harmonia"
    }
  }
}
```

</details>

<details>
<summary><strong>OpenCode</strong></summary>

添加到 `opencode.json`：

```json
{
  "mcp": {
    "harmonia": {
      "type": "local",
      "command": ["harmonia"]
    }
  }
}
```

</details>

<details>
<summary><strong>Codex</strong></summary>

通过命令行：

```bash
codex mcp add harmonia -- harmonia
```

或添加到 `~/.codex/config.toml`：

```toml
[mcp_servers.harmonia]
command = "harmonia"
```

</details>

<details>
<summary><strong>OpenClaw</strong>（通过 mcporter）</summary>

添加到 `config/mcporter.json`（全局配置用 `~/.mcporter/mcporter.json`）：

```json
{
  "mcpServers": {
    "harmonia": {
      "command": "harmonia"
    }
  }
}
```

或通过 mcporter 命令行：

```bash
mcporter config add harmonia --command harmonia --scope home
```

</details>

### 初始化

```bash
harmonia setup --agent openclaw
```

`harmonia setup` 一键完成：

1. 注入 Coordinator 提示词到 agent 配置文件（AGENTS.md / CLAUDE.md）
2. 安装 agent hook 脚本（边界守卫 + 主动提醒）

之后启动你的 AI 编程助手，用自然语言告诉它你要做什么即可。

### 使用示例

setup 完成后，AI 编程助手已被注入 Coordinator 提示词。你只需要用自然语言描述需求，Coordinator 会自动调用 Harmonia 工具驱动整个流程。

**启动新项目：**

```
你：我想开发一个命令行待办事项工具，用 TypeScript 写，支持增删改查和优先级排序。
```

> Coordinator 会先调用 `project_status()` 检查是否有已注册项目，发现没有后，会和你沟通确认项目名称和目录路径，然后调用 `project_init` 注册项目、`iteration_start` 开始第一次迭代，接着根据 `nextAction` 指引开始执行工作流。

**继续已注册的项目：**

```
你：继续之前的 todo-cli 项目。
```

> Coordinator 调用 `project_status("todo-cli")` 获取当前节点树状态和进度，根据 `nextAction` 恢复工作。

**开始新一轮迭代：**

```
你：todo-cli 需要加一些新功能，开始新的迭代。
```

> Coordinator 调用 `iteration_start("todo-cli")` 创建新迭代（如 iter-2），工作流节点树重置，从头开始。

### CLI 命令

```
harmonia                       启动 MCP stdio 服务器（供 agent 调用）
harmonia setup                 初始化 agent 配置（注入提示词 + 安装 hook）
harmonia unregister <name>     注销项目（默认同时删除数据目录）
harmonia --help                显示帮助信息
harmonia --version             显示版本号
```

| 命令         | 选项             | 说明                                                                                          |
| ------------ | ---------------- | --------------------------------------------------------------------------------------------- |
| `setup`      | `--agent <type>` | agent 类型：`opencode` / `claude-code` / `codex` / `openclaw`。建议显式指定，省略时自动检测。 |
| `unregister` | `--keep-data`    | 仅移除注册表条目，保留项目数据目录。默认同时删除数据目录。                                    |

## MCP 工具一览

| 工具               | 说明                                                           |
| ------------------ | -------------------------------------------------------------- |
| `project_init`     | 注册项目，创建数据目录，加载工作流插件，安装 Hook              |
| `iteration_start`  | 开始新迭代（创建 iter-N 目录，重置节点状态）                   |
| `project_status`   | 查看项目状态（无参数返回项目列表，有参数返回节点树详情）       |
| `role_dispatch`    | 调度角色执行任务（带 nodeId，触发 beforeDispatch 钩子）        |
| `dispatch_report`  | 角色报告任务完成/失败（触发 afterComplete 钩子，推进节点状态） |
| `artifact_write`   | 写入产出（自动 Schema 校验，支持逐步写入）                     |
| `artifact_read`    | 读取产出内容                                                   |
| `artifact_list`    | 列出项目所有产出                                               |
| `artifact_schema`  | 查看产出的 JSON Schema 定义                                    |
| `artifact_approve` | 审批需要 review 的产出                                         |
| `review_list`      | 列出待审批的产出                                               |
| `role_prompt`      | 获取角色提示词（含约束上下文注入）                             |
| `patch_start`      | 热修复模式启动（基于已有迭代快速修复）                         |
| `issue_create`     | 创建 Issue                                                     |
| `issue_update`     | 更新 Issue 状态                                                |
| `issue_list`       | 列出项目 Issue                                                 |

## 工作流系统

### 节点类型

Harmonia 使用节点树定义工作流，支持 4 种节点类型：

| 节点类型     | 语义                                                          |
| ------------ | ------------------------------------------------------------- |
| **task**     | 工作单元，分配给某个角色执行                                  |
| **sequence** | 子节点按顺序执行                                              |
| **parallel** | 子节点并行执行，需指定 `failStrategy`（fail-fast / wait-all） |
| **gate**     | 条件检查节点，pass/fail 两条路径                              |

### Gate 条件

Gate 节点支持 3 种条件类型：

| 条件类型            | 说明                             | 示例                                                                                                            |
| ------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `artifact_exists`   | 产出是否已写入                   | `{ "type": "artifact_exists", "artifact": "prd" }`                                                              |
| `artifact_approved` | 产出是否已通过审批               | `{ "type": "artifact_approved", "artifact": "prd" }`                                                            |
| `artifact_field`    | 产出字段值判断（支持多种操作符） | `{ "type": "artifact_field", "artifact": "test-report", "field": "result", "operator": "eq", "value": "pass" }` |

`artifact_field` 支持的操作符：`eq`、`neq`、`gt`、`lt`、`gte`、`lte`、`contains`、`in`

Gate 失败时支持：

- **goto** — 跳转回上游节点重试（目标节点及后续节点状态重置）
- **maxRetries** — 可选，限制重试次数
- **onExhausted** — 重试耗尽后跳转到游离节点（如 escalate）

### 游离节点（Floating Nodes）

不在工作流树上的独立节点，只能被 `onExhausted` 或 `onFailed` 引用。用于异常处理和升级路径。

### 节点钩子

每个 task 节点可定义 `beforeDispatch` 和 `afterComplete` 钩子：

```json
{
  "type": "task",
  "id": "design",
  "role": "architect",
  "beforeDispatch": {
    "inject": ["请基于 prd 和 user-stories 进行技术设计。"]
  },
  "afterComplete": {
    "inject": ["设计阶段完成。请确认产出已写入。"]
  }
}
```

- `inject`：额外提示文本，beforeDispatch 时合入角色提示词，afterComplete 时合入 Coordinator 指引
- `actions`：插件注册的同步动作，在 Core 处理工具调用时执行

### 内置 dev 工作流

内置的 `dev` 工作流（软件开发流程）定义了一棵节点树和 4 个角色：

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

| 角色        | 说明                         |
| ----------- | ---------------------------- |
| Coordinator | 需求澄清、任务分派、验收交付 |
| Architect   | 代码分析、技术方案、任务拆解 |
| Developer   | 编码实现、单元测试、代码质量 |
| Tester      | 测试计划、测试执行、测试报告 |

### 产出（Artifacts）

`dev` 工作流定义了 15 种产出类型：

| 产出 ID           | 名称                | 审批 | 逐步写入 |
| ----------------- | ------------------- | ---- | -------- |
| `prd`             | 需求文档            | 是   | 4 步     |
| `user-stories`    | 用户故事 + 验收标准 | 否   | -        |
| `fsd`             | 功能规格            | 否   | -        |
| `prototype`       | 高保真原型          | 是   | -        |
| `project-plan`    | 项目计划            | 否   | -        |
| `tech-design`     | 技术方案            | 否   | 4 步     |
| `data-model`      | 数据模型设计        | 否   | -        |
| `api-design`      | API 设计            | 否   | -        |
| `task-breakdown`  | 任务拆解            | 否   | 4 步     |
| `risk-assessment` | 技术风险评估        | 否   | -        |
| `code`            | 代码实现（外部）    | 否   | -        |
| `test-plan`       | 测试计划            | 否   | -        |
| `test-report`     | 测试报告            | 否   | -        |
| `deploy`          | 部署文档            | 否   | -        |
| `retrospective`   | 复盘记录            | 否   | -        |

#### 逐步写入

大型产出可拆分为多个步骤（steps），每步独立写入并校验。例如 PRD 的写入流程：

1. `requirements` — 需求结构化（JSON）
2. `completeness-check` — 完整性校验（JSON）
3. `draft` — PRD 草稿（Markdown）
4. `final` — PRD 最终版（Markdown）

重写某步时自动清除后续步骤记录。

## 自定义工作流

Harmonia 使用**插件机制**加载工作流。工作流以目录形式存在，包含声明式内容和可选的 TS/JS 模块。

### 目录结构

```
workflows/<workflow-name>/
├── workflow.json          # 工作流定义（节点树 + 游离节点 + 产出定义）
├── roles/                 # 角色提示词（.md）
│   ├── coordinator.md
│   ├── architect.md
│   └── ...
├── schemas/               # 产出 Schema（.json，可选）
│   ├── prd.json
│   ├── prd.requirements.json   # 步骤 Schema
│   └── ...
├── hooks.js               # 可选，导出 createHooks() — agent 平台钩子
└── tools.ts               # 可选，导出 registerActions() — 节点钩子动作
```

### workflow.json 格式

```json
{
  "name": "my-workflow",
  "description": "自定义工作流描述",
  "version": "1.0.0",
  "author": "your-name",
  "coordinator": "coordinator",
  "root": {
    "type": "sequence",
    "id": "main",
    "children": [
      { "type": "task", "id": "step-1", "role": "coordinator" },
      {
        "type": "gate",
        "id": "check-1",
        "conditions": [{ "type": "artifact_exists", "artifact": "output-1" }],
        "pass": { "type": "task", "id": "step-2", "role": "worker" },
        "fail": { "goto": "step-1", "maxRetries": 3 }
      }
    ]
  },
  "floatingNodes": [],
  "artifacts": {
    "output-1": { "name": "产出物 1" },
    "output-2": { "name": "产出物 2", "review": true }
  }
}
```

### 工作流查找优先级

1. **自定义目录**（高优先级）：`<data_dir>/harmonia/.workflows/<name>/`
2. **内置目录**（回退）：`<package>/workflows/<name>/`

自定义工作流会覆盖同名的内置工作流。内置工作流随包版本自动更新，零维护。

### 工作流选择

- 只有一个可用工作流时自动选中
- 多个可用工作流时，需在 `project_init` 中指定 `workflow` 参数

## 覆盖配置

Harmonia 提供两层合并的配置覆盖系统：

```
项目级 overrides.json  >  工作流默认值
```

| 层级         | 文件位置                                       | 作用域   |
| ------------ | ---------------------------------------------- | -------- |
| 工作流默认值 | `workflow.json` 中的定义                       | 该工作流 |
| 项目覆盖     | `<data_dir>/harmonia/<project>/overrides.json` | 仅该项目 |

### 完整结构

```typescript
interface OverrideConfig {
  // 审批规则
  review?: boolean | Record<string, boolean>;

  // 角色配置
  roles?: Record<
    string,
    {
      agent?: 'opencode' | 'claude-code' | 'openclaw' | 'codex';
      model?: string;
      capabilities?: Record<
        string,
        {
          type: 'skill' | 'mcp';
          tool: string;
          server?: string; // type 为 'mcp' 时必填
          params?: Record<string, unknown>;
          notes?: string;
        }
      >;
    }
  >;
}
```

### 审批规则（review）

控制哪些产出在 `artifact_write` 后需要用户通过 `artifact_approve` 审批。

| 写法                                             | 含义                       |
| ------------------------------------------------ | -------------------------- |
| `"review": true`                                 | 全局开启——所有产出都需审批 |
| `"review": false`                                | 全局关闭——所有产出无需审批 |
| `"review": { "prd": true, "tech-design": true }` | 按产出类型逐一控制         |

### 角色配置

```json
{
  "roles": {
    "architect": {
      "agent": "claude-code",
      "model": "claude-sonnet-4-20250514"
    }
  }
}
```

直接编辑 `overrides.json` 即可生效。

## 数据目录

Harmonia 的所有项目数据存储在平台特定的数据目录中（通过 @s_s/agent-kit 管理），**不会在项目源码目录中创建任何文件**。

```
<data_dir>/harmonia/
├── registry.json               # 项目注册表
├── .workflows/                 # 自定义工作流目录
│   └── <workflow_name>/
│       ├── workflow.json
│       ├── roles/
│       └── schemas/
├── <project_name>/
│   ├── overrides.json          # 项目级覆盖配置（跨迭代共享）
│   ├── iter-1/                 # 第 1 次迭代
│   │   ├── state.json          # 工作流状态（节点树状态）
│   │   ├── sessions.json       # 会话记录
│   │   ├── dispatches.json     # 调度记录
│   │   ├── reviews.json        # 审批记录
│   │   ├── steps.json          # 产出步骤进度
│   │   └── artifacts/          # 产出文件
│   │       ├── prd.md
│   │       ├── prd.requirements.json
│   │       └── ...
│   ├── iter-2/                 # 第 2 次迭代
│   │   └── ...
│   └── ...
└── <other_project>/
    └── ...
```

## 开发

### 项目结构

```
harmonia/
├── src/
│   ├── index.ts                 # 入口，MCP 服务器 + CLI 路由
│   ├── cli/
│   │   └── setup.ts             # CLI setup 命令
│   ├── core/
│   │   ├── types.ts             # 核心类型定义
│   │   ├── workflow-engine.ts   # 工作流状态机引擎
│   │   ├── workflow-validator.ts # 工作流静态校验
│   │   ├── plugin.ts            # 工作流插件加载系统
│   │   ├── action-registry.ts   # 节点钩子动作注册
│   │   ├── state.ts             # 工作流状态管理
│   │   ├── artifacts.ts         # 产出读写
│   │   ├── schema.ts            # Schema 校验引擎
│   │   ├── steps.ts             # 步骤管理
│   │   ├── dispatch.ts          # 角色调度
│   │   ├── registry.ts          # 项目注册表
│   │   ├── overrides.ts         # 覆盖配置管理
│   │   ├── reviews.ts           # 产出审批
│   │   └── issues.ts            # Issue 管理
│   ├── tools/                   # MCP 工具注册
│   │   ├── engine-helpers.ts    # 引擎集成共享层
│   │   ├── project-init.ts      # project_init
│   │   ├── iteration-start.ts   # iteration_start
│   │   ├── get-project-status.ts # project_status
│   │   ├── get-role-prompt.ts   # role_prompt
│   │   ├── dispatch-role.ts     # role_dispatch
│   │   ├── report-dispatch.ts   # dispatch_report
│   │   ├── artifact-tools.ts    # artifact_write/read/list
│   │   ├── artifact-schema.ts   # artifact_schema
│   │   ├── approve-artifact.ts  # artifact_approve + review_list
│   │   ├── patch-start.ts       # patch_start
│   │   ├── issue-tools.ts       # issue_create/update/list
│   │   └── utils.ts             # 工具共享辅助函数
│   └── setup/                   # 项目初始化设置
│       ├── inject.ts            # 配置注入
│       └── templates.ts         # Coordinator 提示词模板
├── workflows/
│   └── dev/                     # 内置 dev 工作流插件
│       ├── workflow.json        # 节点树定义（v2.0.0）
│       ├── hooks.js             # Hook 入口，导出 createHooks()
│       ├── hooks-content.js     # Hook 共享常量与内容
│       ├── hooks-claude.js      # Claude Code hook 生成器
│       ├── hooks-opencode.js    # OpenCode hook 生成器
│       ├── hooks-openclaw.js    # OpenClaw hook 生成器
│       ├── tools.ts             # 导出 registerActions()（节点钩子动作）
│       ├── roles/               # 角色提示词
│       │   ├── coordinator.md
│       │   ├── architect.md
│       │   ├── developer.md
│       │   └── tester.md
│       └── schemas/             # 产出 + 步骤 Schema（26 个）
└── tests/                       # 测试（20 个文件，334 个测试）
```

### 开发命令

```bash
npm install            # 安装依赖
npm run build          # 构建
npm run dev            # 开发模式（watch）
npm test               # 运行测试
npm run test:watch     # 测试 watch 模式
npm run prettier:fix   # 代码格式化
npm run release        # 发布版本
```

## License

MIT
