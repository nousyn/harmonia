# Roadmap — 多 Workflow 支持

> 状态: 规划（未开始）  
> 日期: 2026-03-16

## 当前状态

Harmonia 目前只有一个 workflow: `dev`（软件开发全生命周期）。
`project_init` 和 `harmonia setup` 中的 `--workflow` 参数默认为 `dev`。

## 多 Workflow 场景

未来可能的 workflow 类型：

- `dev` — 完整软件开发（当前）
- `bugfix` — Bug 修复工作流（简化版，跳过设计阶段）
- `refactor` — 重构工作流（强调测试覆盖）
- `docs` — 文档编写工作流
- `research` — 技术调研工作流

## 设计考虑

### 1. Workflow 选择时机

- 当前：`project_init` 时指定（默认 dev）
- 未来：agent 在了解用户需求后，由 PM 决定使用哪个 workflow
- 可能需要一个 `project_set_workflow` 工具，类似 `project_set_scale` 的模式

### 2. Workflow 发现

- agent 需要知道有哪些可用的 workflow
- 方案: `workflow_list` 工具，返回所有 workflow 的名称和描述
- 或: `project_status` 无参数时同时返回可用 workflow 列表

### 3. Workflow 切换

- 一个项目是否可以中途切换 workflow？
- 建议: 不允许。Workflow 定义了完整的阶段和文档体系，中途切换会导致状态不一致
- 如果需要不同 workflow，创建新项目

### 4. Prompt 模板

- 当前 PM prompt 中的 Workflow Guide 是 `dev` 工作流特定的
- 多 workflow 时，prompt 需要根据 workflow 动态生成
- 方案: 每个 workflow 目录下包含 `pm-guide.md`，注入时读取

### 5. 对 020 计划的影响

- `project_init` 移除 `workflow` 参数（020 计划）是正确的 — 当前只有一个 workflow，不需要参数
- 未来添加多 workflow 时，再加回参数或用独立工具
- `harmonia setup` 不需要 `--workflow` — setup 是环境准备，与 workflow 无关

## 实施时间线

暂不实施。等以下条件满足再开始：

1. 至少有 2 个不同的 workflow 定义就绪
2. 有真实使用场景驱动
3. 020 计划完成并稳定运行
