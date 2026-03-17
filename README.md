# Harmonia

> _众声喧哗之中，和谐不是沉默，而是各得其所。_

Harmonia 是一个基于 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 的智能体编排服务器。它为 AI 编程助手（Claude Code、OpenCode、OpenClaw、Codex）提供项目管理工具，让多个 AI agent 在预定义的工作流中按角色协作完成软件开发任务。

## 核心理念

- **角色分离** — PM、架构师、开发者、测试各司其职，通过文档交接而非直接对话
- **流程驱动** — 预定义的阶段和文档类型确保不跳步骤
- **数据隔离** — 所有项目数据存储在平台数据目录（非项目源码目录），不污染代码仓库
- **可插拔工作流** — 工作流定义为 JSON，可扩展自定义

## 特性

- **工作流编排** — 5 阶段、4 角色、15 种文档类型，按项目规模自动调整
- **迭代管理** — 同一项目支持多次迭代，每次迭代独立的状态和文档
- **文档结构校验** — Markdown 标题结构和 JSON 字段/类型自动校验
- **逐步文档写入** — 大型文档拆分为多步，每步独立校验，支持步骤回滚
- **覆盖配置** — 三层合并的配置系统，灵活控制审批规则、角色绑定、能力映射
- **跨 Agent 边界守卫** — hook 脚本拦截越权操作 + 角色提示词注入约束上下文
- **工具访问控制** — 基于 MCP tool 级别的角色白名单/黑名单

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

1. 注入 PM 提示词到 agent 配置文件（AGENTS.md / CLAUDE.md）
2. 安装 agent hook 脚本（边界守卫 + 主动提醒）

之后启动你的 AI 编程助手，PM 会自动通过 `project_init` 注册项目，通过 `project_status` 获取项目信息。

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

| 工具                | 说明                                               |
| ------------------- | -------------------------------------------------- |
| `project_init`      | 注册项目，创建数据目录，初始化工作流               |
| `iteration_start`   | 开始新迭代（创建 iter-N 目录，重置阶段状态）       |
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
| `guard_set`         | 设置角色的 agent/model/能力覆盖                    |
| `guard_get`         | 查看当前覆盖配置                                   |

## 工作流

### 阶段与角色

Harmonia 使用声明式工作流定义。内置的 `dev` 工作流（软件开发流程）包含 5 个阶段和 4 个角色：

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

| 角色   | 说明                                   | 默认模型 | 并行 |
| ------ | -------------------------------------- | -------- | ---- |
| PM     | 需求澄清、文档撰写、任务分派、验收交付 | medium   | 否   |
| 架构师 | 代码分析、技术方案、任务拆解           | strong   | 否   |
| 开发者 | 编码实现、单元测试、代码质量           | medium   | 是   |
| 测试   | 测试计划、测试执行、测试报告           | medium   | 否   |

### 文档类型

`dev` 工作流定义了 15 种文档类型。每种文档按项目规模（small / medium / large）有不同的要求等级：

| 文档 ID           | 名称                | 阶段    | 规模行为 (S/M/L)       | 默认审批 |
| ----------------- | ------------------- | ------- | ---------------------- | -------- |
| `prd`             | 需求文档            | clarify | full / full / full     | **是**   |
| `user-stories`    | 用户故事 + 验收标准 | clarify | full / full / full     | 否       |
| `fsd`             | 功能规格            | clarify | skip / full / full     | 否       |
| `prototype`       | 高保真原型          | clarify | skip / optional / full | **是**   |
| `project-plan`    | 项目计划            | clarify | skip / optional / full | 否       |
| `tech-design`     | 技术方案            | design  | lite / full / full     | 否       |
| `data-model`      | 数据模型设计        | design  | skip / optional / full | 否       |
| `api-design`      | API 设计            | design  | skip / optional / full | 否       |
| `task-breakdown`  | 任务拆解            | design  | full / full / full     | 否       |
| `risk-assessment` | 技术风险评估        | design  | skip / skip / full     | 否       |
| `code`            | 代码实现            | develop | full / full / full     | 否       |
| `test-plan`       | 测试计划            | test    | skip / full / full     | 否       |
| `test-report`     | 测试报告            | test    | full / full / full     | 否       |
| `deploy`          | 部署文档            | deliver | skip / skip / optional | 否       |
| `retrospective`   | 复盘记录            | deliver | full / full / full     | 否       |

