# P1: Tool Guard — 完成日志

> 日期: 2026-03-16
> 前置: 011-optimization-proposal.md, 012-p0-schema-complete.md

## 概述

实现了 MCP tool 级别的硬约束（Tool Guard），在代码层面强制执行工作流规则，
替代原来完全依赖 prompt 的"乐观信任"架构。

## 实现清单

### P1.1 — `update_phase` 完成守卫

文件: `src/tools/update-phase.ts`

当 `status=completed && force!=true` 时，聚合检查以下条件：

1. **前序阶段完成检查** — 所有前序阶段必须为 completed
2. **必需文档产出检查** — 当前阶段的 outputs 中非 external、非 skip/optional 的文档必须存在
3. **文档审核状态检查** — 需要 review 的文档必须为 approved（通过 `resolveDocReview` 综合 override 判断）
4. **活跃 dispatch 检查** — 不能有 dispatched/running 状态的 dispatch

所有错误聚合后一次返回，`isError: true`。用户可通过 `force=true` 跳过。

### P1.2 — `dispatch_role` 角色-阶段验证

文件: `src/tools/dispatch-role.ts`

检查 `role` 是否属于当前阶段或下一阶段的 `roles` 列表。
不在允许列表则拒绝，`isError: true`，提示"如确需 dispatch 此角色，请先推进阶段"。

### P1.3 — `report_dispatch` 状态机守卫

文件: `src/tools/report-dispatch.ts`, `src/core/dispatch.ts`

状态转换规则：

- `dispatched` → `running`, `cancelled`
- `running` → `completed`, `failed`, `cancelled`
- `completed`, `failed`, `cancelled` → (终态，不可转换)

非法转换返回 `isError: true`，区分"终态不可逆"和"当前状态不允许"两种错误消息。

核心逻辑提取为 `core/dispatch.ts` 中的纯函数：

- `DISPATCH_TRANSITIONS` — 转换规则常量
- `isValidTransition(from, to)` — 转换合法性检查
- `isTerminalStatus(status)` — 终态判断

### P1.4 — `report_dispatch` 完成时产出检查

当 dispatch 标记为 completed 且有 expectedOutputs 时，检查是否所有非 external 的预期文档已存在。
缺失则在返回中添加 **warning**（非 error），提示 PM 确认。

签名变更: `registerReportDispatch(server)` → `registerReportDispatch(server, workflowsDir)`
以支持加载 workflow 定义判断 external 属性。

### P1.5 — `write_doc` 守卫

文件: `src/tools/doc-tools.ts`

三项前置检查（在 schema 校验之前执行）：

1. **doc_id 有效性** — 必须在 workflow.json 的 docs 中定义
2. **external 拒绝** — external=true 的文档类型不允许通过 write_doc 写入
3. **空内容拒绝** — content.trim() 为空则拒绝

## 重构

- `report-dispatch.ts` 中的本地 `VALID_TRANSITIONS` 常量已删除，
  改为从 `core/dispatch.ts` 导入 `isValidTransition` 和 `isTerminalStatus`
- 消除了重复定义，提升可测试性

## 测试

新增: `tests/guards.test.ts` — 57 个测试

- `DISPATCH_TRANSITIONS` 结构验证（5 个状态均有定义、各允许转换正确、终态无转换）
- `isValidTransition` 正向/反向/终态测试（18 个具体场景）
- `isTerminalStatus` 正反面测试（5 个状态）
- 完整转换矩阵（5×5 = 25 个组合全覆盖）

测试哲学：只测 Harmonia 自己的逻辑（纯函数），不测 MCP handler 集成。

## 最终状态

- **Build**: 通过
- **Tests**: 149 passing（92 原有 + 57 新增）
- **9 个测试文件**: dispatch, docs, overrides, reviews, schema, setup, state, workflow, **guards**

## 修改文件汇总

| 文件                           | 变更                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| `src/tools/update-phase.ts`    | 新增 4 项完成守卫                                                |
| `src/tools/dispatch-role.ts`   | 新增角色-阶段验证                                                |
| `src/tools/report-dispatch.ts` | 新增状态机守卫 + 产出检查；删除本地 VALID_TRANSITIONS            |
| `src/tools/doc-tools.ts`       | 新增 doc_id/external/空内容守卫                                  |
| `src/core/dispatch.ts`         | 新增 DISPATCH_TRANSITIONS + isValidTransition + isTerminalStatus |
| `src/index.ts`                 | registerReportDispatch 签名更新                                  |
| `tests/guards.test.ts`         | **新增** 57 个测试                                               |
