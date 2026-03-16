# Harmonia

> _众声喧哗之中，和谐不是沉默，而是各得其所。_

Multi-agent orchestration MCP server with pluggable workflows.

Harmonia 是一个基于 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 的智能体编排服务器。它为 AI 编程助手（Claude Code、OpenCode、OpenClaw、Codex）提供项目管理工具，让多个 AI agent 在预定义的工作流中按角色协作完成软件开发任务。

## 核心理念

- **角色分离** — PM、架构师、开发者、测试各司其职，通过文档交接而非直接对话
- **流程驱动** — 预定义的阶段和文档类型确保不跳步骤
- **数据隔离** — 所有项目数据存储在平台数据目录（非项目源码目录），不污染代码仓库
- **可插拔工作流** — 工作流定义为 JSON，可扩展自定义

## 特性

### 工作流编排

- 5 个阶段：需求澄清 → 方案设计 → 开发 → 测试 → 交付验收
- 4 个角色：PM / 架构师 / 开发者 / 测试
- 15 种文档类型，按项目规模（small / medium / large）自动调整必选/可选
- 项目规模延迟设定 — PRD 审批后由 PM 设定，设定后不可更改
- 角色调度与报告机制（`role_dispatch` / `dispatch_report`）

### 文档结构校验

对文档内容进行结构化校验，包括 Markdown 标题结构和 JSON 字段/类型验证。每次 `doc_write` 时自动执行，确保产出物符合预期格式。

### 工具访问控制

基于 MCP tool 级别的硬性约束。为每个角色定义允许使用的工具白名单/黑名单，在 agent 层面强制执行，防止角色越权操作。

### 覆盖配置体系（overrides.json）

三层合并的配置覆盖系统，优先级：**项目级 > 全局级 > 工作流默认值**。

```
<data_dir>/harmonia/overrides.json                   # 全局覆盖
<data_dir>/harmonia/<project_name>/overrides.json     # 项目级覆盖
```

支持覆盖的配置项：

- **审批规则** — 控制哪些文档需要审批（review）
  - `review: true` — 全局开启所有文档审批
  - `review: { "prd": true, "tech-design": false }` — 按文档类型逐一配置
  - 通过 `review_set_rule` 工具设置
- **角色配置** — 为每个角色指定 agent 类型和模型
  - `agent` — 执行角色的 agent 类型（opencode / claude-code / openclaw / codex）
  - `model` — 模型覆盖（如使用不同能力级别的模型）
  - 通过 `guard_set` 工具设置
- **能力映射** — 将角色的抽象能力映射到具体工具
  - `capabilities.{capId}` — 指定工具类型（skill / mcp）、工具名、服务器名、静态参数
  - 通过 `guard_set` 工具设置

示例 `overrides.json`：

```json
{
  "review": { "prd": true },
  "roles": {
    "developer": {
      "agent": "opencode",
      "model": "claude-sonnet-4-20250514",
      "capabilities": {
        "read_file": {
          "type": "mcp",
          "tool": "read_file",
          "server": "filesystem"
        }
      }
    }
  }
}
```

### 跨 Agent 边界守卫

为 AI 编程助手安装 hook 脚本，在工具调用前拦截越界操作：

- **Claude Code / Codex** — Shell hook，通过 exit code 阻断
- **OpenCode** — TypeScript plugin hook
- **OpenClaw** — handler.ts hook

同时提供主动提醒机制，在角色提示词中注入当前约束上下文。

### 逐步文档写入

大型文档拆分为多个步骤（steps），每步独立写入并校验。支持：

- 每步独立的 JSON Schema 校验
- 步骤回滚（重写某步时自动清除后续步骤记录）
- `project_status` 中展示步骤进度

## MCP 工具一览

| 工具                | 说明                                               |
| ------------------- | -------------------------------------------------- |
| `project_init`      | 注册项目，创建数据目录，初始化工作流               |
| `project_set_scale` | 设定项目规模（PRD 审批后，不可更改）               |
| `project_status`    | 查看项目状态（无参数返回项目列表，有参数返回详情） |
| `phase_update`      | 推进项目阶段                                       |
| `doc_write`         | 写入文档（自动 schema 校验，支持逐步写入）         |
| `doc_read`          | 读取文档内容                                       |
| `doc_list`          | 列出项目所有文档                                   |
| `doc_approve`       | 审批需要 review 的文档（如 PRD）                   |
| `review_list`       | 列出待审批的文档                                   |
| `review_set_rule`   | 设置审批规则覆盖                                   |
| `role_prompt`       | 获取角色提示词（含约束上下文注入）                 |
| `role_dispatch`     | 调度角色执行任务                                   |
| `dispatch_report`   | 角色报告任务完成状态                               |
| `guard_set`         | 设置角色的工具白名单/黑名单                        |
| `guard_get`         | 查看当前工具约束配置                               |

## 工作流结构

Harmonia 使用声明式工作流定义。内置的 `dev` 工作流（软件开发流程）：

