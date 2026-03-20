# 048 — 死代码 / 死导入 / 测试数据清理

> 清理 047 复查发现的低优先级技术债：死导入、`let→const`、测试数据多余字段、过时注释、重复构造。

---

## 背景

047 签名清理完成后，复查发现多个文件存在死导入、未使用变量、测试数据与类型定义不匹配等问题。这些问题均为 047 之前就存在的遗留债务，不影响功能和编译（`tsc --noEmit` 通过），但在 `tsc --noUnusedLocals` 下会报错。

复查后决定扩展范围，将所有 `--noUnusedLocals` 报错一并清零。

## 变更计划

| 编号 | 内容                                                                          | 文件                            | 状态 |
| ---- | ----------------------------------------------------------------------------- | ------------------------------- | ---- |
| 1    | 移除死导入 `readState`                                                        | src/tools/report-dispatch.ts    | ✅   |
| 2    | 移除死导入 `TaskNode` 类型                                                    | src/tools/report-dispatch.ts    | ✅   |
| 3    | `let targetNode` → `const targetNode`（从未重赋值）                           | src/tools/report-dispatch.ts    | ✅   |
| 4    | 移除死导入 `startWorkflow`                                                    | src/tools/engine-helpers.ts     | ✅   |
| 5    | 移除死导入 `WorkflowState` 类型                                               | src/tools/get-project-status.ts | ✅   |
| 6    | 移除死导入 `WorkflowPlugin` 类型                                              | src/tools/get-project-status.ts | ✅   |
| 7    | 测试数据移除不存在于 `ArtifactDefinition` 接口的 `scale` 属性                 | tests/artifacts.test.ts         | ✅   |
| 8    | `artifact-tools.ts` 文件头注释修正 — 反映可配置输出路径                       | src/tools/artifact-tools.ts     | ✅   |
| 9    | `handleSequentialWrite` 构造 `ioCtx` 后传参给 `handleFinalStep`，消除重复构造 | src/tools/artifact-tools.ts     | ✅   |
| 10   | 移除死导入 `ReviewStatus` 类型                                                | src/core/reviews.ts             | ✅   |
| 11   | 移除死导入 `NodeStatus` 类型                                                  | src/core/workflow-engine.ts     | ✅   |
| 12   | 移除死导入 `NextActionType` 类型                                              | src/core/workflow-engine.ts     | ✅   |
| 13   | 移除死导入 `resolve`                                                          | src/index.ts                    | ✅   |

## 不做

| 内容                    | 理由                                            |
| ----------------------- | ----------------------------------------------- |
| 删除 `readStepArtifact` | 零调用者但属于 public API，未来可能用到，暂保留 |

## 验证

| 编号 | 内容                                       | 状态 |
| ---- | ------------------------------------------ | ---- |
| V1   | `npx tsc --noEmit` 编译通过                | ✅   |
| V2   | `npx vitest run` 全量测试通过（355 tests） | ✅   |
| V3   | `npx tsc --noEmit --noUnusedLocals` 零报错 | ✅   |

## 实际变更量

- 修改 8 个文件
- 删除约 9 行（死导入）
- 修改约 6 行（`let→const`、注释、测试数据、参数传递）
- 无新增文件
