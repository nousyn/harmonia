Roadmap

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