> **规模行为说明**：`full` = 必须产出；`lite` = 简化版；`optional` = 可选产出；`skip` = 跳过

项目规模在 PRD 审批后由 PM 通过 `project_set_scale` 设定，设定后不可更改。

### 逐步文档写入

大型文档可拆分为多个步骤（steps），每步独立写入并校验：

- 每步有独立的 JSON Schema 校验
- 重写某步时自动清除后续步骤记录
- `project_status` 中展示步骤进度

例如 PRD 的写入流程：

1. `requirements` — 需求结构化（JSON）
2. `completeness-check` — 完整性校验（JSON）
3. `draft` — PRD 草稿（Markdown）
4. `final` — PRD 最终版（Markdown）

### 自定义工作流

Harmonia 使用两层工作流查找机制：

1. **自定义目录**（高优先级）：`<data_dir>/harmonia/.workflows/<name>/`
2. **内置目录**（回退）：`<package>/workflows/<name>/`

自定义工作流会覆盖同名的内置工作流。内置工作流随包版本自动更新，零维护。

在全局数据目录下创建 `.workflows/<name>/` 目录：

```
<data_dir>/harmonia/.workflows/
└── my-workflow/
    ├── workflow.json      # 工作流定义（阶段、角色、文档类型）
    ├── roles/             # 角色提示词
    │   ├── pm.md
    │   └── ...
    └── schemas/           # 文档 Schema（可选）
        ├── prd.json
        ├── prd.requirements.json   # 步骤 Schema
        └── ...
```

`workflow.json` 格式：

```json
{
  "name": "my-workflow",
  "description": "自定义工作流描述",
  "version": "1.0.0",
  "author": "your-name",
  "phases": [ ... ],
  "docs": { ... }
}
```

可参考内置 `dev` 工作流（`node_modules/@s_s/harmonia/workflows/dev/`）作为模板。

工作流选择规则：

- 只有一个可用工作流时自动选中
- 多个可用工作流时，需在 `project_init` 中指定 `workflow` 参数

## 覆盖配置

Harmonia 提供三层合并的配置覆盖系统，让你无需修改工作流定义即可自定义行为。

### 合并优先级

```
项目级 overrides.json  >  全局 overrides.json  >  工作流默认值
```

| 层级         | 文件位置                                       | 作用域                 |
| ------------ | ---------------------------------------------- | ---------------------- |
| 工作流默认值 | `workflow.json` 中的定义                       | 所有使用该工作流的项目 |
| 全局覆盖     | `<data_dir>/harmonia/overrides.json`           | 所有项目               |
| 项目覆盖     | `<data_dir>/harmonia/<project>/overrides.json` | 仅该项目（跨迭代共享） |

项目级覆盖只需要写你想改的字段，未设置的字段自动回退到全局覆盖，再回退到工作流默认值。

### 完整结构

