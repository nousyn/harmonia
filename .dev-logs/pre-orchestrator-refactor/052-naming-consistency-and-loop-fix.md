# 052 — Tools 文件命名统一 & afterComplete loopIteration 修复

## 背景

`src/tools/` 目录下文件命名风格不一致：大部分文件使用「名词-动词」风格（与 MCP 工具名 `snake_case` 转 `kebab-case` 一致），但有 3 个文件使用了「动词-名词」风格。

同时发现 `afterComplete` 钩子的 action 构建 `ActionContext` 时缺失 `loopIteration` 字段，而 `beforeDispatch` 钩子已正确注入该字段，属于遗漏 bug。

## 改动

### 1. 文件重命名（统一为名词-动词风格）

| 原文件名              | 新文件名              | 对应 MCP 工具名                    |
| --------------------- | --------------------- | ---------------------------------- |
| `dispatch-role.ts`    | `role-dispatch.ts`    | `role_dispatch`                    |
| `report-dispatch.ts`  | `dispatch-report.ts`  | `dispatch_report`                  |
| `approve-artifact.ts` | `artifact-approve.ts` | `artifact_approve` + `review_list` |

测试文件同步重命名：`dispatch-role.test.ts` → `role-dispatch.test.ts`

### 2. Import 路径更新

- `src/index.ts` — 3 处动态 import 路径
- `src/core/tree-utils.ts` — 1 处注释引用
- `src/tools/utils.ts` — 1 处注释引用
- `tests/role-dispatch.test.ts` — 2 处 import 路径

### 3. 修复 afterComplete 缺失 loopIteration

**问题**：`dispatch-report.ts` 中 `afterComplete` action 构建 `ActionContext` 时未注入 `loopIteration`，导致 loop 内节点的 afterComplete action 无法获取当前迭代索引。`ActionContext.loopIteration` 是 optional 字段，TypeScript 编译不会报错，但运行时值始终为 `undefined`。

**修复**：在 `dispatch-report.ts` 的 afterComplete action 执行前，添加与 `role-dispatch.ts` beforeDispatch 相同的逻辑：

1. 调用 `findAncestorLoopId()` 查找祖先 loop 节点
2. 从 `LoopNodeState.currentIteration` 读取当前迭代次数
3. 赋值给 `actionCtx.loopIteration`

## 验证

- TypeScript 编译通过
- 21 个测试文件、416 个测试全部通过
