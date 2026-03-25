# Harmonia

> _众声喧哗之中，和谐不是沉默，而是各得其所。_

Harmonia 是一个**独立的多代理编排器**（Orchestrator），通过 HTTP API 协调多个 AI 编程助手（OpenCode、Claude Code、OpenClaw、Codex）在可插拔的工作流中按角色协作完成任务。

## 核心理念

- **独立编排器** — Harmonia 作为独立 HTTP 服务运行，主动调度 Agent 执行任务，而非被动等待调用
- **节点树驱动** — 工作流定义为节点树（sequence / parallel / task / gate / loop），支持条件分支、循环迭代、失败重试、并行执行
- **角色分离** — Coordinator、架构师、开发者、测试各司其职，通过产出（artifact）交接而非直接对话
- **适配器架构** — 统一的 AgentAdapter 接口屏蔽不同 Agent CLI 的差异，支持 dispatch、pushMessage、状态检查
- **可插拔工作流** — 工作流以插件形式存在，包含节点树定义、角色提示词、产出 Schema、钩子脚本

## 特性

- **HTTP API** — RESTful 端点，管理项目、迭代、产出、审批、Issue
- **Agent 适配器** — 内置 OpenCode、Claude Code、OpenClaw、Codex 四种适配器
- **节点树工作流** — 5 种节点类型（task / sequence / parallel / gate / loop），声明式定义复杂工作流
- **主动调度** — Orchestrator 根据工作流状态自动 dispatch 任务到合适的 Agent
- **Gate 条件引擎** — 支持 `artifact_exists`、`artifact_approved`、`artifact_field` 三种条件，自动评估
- **产出系统** — 通用的读写 / 审批机制，Schema 校验，逐步写入支持
- **迭代管理** — 同一项目支持多次迭代，每次迭代独立的状态和产出
- **PromptBuilder** — 自动组装角色 prompt，包含任务描述、输入产出引用、输出路径、Schema 指引
- **事件驱动** — EventBus 统一事件传播，结构化 JSON 日志记录所有操作

## 架构概览

```
┌──────────────────────────────────────────────────┐
│  Harmonia Orchestrator（HTTP Server）               │
│  ┌────────────┐  ┌───────────────┐               │
│  │ Workflow    │  │ Dispatch      │               │
│  │ Engine      │  │ Manager       │               │
│  ├────────────┤  ├───────────────┤               │
│  │ Prompt      │  │ Adapter       │               │
│  │ Builder     │  │ Registry      │               │
│  ├────────────┤  ├───────────────┤               │
│  │ EventBus   │  │ Operations    │               │
│  └────────────┘  └───────────────┘               │
│         │ dispatch / pushMessage                  │
│         ▼                                         │
│  ┌────────────────────────────────────────────┐  │
│  │ Agent Adapters                              │  │
│  │ ┌──────────┐ ┌──────────┐ ┌──────────────┐│  │
│  │ │ opencode │ │claude    │ │ openclaw     ││  │
│  │ │          │ │code      │ │              ││  │
│  │ ├──────────┤ ├──────────┤ ├──────────────┤│  │
│  │ │ codex    │ │ ...      │ │              ││  │
│  │ └──────────┘ └──────────┘ └──────────────┘│  │
│  └────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────┤
│  Workflow Plugin（如 dev）                         │
│  ┌──────────┐ ┌──────┐ ┌───────┐ ┌───────┐      │
│  │workflow  │ │roles/│ │schemas│ │hooks  │      │
│  │.json     │ │*.md  │ │/*.json│ │.js    │      │
│  └──────────┘ └──────┘ └───────┘ └───────┘      │
└──────────────────────────────────────────────────┘
         │                    │
         ▼                    ▼
  ┌─────────────┐    ┌──────────────┐
  │ Agent CLI    │    │ Agent CLI    │
  │ (opencode)   │    │ (claude code)│
  └─────────────┘    └──────────────┘
```

