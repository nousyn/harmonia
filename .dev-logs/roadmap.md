Roadmap

---

# Superpowers vs Harmonia 对比分析

> 日期: 2026-03-17
> 参考: https://github.com/obra/superpowers (88k stars)

## 本质区别

| 维度         | Superpowers                          | Harmonia                                       |
| ------------ | ------------------------------------ | ---------------------------------------------- |
| **定位**     | Prompt 注入框架（纯文本技能包）      | MCP Server（结构化工具 + 状态管理）            |
| **实现**     | Markdown 文件 + Shell 脚本，零代码   | TypeScript 服务，提供 MCP tools                |
| **安装**     | 注入到 agent 的 system prompt 中     | 作为 MCP server 运行，agent 调用 tools         |
| **状态**     | 无状态（依赖 git + 文件系统）        | 有状态（JSON 持久化：项目、dispatch、session） |
| **多 agent** | agent 自己决定何时启动子代理         | PM 通过 dispatch_role 工具协调                 |
| **触发**     | Skill 自动触发（prompt 指令 + hook） | 工具需 PM 主动调用（prompt 引导）              |

## Superpowers 核心工作流

```
using-superpowers (元技能，路由入口，每次会话自动加载)
    → brainstorming (构思设计，硬门控：设计批准前不写代码)
        → writing-plans (编写实施计划，极细粒度任务 2-5 分钟/步)
            → subagent-driven-development (首选) 或 executing-plans (退路)
                → requesting-code-review (两阶段：spec 合规 + 代码质量)
                    → finishing-a-development-branch (收尾)

横切关注点：
  - test-driven-development (RED-GREEN-REFACTOR 铁律，贯穿所有实现)
  - dispatching-parallel-agents (并行解决独立问题)
```

## 关键设计亮点

### 1. Session Start Hook — 上下文自动注入

- `hooks/session-start` 在每次会话开始时（包括 resume/clear/compact）自动注入 `using-superpowers` skill
- 这个 skill 包含完整的技能路由决策流程图，agent 据此自动判断应激活哪个 skill
- **Harmonia 差距：** PM 新会话无法自动恢复项目上下文

### 2. 两阶段代码审查

- 每个任务完成后先派 spec-reviewer（规格合规），再派 code-quality-reviewer（代码质量）
- **Harmonia 差距：** approve-doc 只做单轮审批

### 3. 子代理上下文隔离

- 子代理永远不继承控制器会话上下文，由控制器精确构造所需信息
- **Harmonia 已有：** dispatch_role 返回精心构造的 data package，理念一致

### 4. 防 AI 走捷径的"红旗思维"检测

- 多个 skill 中列出"AI 会找的借口"对照表，系统性阻止偷懒
- **Harmonia 差距：** PM prompt 有流程引导但无反合理化防护

### 5. Skill 的自动触发机制

- using-superpowers 元技能强制加载后，agent 根据上下文自动激活 skill
- 不是"建议"而是"必须"——"哪怕只有 1% 的可能性某技能适用，就必须调用它"
- **Harmonia 差距：** 工具需 PM 主动调用，仅有 prompt 引导

### 6. 模型选择策略（subagent-driven-development）

- 机械性任务 → 便宜/快速模型
- 集成和判断型任务 → 标准模型
- 架构、设计、审查 → 最强模型
- **Harmonia 已有：** role frontmatter 中的 model 字段（high/medium/low）

## Harmonia 的优势

- **结构化状态管理：** 项目、阶段、文档、dispatch、session 的完整追踪，Superpowers 完全没有
- **MCP 工具接口：** 标准化的工具协议，不依赖特定 agent 平台的 prompt 注入能力
- **多 agent 协调：** 真正的 PM 协调机制，而非 agent 自行决定
- **平台无关：** MCP 协议支持任何 MCP 客户端，不需要为每个平台写适配层

## 对 Harmonia 的启发总结

| 优先级 | 启发点                        | 建议                                                     |
| ------ | ----------------------------- | -------------------------------------------------------- |
| **高** | Session 恢复 / 上下文自动注入 | 实现 session-start 机制，自动恢复项目状态                |
| **中** | 防 AI 合理化的 prompt 防护    | 在 PM prompt 和角色 prompt 中加入红旗思维检测            |
| **中** | 两阶段审查                    | 考虑在 workflow 定义中支持多轮审批                       |
| **低** | Skill 自动触发                | Harmonia 通过 MCP tools 已有显式调用，自动触发的需求不强 |

---

# 协作机制自定义

> 状态: 规划（未开始）
> 日期: 2026-03-17

## 核心洞察

Harmonia 的本质是一套**协作机制**，而非仅仅是工作流引擎。当前内置的是一套"软件开发协作流程"，但协作的**内容**应该可以被整体自定义。

自定义不应局限于 workflow，而是包含完整的协作要素：

| 要素     | 说明                             | 当前位置                 |
| -------- | -------------------------------- | ------------------------ |
| Workflow | 阶段定义、文档体系、角色分配     | `workflows/<name>/`      |
| Prompts  | setup 注入的 PM prompt、角色引导 | `src/setup/templates.ts` |
| Hooks    | 阶段转换钩子、文档审批钩子       | `src/hooks/`             |

## 当前状态

- Plan 022 实现了两层 workflow 查找（内置 + 自定义目录 `.workflows/`）
- 但 prompts 和 hooks 仍然是硬编码的，无法随 workflow 自定义
- 全局数据目录下的 `.workflows/` 命名只覆盖了 workflow 一个维度

## 架构方向

### 统一的自定义机制

