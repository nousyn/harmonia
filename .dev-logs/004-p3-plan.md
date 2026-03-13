# 004 — P3 计划：修复断点 + 完善 dispatch 后拉起指引

**日期**: 2026-03-13
**类型**: 执行计划

## 目标

修复已知断点，完善数据流闭环。让 PM 通过 dispatch_role 拿到数据后，能通过明确的指引拉起组员 agent 完成任务。

## 计划内容

### 1. 修复 "code" 断点

workflow.json 中 `code` 作为 develop 阶段的 output、test 阶段的 input，但它不是 doc（代码由 agent 直接写在项目目录中，不经过 write_doc）。导致：

- get_project_status 永远报 missing output
- dispatch tester 时永远 missing_docs

修复方案：在 workflow/status 逻辑中区分 doc 产出和非 doc 产出。非 doc 产出不纳入文档完成度检查。

### 2. update_phase 输出守卫

完成阶段时检查该阶段的 doc 类产出是否已存在，未产出则阻止完成或给出警告。

### 3. 完善 PM 引导模板中 dispatch 后的拉起指引

已确认的拉起方式：

- OpenClaw 组员 → sessions_spawn（子 agent 共享 gateway 级 MCP，自动能用 Harmonia 工具）
- 其他 agent → exec（shell）拉起

在 templates.ts 的 PM 引导模板中，将"You decide how to pass this to the team member"替换为具体的操作指令。

### 4. 其他审计发现的中等缺失修复

- registry 创建的未使用目录清理（adr/sessions/messages/tasks）
- setup_project 硬编码工具数修正