```typescript
// overrides.json 的完整类型定义
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

完整示例：

```json
{
  "review": {
    "prd": true,
    "tech-design": true,
    "prototype": false
  },
  "roles": {
    "architect": {
      "agent": "claude-code",
      "model": "claude-sonnet-4-20250514"
    },
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

### 审批规则（review）

控制哪些文档在 `doc_write` 后需要用户通过 `doc_approve` 审批。

三种配置方式：

| 写法                                             | 含义                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| `"review": true`                                 | 全局开启——所有文档写入后都需要审批                                     |
| `"review": false`                                | 全局关闭——所有文档写入后无需审批                                       |
| `"review": { "prd": true, "tech-design": true }` | 按文档类型逐一控制——只有指定为 `true` 的需要审批，未列出的回退到下一层 |

`dev` 工作流默认审批的文档：

| 文档        | 默认 review |
| ----------- | ----------- |
| `prd`       | `true`      |
| `prototype` | `true`      |
| 其余 13 种  | `false`     |

通过 `review_set_rule` 工具设置，或直接编辑 `overrides.json`。

### 角色配置（agent / model）

为角色指定执行的 agent 类型和模型：

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

- `agent` — 执行该角色的 AI 编程助手类型
- `model` — 覆盖角色的默认模型（角色提示词 frontmatter 中定义了默认模型等级：`strong` / `medium`）

通过 `guard_set` 工具设置，或直接编辑 `overrides.json`。

### 能力映射（capabilities）

角色提示词中声明了该角色需要的抽象能力（如"读取文件"、"分析代码库"），能力映射将这些抽象能力绑定到具体的工具实现。

`dev` 工作流各角色的能力：

<details>
<summary><strong>PM</strong>（10 个能力）</summary>

| 能力 ID                | 描述                       |
| ---------------------- | -------------------------- |
| `clarify-requirements` | 与用户沟通，理解和澄清需求 |
| `assess-scale`         | 评估项目规模               |
| `write-prd`            | 撰写需求文档               |
| `write-user-stories`   | 撰写用户故事和验收标准     |
| `write-fsd`            | 撰写功能规格文档           |
| `write-prototype`      | 创建高保真 HTML 原型       |
| `write-project-plan`   | 撰写项目计划               |
| `dispatch-tasks`       | 将任务分派给开发者         |
| `track-progress`       | 跟踪项目进度和阶段状态     |
| `accept-deliver`       | 验收成果并输出复盘记录     |

</details>

<details>
<summary><strong>架构师</strong>（6 个能力）</summary>

| 能力 ID                 | 描述                 |
| ----------------------- | -------------------- |
| `analyze-codebase`      | 阅读理解现有代码结构 |
| `write-tech-design`     | 撰写技术方案文档     |
| `write-data-model`      | 设计数据模型         |
| `write-api-design`      | 设计 API 接口        |
| `write-task-breakdown`  | 拆解开发任务         |
| `write-risk-assessment` | 评估技术风险         |

</details>

<details>
<summary><strong>开发者</strong>（3 个能力）</summary>

| 能力 ID            | 描述                                 |
| ------------------ | ------------------------------------ |
| `implement-code`   | 按任务拆解编码实现功能               |
| `write-unit-tests` | 为关键逻辑编写单元测试               |
| `ensure-quality`   | 代码质量保障（lint、类型检查、规范） |

</details>

<details>
<summary><strong>测试</strong>（3 个能力）</summary>

| 能力 ID             | 描述               |
| ------------------- | ------------------ |
| `write-test-plan`   | 撰写测试计划       |
| `execute-tests`     | 编写并执行测试用例 |
| `write-test-report` | 撰写测试报告       |

</details>

配置示例——将架构师的"分析代码库"能力绑定到 MCP filesystem 工具：

```json
{
  "roles": {
    "architect": {
      "capabilities": {
        "analyze-codebase": {
          "type": "mcp",
          "tool": "read_file",
          "server": "filesystem",
          "notes": "用于读取项目源码文件"
        }
      }
    }
  }
}
```

通过 `guard_set` 工具设置，或直接编辑 `overrides.json`。

## 数据目录

Harmonia 的所有项目数据存储在平台特定的数据目录中（通过 [agent-kit](https://github.com/anthropics/agent-kit) 管理），**不会在项目源码目录中创建任何文件**。

```
<data_dir>/harmonia/
├── registry.json               # 项目注册表
├── overrides.json              # 全局覆盖配置
├── .workflows/                 # 自定义工作流目录
│   └── <workflow_name>/
│       ├── workflow.json
│       ├── roles/
│       └── schemas/
├── <project_name>/
│   ├── overrides.json          # 项目级覆盖配置（跨迭代共享）
│   ├── iter-1/                 # 第 1 次迭代
│   │   ├── state.json          # 项目状态（当前阶段、规模等）
│   │   ├── sessions.json       # 会话记录
│   │   ├── dispatches.json     # 调度记录
│   │   ├── reviews.json        # 审批记录
│   │   ├── steps.json          # 文档步骤进度
│   │   └── docs/               # 文档产出物
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
│   ├── index.ts              # 入口，注册所有 MCP 工具
│   ├── cli/
│   │   └── setup.ts          # CLI setup 命令
│   ├── core/
│   │   ├── types.ts          # 核心类型定义
│   │   ├── state.ts          # 项目状态管理
│   │   ├── docs.ts           # 文档读写
│   │   ├── schema.ts         # Schema 校验引擎
│   │   ├── steps.ts          # 步骤管理
│   │   ├── dispatch.ts       # 角色调度
│   │   ├── registry.ts       # 项目注册表
│   │   ├── workflow.ts       # 工作流加载
│   │   ├── overrides.ts      # 覆盖配置管理
│   │   └── reviews.ts        # 文档审批
│   ├── tools/                # MCP 工具注册
│   ├── hooks/                # Agent Hook 系统
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
└── tests/                    # 测试
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
