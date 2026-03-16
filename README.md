# Harmonia

> 多智能体编排 MCP 服务器 — 让不同角色和谐协作

Harmonia 是一个基于 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 的多智能体编排服务器。它为 AI 编程助手（Claude Code、OpenCode、OpenClaw 等）提供项目管理工具，让多个 AI agent 在预定义的工作流中按角色协作完成软件开发任务。

## 核心理念

- **角色分离** — PM、架构师、开发者、测试各司其职，通过文档交接而非直接对话
- **流程驱动** — 预定义的阶段和文档类型确保不跳步骤
- **数据隔离** — 所有项目数据存储在平台数据目录（非项目源码目录），不污染代码仓库
- **可插拔工作流** — 工作流定义为 JSON，可扩展自定义

## 特性

### 工作流编排

- 5 个阶段：需求澄清 → 方案设计 → 开发 → 测试 → 交付验收
- 4 个角色：PM / 架构师 / 开发者 / 测试
- 15 种文档类型，按项目规模（small / medium / large）自动调整
- 角色调度与报告机制（`dispatch_role` / `report_dispatch`）

### P0 — 文档 Schema 校验

对文档内容进行结构化校验，包括 Markdown 标题结构和 JSON 字段/类型验证。每次 `write_doc` 时自动执行，确保产出物符合预期格式。

### P1 — Tool Guard（工具约束）

基于 MCP tool 级别的硬性约束。通过 `override_tools` 为每个角色定义允许使用的工具白名单/黑名单，在 agent 层面强制执行。

### P2 — Agent Hook（边界守卫）

为 AI 编程助手安装 hook 脚本，在工具调用前拦截越界操作：

- **Claude Code** — Shell hook，通过 exit code 阻断
- **OpenCode** — TypeScript plugin hook
- **OpenClaw** — handler.ts hook

同时提供主动提醒机制，在角色提示词中注入当前约束上下文。

### P3 — Sequential Mode（逐步写入）

大型文档拆分为多个步骤（steps），每步独立写入并校验。支持：

- 每步独立的 JSON Schema 校验
- 步骤回滚（重写某步时自动清除后续步骤记录）
- `get_project_status` 中展示步骤进度

## MCP 工具一览

| 工具                 | 说明                                       |
| -------------------- | ------------------------------------------ |
| `project_init`       | 注册项目，创建数据目录，初始化工作流       |
| `get_project_status` | 查看当前阶段、文档状态、步骤进度           |
| `get_role_prompt`    | 获取角色提示词（含约束上下文注入）         |
| `update_phase`       | 推进项目阶段                               |
| `write_doc`          | 写入文档（自动 schema 校验，支持逐步写入） |
| `read_doc`           | 读取文档内容                               |
| `list_docs`          | 列出项目所有文档                           |
| `approve_doc`        | 审批需要 review 的文档（如 PRD）           |
| `dispatch_role`      | 调度角色执行任务                           |
| `report_dispatch`    | 角色报告任务完成状态                       |
| `override_tools`     | 设置角色的工具白名单/黑名单                |
| `setup_project`      | 为 AI 编程助手安装 hook 脚本               |

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
npm install @s_s/harmonia
```

## 配置

在你的 AI 编程助手中将 Harmonia 注册为 MCP 服务器：

### Claude Code

```json
// .mcp.json
{
  "mcpServers": {
    "harmonia": {
      "command": "npx",
      "args": ["@s_s/harmonia"]
    }
  }
}
```

### OpenCode

```yaml
# opencode.json
{ 'mcp': { 'harmonia': { 'type': 'stdio', 'command': 'npx', 'args': ['@s_s/harmonia'] } } }
```

## 数据存储

Harmonia 的所有项目数据存储在平台特定的数据目录中（通过 [agent-kit](https://github.com/anthropics/agent-kit) 管理），**不会在项目源码目录中创建任何文件**。

数据目录结构：

```
<data_dir>/harmonia/<project_name>/
├── state.json          # 项目状态（当前阶段、规模等）
├── steps.json          # 文档步骤进度
├── docs/               # 文档产出物
│   ├── prd.md
│   ├── prd.requirements.json    # 步骤产出物
│   ├── tech-design.md
│   └── ...
├── reviews/            # 审批记录
├── dispatch/           # 调度记录
└── overrides/          # 工具约束配置
```

## 项目结构

```
harmonia/
├── src/
│   ├── index.ts              # 入口，注册所有 MCP 工具
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
│   ├── tools/                # 10 个 MCP 工具注册
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
├── tests/                    # 测试 (243 tests, 12 files)
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