**核心交互循环：**

1. Harmonia 启动后加载工作流，根据节点树状态计算 `nextAction`
2. Orchestrator 通过 Agent Adapter 将任务 dispatch 到对应的 Agent CLI
3. Agent 执行任务，产出写入文件系统，Harmonia 验证产出
4. 节点完成/失败事件驱动工作流状态推进
5. Orchestrator 通过 `pushMessage` 向 Coordinator Agent 推送状态更新

## 快速开始

### 安装

```bash
npm install -g @s_s/harmonia
```

### 启动服务

```bash
harmonia serve                     # 默认 127.0.0.1:4600
harmonia serve --port 8080         # 自定义端口
harmonia serve --host 0.0.0.0      # 允许外部访问
```

### CLI 注册项目

```bash
harmonia setup my-project --dir /path/to/project --workflow dev
```

### CLI 命令

```
harmonia serve                     启动 HTTP API 服务器
harmonia setup <name>              注册项目
harmonia unregister <name>         注销项目（默认同时删除数据目录）
harmonia --help                    显示帮助信息
harmonia --version                 显示版本号
```

| 命令         | 选项                                | 说明                                                     |
| ------------ | ----------------------------------- | -------------------------------------------------------- |
| `serve`      | `--port <N>`, `--host <addr>`       | HTTP 服务器端口（默认 4600）和主机地址（默认 127.0.0.1） |
| `setup`      | `--dir <path>`, `--workflow <name>` | 项目目录和工作流名称                                     |
| `unregister` | `--keep-data`                       | 仅移除注册表条目，保留项目数据目录。默认同时删除数据目录 |

## HTTP API

### 项目管理

| 方法   | 路径                         | 说明                                                              |
| ------ | ---------------------------- | ----------------------------------------------------------------- |
| `GET`  | `/projects`                  | 列出所有已注册项目                                                |
| `POST` | `/projects`                  | 初始化新项目（需 `project_name`, `project_dir`, 可选 `workflow`） |
| `GET`  | `/projects/:name/status`     | 获取项目状态（当前迭代、工作流进度、nextAction）                  |
| `POST` | `/projects/:name/iterations` | 开始新迭代（可选 `force`）                                        |
| `POST` | `/projects/:name/patches`    | 开始热修复（需 `description`, 可选 `issue_id`）                   |

### 产出与审批

| 方法   | 路径                                    | 说明                                           |
| ------ | --------------------------------------- | ---------------------------------------------- |
| `GET`  | `/projects/:name/artifacts`             | 列出产出（可选 `context` 查询参数）            |
| `GET`  | `/projects/:name/artifacts/:id`         | 读取指定产出内容                               |
| `POST` | `/projects/:name/artifacts/:id/approve` | 审批/拒绝产出（需 `approved`，可选 `comment`） |
| `GET`  | `/projects/:name/artifacts/:id/schema`  | 获取产出 Schema 信息                           |
| `GET`  | `/projects/:name/reviews`               | 列出待审批产出                                 |

### Issue 追踪

| 方法    | 路径                         | 说明                                                           |
| ------- | ---------------------------- | -------------------------------------------------------------- |
| `GET`   | `/projects/:name/issues`     | 列出 Issue（可选过滤：`status`, `source`, `iteration`）        |
| `POST`  | `/projects/:name/issues`     | 创建 Issue（需 `title`, `description`, `source`, `iteration`） |
| `PATCH` | `/projects/:name/issues/:id` | 更新 Issue 状态                                                |

### Agent 连接

| 方法     | 路径           | 说明                                                                   |
| -------- | -------------- | ---------------------------------------------------------------------- |
| `POST`   | `/connect`     | Agent 注册连接（需 `project_name`, `agent`；可选 `sessionId`, `role`） |
| `DELETE` | `/connect/:id` | Agent 断开连接（需 `project_name` 查询参数）                           |

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