全局目录下不应该只有 `.workflows/`，而应该是一套完整的可自定义协作包：

```
<data_dir>/
  .协作包名/           # 一个完整的协作定义
    workflow.json      # 阶段、文档、角色
    prompts/           # PM prompt、角色引导等模板
    hooks/             # 自定义钩子脚本
```

或者更扁平的方式：

```
<data_dir>/
  .workflows/<name>/workflow.json
  .prompts/<name>/pm-guide.md
  .hooks/<name>/on-phase-change.ts
```

具体目录结构待设计。

### 内置 vs 自定义

沿用 Plan 022 的两层查找模式：

- 内置（package 内）：随 npm 更新，不可修改
- 自定义（数据目录）：用户创建，优先级更高

### 多 Workflow 场景

未来可能的协作流程类型：

- `dev` — 完整软件开发（当前内置）
- `bugfix` — Bug 修复（简化版，跳过设计阶段）
- `refactor` — 重构（强调测试覆盖）
- `docs` — 文档编写
- `research` — 技术调研

每种类型都应该是 workflow + prompts + hooks 的完整组合。

## 设计考虑

### 1. Workflow 选择

- 当前：`project_init` 时指定（只有 `dev`，自动选择）
- 未来：agent 在了解需求后由 PM 决定
- 可能需要 `workflow_list` 工具让 agent 发现可用选项

### 2. Workflow 切换

- 不允许中途切换（阶段和文档体系不兼容）
- 需要不同流程时创建新项目

### 3. Prompt 动态化

- PM prompt 中的 Workflow Guide 应该从协作包中读取
- setup 注入时根据选中的 workflow 加载对应 prompts

## 前置条件

暂不实施。等以下条件满足再开始：

1. **开发流程跑通** — 当前内置的 `dev` workflow 在真实场景中验证可用
2. 有真实的自定义需求驱动（不只是 workflow，还需要自定义 prompt/hooks）
3. 至少有 2 个不同的协作流程定义就绪

# v2 扩展角色

| 角色              | 实现方式   | 推荐模型级别 | 会话模式         | 核心职责                       |
| ----------------- | ---------- | ------------ | ---------------- | ------------------------------ |
| **Code Reviewer** | 独立 Agent | 强推理       | 路径 A（一次性） | 代码审查、质量把关、安全检查   |
| **DevOps**        | 独立 Agent | 中等         | 路径 A（一次性） | CI/CD 配置、部署脚本、基础设施 |
| **Tech Writer**   | 独立 Agent | 中等偏下     | 路径 A（一次性） | API 文档、README、用户指南     |

# 七、通信机制

| 机制             | 用途                 | 方式                                                          |
| ---------------- | -------------------- | ------------------------------------------------------------- |
| **透传**         | 用户直接与某角色沟通 | `@角色名 消息内容`，PM 原文传递，原文返回                     |
| **Session 恢复** | 多轮交互保持上下文   | `--session/--resume` + `~/.harmonia/<project>/sessions/` 管理 |

---

# Dispatch 返回可执行命令

> 状态: 已规划（暂不执行）
> 编号日志: [045-dispatch-launch-command-plan.md](./045-dispatch-launch-command-plan.md)
> 日期: 2026-03-20

## 目标

将 `role_dispatch` 从返回文本指引改为返回可执行 CLI 命令，让 Coordinator 直接执行而非解读文本。

## 核心设计

- **Agent 适配器层**: 新建 `src/core/agent-adapters.ts`，映射 agent 类型 → CLI 命令模板（opencode / claude-code / codex / openclaw）
- **Prompt 文件**: Role Prompt 写入 `{contextDir}/.tmp/dispatch-{id}.md`，CLI 命令通过 `-f` 引用
- **输出变更**: `## Session Guidance` → `## Launch Command`（含完整 shell 命令字符串）
- **Fallback**: 未指定 agent 时回退到现有文本指引格式
- **清理**: `dispatch_report` 终态时删除临时 prompt 文件

## 前置条件

当前文本指引模式已经可用。命令式模式作为增强，等以下条件满足再实施：

1. 各 agent CLI 格式稳定（opencode / claude-code 等的非交互模式不再频繁变动）
2. 有真实多 agent 调度场景验证当前文本指引的痛点

---

# activeContext 并发安全问题

> 状态: 已知问题，待讨论
> 发现日期: 2026-03-17
> 关联: patch + issues 系统实现 (025-patch-issues-plan)

## 问题描述

`activeContext` 是 `ProjectEntry` 上的单一全局字段（存储在 `registry.json`），用于标识当前活跃的工作上下文（如 `"iter-2"` 或 `"patch-1"`）。所有工具通过 `resolveActive()` 读取该字段来确定操作目标目录。

当同一项目有两个并发会话时（例如一个 PM 在推进迭代，另一个会话启动了紧急补丁），后启动的会话会覆盖 `activeContext`，导致先前会话的工具调用被路由到错误的上下文目录。

## 影响范围

所有依赖 `resolveActive()` 的工具：`doc_write`、`doc_read`、`update_phase`、`dispatch_role`、`report_dispatch`、`approve_doc`、`set_scale` 等。

## 当前缓解

单项目单 PM 串行推进的场景下不会触发。PM prompt 中应避免同时开启多个上下文。

## 可能的修复方向

- **工具级显式传参**: 给工具加可选 `context` 参数，省略时 fallback 到 `activeContext`
- **Session 级绑定**: dispatch 时绑定 context 到 session，工具自动路由
- **其他方案待讨论**

具体方案后续讨论确定。
