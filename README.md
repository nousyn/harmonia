# Harmonia

> _众声喧哗之中，和谐不是沉默，而是各得其所。_

Harmonia 是一个基于 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 的**通用多代理协作框架**。它为 AI 编程助手（Claude Code、OpenCode、OpenClaw、Codex）提供工作流编排工具，让多个 AI agent 在**可插拔的工作流**中按角色协作完成任务。

## 核心理念

- **节点树驱动** — 工作流定义为节点树（sequence / parallel / task / gate / loop），支持条件分支、循环迭代、失败重试、并行执行
- **角色分离** — Coordinator、架构师、开发者、测试各司其职，通过产出（artifact）交接而非直接对话
- **可插拔工作流** — 工作流以插件形式存在，包含节点树定义、角色提示词、产出 Schema、钩子脚本
- **数据隔离** — 所有项目数据存储在平台数据目录，不污染代码仓库
- **被动式引擎** — Core 是决策计算器，通过 `nextAction` 指导 Coordinator 驱动工作流前进

## 特性

- **节点树工作流** — 5 种节点类型（task / sequence / parallel / gate / loop），声明式定义复杂工作流
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

Harmonia 使用**节点树**定义工作流，支持 5 种节点类型：

| 节点类型     | 语义                                                           |
| ------------ | -------------------------------------------------------------- |
| **task**     | 工作单元，分配给某个角色执行                                   |
| **sequence** | 子节点按顺序执行                                               |
| **parallel** | 子节点并行执行，需指定 `failStrategy`（fail-fast / wait-all）  |
| **gate**     | 条件检查节点，pass/fail 两条路径                               |
| **loop**     | 循环节点，重复执行 body 子树直到满足退出条件或达到最大迭代次数 |

工作流通过**插件机制**加载——以目录形式存在，包含 `workflow.json`（节点树 + 产出定义）、角色提示词、产出 Schema 以及可选的钩子/动作模块。内置 `dev` 工作流提供完整的软件开发流程（需求 → 设计 → 开发 → 测试 → 交付），自定义工作流可覆盖或扩展。

> **完整的工作流构建指南**（目录结构、workflow.json 字段详解、角色提示词格式、Schema 系统、钩子与动作扩展、覆盖配置、验证规则、内置 dev 工作流参考等）请参阅：
>
> [docs/workflow-guide.md](docs/workflow-guide.md)

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
│   │   ├── tree-utils.ts        # 节点树遍历纯函数
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
│       ├── hooks/               # Hook 模块
│       │   ├── index.js         #   入口，导出 createHooks()
│       │   ├── content.js       #   Hook 共享常量与内容
│       │   ├── claude.js        #   Claude Code hook 生成器
│       │   ├── opencode.js      #   OpenCode hook 生成器
│       │   └── openclaw.js      #   OpenClaw hook 生成器
│       ├── tools/               # Action 模块
│       │   └── index.js         #   导出 registerActions()（节点钩子动作）
│       ├── roles/               # 角色提示词
│       │   ├── coordinator.md
│       │   ├── architect.md
│       │   ├── developer.md
│       │   └── tester.md
│       └── schemas/             # 产出 + 步骤 Schema（26 个）
└── tests/                       # 测试（21 个文件，416 个测试）
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
