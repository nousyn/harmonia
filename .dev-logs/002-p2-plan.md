# 002 — P2 计划：Setup 注入 + PM 引导 + 端到端可用

**日期**: 2026-03-13
**类型**: 执行计划

## 目标

P1 完成了全部核心工具（dispatch_role、override、review 等），但宿主 agent 还不知道怎么用它们。P2 让 Harmonia 真正可用——接入宿主 agent 后自动引导它扮演 PM 角色。

## 计划内容

### 1. Setup 机制

创建 `src/setup/` 模块：

- 检测宿主 agent 类型（V1 只支持 OpenCode → AGENTS.md）
- 生成 PM 引导 prompt 并注入到项目的 AGENTS.md
- 引导内容包括：Harmonia 工具一览、PM 工作流程、阶段推进指南、dispatch_role 使用方式

### 2. PM 引导 Prompt 模板

`src/setup/templates/opencode.ts`：

- 项目初始化流程（project_init + 需求澄清）
- 阶段推进指南（每个阶段该做什么、用哪些工具）
- 文档审核流程（write_doc → review → approve_doc）
- 任务派发流程（dispatch_role → 等待完成 → get_project_status）
- 工具使用速查表

### 3. 组员 Agent/Model 配置

扩展 override 体系：

- `OverrideConfig.roles[roleId].agent` — agent 类型（opencode/openclaw/claude-code/codex）
- `OverrideConfig.roles[roleId].model` — 指定模型
- dispatch_role 返回值中包含这些配置

### 4. get_project_status 增强

返回更丰富的状态：

- 当前阶段 + 待审核文档列表
- 已完成文档列表
- 下一步建议（根据当前状态自动推导）

### 5. setup MCP 工具

新增 `setup_project` MCP 工具：

- 参数：project_name, agent_type (可选，默认自动检测)
- 在项目目录注入 AGENTS.md（或对应配置）
- 返回注入结果 + PM 使用指南摘要
