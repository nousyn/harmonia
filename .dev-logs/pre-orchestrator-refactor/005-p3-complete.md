# 005 — P3 完成：修复断点 + 完善 dispatch 后拉起指引

**日期**: 2026-03-13
**类型**: 完成记录

## 完成内容

### 1. 修复 "code" 断点

- workflow.json 中为 `code` 添加 doc 定义，标记 `"external": true`
- DocDefinition 类型新增 `external?: boolean` 字段
- get-project-status.ts：missing outputs 检查跳过 external 类型
- dispatch-role.ts：读取 input docs 时跳过 external 类型

### 2. update_phase 输出守卫

- update-phase.ts 完成阶段时检查 doc 类产出是否已存在
- 跳过 external 和未知 output
- 缺少产出时返回错误提示，可通过 `force=true` 跳过检查
- registerUpdatePhase 签名变更：新增 workflowsDir 参数
- index.ts 调用已同步更新

### 3. 完善 PM 引导模板拉起指引

- templates.ts 中替换了模糊的 "You decide how to pass this to the team member"
- 新增两种已确认的拉起方式的具体操作指引：
  - OpenClaw → sessions_spawn（子 agent 自动共享 gateway 级 MCP）
  - 其他 agent → shell exec
- 新增完成检测说明（V1 同步方式：等进程退出 + get_project_status 验证）

### 4. 其他审计缺失修复

- registry.ts：移除未使用的目录创建（adr/sessions/messages/tasks），只保留 docs/
- registry.ts：更新头部注释结构说明
- setup-project.ts：硬编码工具数从 12 改为 14

## 测试结果

- 6 个测试文件，61 个测试全部通过
- TypeScript 构建成功

## 修改文件列表

- `workflows/dev/workflow.json` — 新增 code doc 定义（external）
- `src/core/types.ts` — DocDefinition 新增 external 字段
- `src/tools/get-project-status.ts` — missing outputs 跳过 external
- `src/tools/dispatch-role.ts` — input docs 跳过 external
- `src/tools/update-phase.ts` — 新增输出守卫逻辑 + workflowsDir 参数
- `src/index.ts` — registerUpdatePhase 调用更新
- `src/setup/templates.ts` — dispatch 后拉起指引替换
- `src/tools/setup-project.ts` — 工具数修正
- `src/core/registry.ts` — 移除未使用目录创建 + 更新注释