```
clarify (需求澄清)     → PM 产出 PRD、用户故事
    ↓
design (方案设计)       → 架构师产出技术方案、任务拆解
    ↓
develop (开发)          → 开发者按任务拆解编码实现
    ↓
test (测试)             → 测试编写测试、输出测试报告
    ↓
deliver (交付验收)      → PM 验收成果、输出复盘记录
```

每个文档类型可定义 **steps**（步骤），例如 PRD 的写入流程：

1. `requirements` — 需求结构化（JSON）
2. `completeness-check` — 完整性校验（JSON）
3. `draft` — PRD 草稿（Markdown）
4. `final` — PRD 最终版（Markdown）

## 安装

```bash
npm install -g @s_s/harmonia
```

## 快速开始

```bash
harmonia setup --agent openclaw
```

`harmonia setup` 一键完成：

1. 注入 PM 提示词到 agent 配置文件（AGENTS.md / CLAUDE.md）
2. 安装 agent hook 脚本（边界守卫 + 主动提醒）

之后启动你的 AI 编程助手，PM 会自动通过 `project_init` 注册项目，通过 `project_status` 获取项目信息。

### CLI 命令

```
harmonia                启动 MCP stdio 服务器（供 agent 调用）
harmonia setup          初始化 agent 配置（注入提示词 + 安装 hook）
harmonia --help         显示帮助信息
harmonia --version      显示版本号
```

`setup` 选项：

| 选项             | 说明                                                          | 默认值                                                     |
| ---------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| `--agent <type>` | agent 类型：`opencode` / `claude-code` / `codex` / `openclaw` | 建议显式指定。省略时通过 cwd 和 `~` 下的配置文件自动检测。 |

## 配置

将 Harmonia 注册为 MCP 服务器。

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

## 数据存储

Harmonia 的所有项目数据存储在平台特定的数据目录中（通过 [agent-kit](https://github.com/anthropics/agent-kit) 管理），**不会在项目源码目录中创建任何文件**。

数据目录结构：

```
<data_dir>/harmonia/
├── overrides.json              # 全局覆盖配置
├── <project_name>/
│   ├── state.json              # 项目状态（当前阶段、规模等）
│   ├── steps.json              # 文档步骤进度
│   ├── overrides.json          # 项目级覆盖配置
│   ├── docs/                   # 文档产出物
│   │   ├── prd.md
│   │   ├── prd.requirements.json    # 步骤产出物
│   │   ├── tech-design.md
│   │   └── ...
│   ├── reviews/                # 审批记录
│   └── dispatch/               # 调度记录
└── <other_project>/
    └── ...
```

## 项目结构

```
harmonia/
├── src/
│   ├── index.ts              # 入口，注册所有 MCP 工具
│   ├── cli/
│   │   └── setup.ts          # CLI setup 命令
│   ├── core/
│   │   ├── types.ts          # 核心类型定义
│   │   ├── state.ts          # 项目状态管理
│   │   ├── docs.ts           # 文档读写
│   │   ├── schema.ts         # P0 Schema 校验引擎
│   │   ├── steps.ts          # P3 步骤管理
│   │   ├── dispatch.ts       # 角色调度
│   │   ├── registry.ts       # 项目注册表
│   │   ├── workflow.ts       # 工作流加载
│   │   ├── overrides.ts      # 工具约束管理
│   │   └── reviews.ts        # 文档审批
│   ├── tools/                # 11 个 MCP 工具注册
│   ├── hooks/                # P2 Agent Hook 系统
│   │   ├── content.ts        # Hook 内容生成
│   │   ├── install.ts        # Hook 安装逻辑
│   │   ├── claude-code.ts    # Claude Code hook 适配
│   │   ├── opencode.ts       # OpenCode hook 适配
│   │   └── openclaw.ts       # OpenClaw hook 适配
│   └── setup/                # 项目初始化设置
│       ├── inject.ts         # 配置注入
│       └── templates.ts      # 模板管理
├── workflows/
│   └── dev/
│       ├── workflow.json     # 工作流定义
│       ├── roles/            # 角色提示词 (pm.md, architect.md, ...)
│       └── schemas/          # 文档 + 步骤 Schema
├── tests/                    # 测试 (260 tests, 13 files)
└── .dev-logs/                # 开发日志
```

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 开发模式（watch）
npm run dev

# 运行测试
npm test

# 运行测试（watch 模式）
npm run test:watch

# 代码格式化
npm run prettier:fix
```

## 自定义工作流

通过设置环境变量 `HARMONIA_WORKFLOWS_DIR` 指向自定义工作流目录：

```bash
HARMONIA_WORKFLOWS_DIR=/path/to/workflows npx @s_s/harmonia
```

工作流目录结构需符合：

```
<workflow_name>/
├── workflow.json      # 工作流定义（阶段、角色、文档类型）
├── roles/             # 角色提示词
│   ├── pm.md
│   └── ...
└── schemas/           # 文档 Schema（可选）
    ├── prd.json
    ├── prd.requirements.json   # 步骤 Schema
    └── ...
```

## License

MIT
