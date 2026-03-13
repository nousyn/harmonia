# 007 — P4 完成：Session 管理 + 流程进度追踪

**日期**: 2026-03-13
**类型**: 完成记录

## 背景

P3（修复断点 + 完善拉起指引）已在 commit 019a646 完成。P4 的目标是为 Harmonia 添加 Session 管理和 Dispatch 追踪能力，让 PM 中断恢复后能完整了解项目进度，支持 session 复用，并通过 dispatch 状态自动推导完成情况。

## 完成内容

### 1. 新增类型定义

- `types.ts` 新增 `SessionStatus`、`SessionRecord`、`DispatchStatus`、`DispatchRecord` 类型
- Session 记录包含：id、role、agentSessionId、agentType、status、label、时间戳
- Dispatch 记录包含：id、role、sessionId、taskBrief、status、expectedOutputs、时间戳、note

### 2. 核心模块 — dispatch 状态管理

- 新增 `src/core/dispatch.ts`
- 管理 `<data_dir>/<project>/sessions.json` 和 `<data_dir>/<project>/dispatches.json`
- 核心函数：createSession、updateSession、findIdleSession、findSessionByAgentId、readSessions、createDispatch、updateDispatch、getDispatch、readDispatches
- ID 自增编号（ses-001、dispatch-001）

### 3. 改造 dispatch_role — 自动创建 dispatch + session 复用

- 调用时自动创建 dispatch 记录（status: dispatched）
- 自动查找该 role 的 idle session
- 返回数据包中新增 dispatch tracking 段和 session guidance 段
- 有可复用 session → 输出 agent_session_id + resume 命令
- 无可复用 session → 输出"拉起新 agent"指引
- 新增 resolveExpectedOutputs 函数，过滤 external 和 scale-skip 的 doc
- 新增 buildSessionGuidance 函数

### 4. 新增工具 — report_dispatch

- 新增 `src/tools/report-dispatch.ts`
- PM 在两个时机调用：
  1. 拉起后：回报 agent_session_id → 创建/复用 session，dispatch 标记 running
  2. 完成后：回报 status → dispatch 完成/失败，session 转 idle/lost
- 内部 resolveOrCreateSession 逻辑：优先复用已关联 session → 按 agentSessionId 匹配 → 创建新 session

### 5. 改造 get_project_status — 展示 dispatch/session 全景

- 新增 Sessions 和 Dispatches 输出段
- 格式化显示：状态图标、role、session 关联、task brief 摘要
- deriveNextSteps 增强：
  - dispatched 但未 running → 建议拉起
  - running → 建议等待或检查完成
  - failed → 建议重新 dispatch
  - lost session → 建议重新派发
  - 有 active dispatch 时不重复建议 dispatch
  - 所有完成 + 无 active dispatch → 建议推进阶段

### 6. PM 引导模板更新

- 工具表新增 `report_dispatch`
- 新增完整的 Dispatch Workflow 三步流程说明（dispatch → launch & report → completion）
- 新增 Session Recovery 指引（中断恢复后怎么做）
- 各阶段指南更新为包含 dispatch 工作流
- 重要规则新增"Always report dispatch lifecycle"

### 7. 注册新工具

- `src/index.ts` 导入并注册 `registerReportDispatch`

### 8. 测试

- 新增 `tests/dispatch.test.ts`（25 个测试）
- 覆盖：Session CRUD、Dispatch CRUD、项目隔离、完整生命周期
- 具体测试场景：
  - session 创建/更新/查找 idle/按 agent ID 查找
  - dispatch 创建/更新/终态时间戳/按 ID 查询
  - 不同项目的 session/dispatch 互不影响
  - dispatch → launch → complete 完整流程
  - session 复用（多次 dispatch 用同一 session）
  - 并行 developer dispatch（独立 session）

### 9. 构建验证

- setup-project.ts 工具数从 14 更新为 15
- TypeScript 编译零错误
- 7 个测试文件，86 个测试全部通过

## 测试结果

- 7 个测试文件，86 个测试全部通过
- TypeScript 构建成功

## 修改文件列表

- `src/core/types.ts` — 新增 Session/Dispatch 类型
- `src/core/dispatch.ts` — **新增** Session/Dispatch 状态管理模块
- `src/tools/dispatch-role.ts` — 自动创建 dispatch + session 复用指引
- `src/tools/report-dispatch.ts` — **新增** dispatch 生命周期回报工具
- `src/tools/get-project-status.ts` — 展示 session/dispatch + dispatch 感知推导
- `src/setup/templates.ts` — dispatch 工作流 + session 恢复指引
- `src/index.ts` — 注册 report_dispatch
- `src/tools/setup-project.ts` — 工具数 14 → 15
- `tests/dispatch.test.ts` — **新增** dispatch/session 测试

## 新增工具数

| 变更 | 说明                                                     |
| ---- | -------------------------------------------------------- |
| 新增 | `report_dispatch`                                        |
| 改造 | `dispatch_role`（自动创建 dispatch + session 复用）      |
| 改造 | `get_project_status`（展示 dispatch/session + 增强推导） |
| 改造 | `templates.ts`（PM 引导模板更新）                        |

总工具数：14 → 15