## Agent 适配器

Harmonia 通过统一的 `AgentAdapter` 接口对接不同的 AI 编程助手：

```typescript
interface AgentAdapter {
  dispatchTask(payload: TaskPayload): Promise<TaskResult>;
  pushMessage?(message: string): Promise<void>;
  checkStatus(): Promise<AgentStatus>;
  terminate(): Promise<void>;
}
```

内置适配器：

| 适配器        | Agent       | 说明                               |
| ------------- | ----------- | ---------------------------------- |
| `opencode`    | OpenCode    | CLI 适配器                         |
| `claude-code` | Claude Code | CLI 适配器，支持 `--system-prompt` |
| `openclaw`    | OpenClaw    | Gateway RPC 适配器                 |
| `codex`       | Codex       | CLI 适配器                         |

适配器通过 `AdapterRegistry` 注册和管理，支持扩展自定义适配器。

## 数据目录

Harmonia 的所有项目数据存储在平台特定的数据目录中（通过 @s_s/agent-kit 管理），**不会在项目源码目录中创建任何文件**（代码产出除外）。

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
│   ├── index.ts                 # 入口，HTTP 服务器 + CLI 路由
│   ├── cli/
│   │   └── setup.ts             # CLI setup 命令
│   ├── api/
│   │   └── routes.ts            # HTTP API 路由定义（Hono）
│   ├── core/
│   │   ├── types.ts             # 核心类型定义
│   │   ├── orchestrator.ts      # Orchestrator — 工作流执行指挥者
│   │   ├── workflow-engine.ts   # 工作流状态机引擎
│   │   ├── workflow-validator.ts # 工作流静态校验
│   │   ├── tree-utils.ts        # 节点树遍历纯函数
│   │   ├── prompt-builder.ts    # Prompt 组装（角色 + 任务 + 产出引用）
│   │   ├── plugin.ts            # 工作流插件加载系统
│   │   ├── action-registry.ts   # 节点钩子动作注册
│   │   ├── state.ts             # 工作流状态管理
│   │   ├── dispatch.ts          # 调度记录 CRUD + DispatchManager
│   │   ├── operations/          # 编排层操作
│   │   │   ├── types.ts         #   错误类型定义
│   │   │   ├── project-lifecycle.ts  # initProject / beginIteration / beginPatch
│   │   │   ├── artifact-ops.ts  #   产出读写 / 审批 / Schema 查询
│   │   │   ├── status.ts        #   项目状态 / 项目列表
│   │   │   └── index.ts         #   桶文件
│   │   ├── artifacts.ts         # 产出读写（底层）
│   │   ├── schema.ts            # Schema 校验引擎
│   │   ├── steps.ts             # 步骤管理
│   │   ├── registry.ts          # 项目注册表
│   │   ├── overrides.ts         # 覆盖配置管理
│   │   ├── reviews.ts           # 产出审批
│   │   └── issues.ts            # Issue 管理
│   ├── adapters/                # Agent 适配器
│   │   ├── types.ts             #   AgentAdapter 接口定义
│   │   ├── opencode.ts          #   OpenCode 适配器
│   │   ├── claude-code.ts       #   Claude Code 适配器
│   │   ├── openclaw.ts          #   OpenClaw 适配器
│   │   └── codex.ts             #   Codex 适配器
│   └── setup/                   # 项目初始化设置
│       ├── inject.ts            # 配置注入
│       └── templates.ts         # Coordinator 提示词模板
├── workflows/
│   └── dev/                     # 内置 dev 工作流插件
│       ├── workflow.json        # 节点树定义（v2.0.0）
│       ├── hooks/               # Hook 模块
│       ├── tools/               # Action 模块
│       ├── roles/               # 角色提示词（coordinator / architect / developer / tester）
│       └── schemas/             # 产出 + 步骤 Schema
└── tests/                       # 测试
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
