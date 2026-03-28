# 051 — Loop 审计修复

> 050 实施后审计发现的问题修复：验证器 goto 边界缺陷、栈溢出防御、公共 API 提取、版本号修正、测试补充。

---

## 问题清单

| #   | 优先级 | 问题                                                            | 类型     |
| --- | ------ | --------------------------------------------------------------- | -------- |
| 1   | P0     | 验证器允许从循环外部 goto 到循环内部节点                        | 设计缺陷 |
| 2   | P1     | 空/即时完成的循环体 + 高 maxIterations 导致同步栈溢出           | 潜在 bug |
| 3   | P2     | MCP Server 版本号硬编码 `0.1.0`，与 package.json `1.3.0` 不一致 | 疏忽     |
| 4   | P2     | 节点树遍历函数在 engine 和工具层重复实现                        | 代码重复 |
| 5   | P3     | 嵌套循环运行时行为缺少测试覆盖                                  | 测试     |
| 6   | P3     | 循环内含 parallel 节点缺少测试覆盖                              | 测试     |

---

## 问题分析

### 问题 1：验证器 goto 边界缺陷

**根因**：`validateGotoTargets` 的 sequence 分支（line 271）在处理完一个 child 后，调用 `collectSubtreeIds(child, accumulated)` 将 child 的整个子树 ID 加入后续兄弟的 `reachableIds`。`collectSubtreeIds` 对 loop 节点会递归进入 body，导致 loop body 内部节点 ID 暴露给后续兄弟。

**后果**：后续兄弟（或其子节点）的 `onFailed.goto` 可以指向 loop body 内部的节点，验证通过。但引擎执行时 `executeGoto` 会直接激活 body 内节点而不初始化 loop 的 `LoopNodeState`，后续 `handleLoopBodyComplete` 读取未初始化的循环状态，行为未定义。

**修复方案**：在 `validateGotoTargets` 的 sequence 分支中，将 `collectSubtreeIds` 替换为新函数 `collectReachableIds`。新函数对 loop 类型只收集 loop 自身 ID，不深入 body。替换后 `collectSubtreeIds` 在验证器中无外部调用者，成为死代码，由 B3 删除（功能等价的 `collectAllNodeIds` 已提取至 `tree-utils.ts`）。

**影响验证**：

- 从 loop 内部 goto 到外部前置节点（已有测试 #8）：不受影响，该 goto 的合法性来自 `reachableIds` 的传入，不来自 `collectSubtreeIds` 积累
- goto 到 loop 节点本身（如 `loop.onFailed.goto = 'my-loop'`）：不受影响，loop 自身 ID 仍会被收集
- gate/parallel 分支：不受影响，它们不调用 `collectSubtreeIds`

**设计理由**：loop body 是循环的内部实现细节，外部节点不应能直接跳入。如需重新执行循环，应 goto 到 loop 节点本身。

### 问题 2：空循环体栈溢出

**根因**：引擎的 `computeNextAction` 是纯同步函数。当 loop body 不含任何 task 节点时（如空 sequence、或只由 sequence/parallel/gate 嵌套但无 task），body 在一次同步调用中直接完成，触发 `handleLoopBodyComplete` → `resetLoopBody` → `activateNode` → 又同步完成 → 又触发……形成同步递归。每次迭代约 6-7 层栈帧。

**后果**：`maxIterations` 较大时（>= 5000）抛出 `RangeError: Maximum call stack size exceeded`。

**修复方案**：在 `validateLoopNode` 中增加校验——loop body 子树必须包含至少一个 task 节点。

**校验逻辑**：新增 `containsTaskNode(node)` 辅助函数，递归遍历 body 子树，找到任意 `type === 'task'` 节点即返回 true。对 gate 节点，pass 或 fail 任一分支含 task 即可（fail 为 GotoTarget 时跳过，因为 goto 本身会中断同步递归）。代码中需加注释说明已知边缘情况：若 gate.pass 无 task 而 gate.fail 为 GotoTarget，运行时走 pass 分支时仍可能同步完成；此场景极端罕见，当前"任一分支有 task"逻辑作为 80/20 方案接受。

**设计理由**：

- 没有 task 的 loop body 在语义上无意义——循环存在就是为了重复派遣角色执行工作
- 此约束不违反 050 设计决策 D4（body 可以是任意节点**类型**），它约束的是 body 的**内容**（子树必须含 task），而非 body 的外层类型
- 精确消除同步递归的前提条件，不限制 maxIterations 的取值范围

**不采用的方案**：

- maxIterations 上限 — 间接防御，会限制合法用例，且上限值难以确定
- 引擎改为异步迭代 — 改动范围大，破坏引擎纯函数特性

### 问题 3：版本号不一致

`src/index.ts:103` 硬编码 `version: '0.1.0'`。MCP 协议中 server version 在 `initialize` 握手时返回给 client。

**修复方案**：硬编码改为 `1.3.0`。简单、无运行时开销、与现有模式一致。

### 问题 4：节点树遍历函数重复与分散

**现状**：项目中存在多个纯节点树遍历函数，部分有重复实现，其余分散在不同模块中。

**重复实现（3 对）**：

| 函数                                      | 位置 A                    | 位置 B                     |
| ----------------------------------------- | ------------------------- | -------------------------- |
| `findNodeInTree` / `findNodeById`         | `workflow-engine.ts:1268` | `loop-done.ts:22`          |
| `findPathTo` / `findPathToNode`           | `workflow-engine.ts:876`  | `dispatch-role.ts:69`      |
| `collectAllNodeIds` / `collectSubtreeIds` | `workflow-engine.ts:909`  | `workflow-validator.ts:37` |

**分散但无重复的纯函数（4 个）**：

| 函数                                       | 位置                      | 用途                                        |
| ------------------------------------------ | ------------------------- | ------------------------------------------- |
| `findParent(root, targetId)`               | `workflow-engine.ts:1200` | 查找目标节点的父节点及子索引                |
| `collectSubsequentNodeIds(root, targetId)` | `workflow-engine.ts:845`  | 收集执行顺序上位于目标节点之后的所有节点 ID |
| `collectTaskNodes(node)`                   | `engine-helpers.ts:125`   | 递归收集所有 task 节点                      |
| `findAncestorLoopId(root, targetId)`       | `dispatch-role.ts:56`     | 查找最近祖先 loop 节点 ID                   |

以上 7 个函数均为纯函数（无副作用、不依赖引擎状态、只依赖 `types.ts` 类型），新增节点类型时需逐处同步修改。

**修复方案**：新建 `src/core/tree-utils.ts`，统一导出全部 7 个纯函数。各来源文件删除本地实现，改为从 `tree-utils` 导入。

**统一命名**：

| 导出名                     | 原名（如有差异）                   |
| -------------------------- | ---------------------------------- |
| `findNodeInTree`           | loop-done 中为 `findNodeById`      |
| `findPathToNode`           | engine 中为 `findPathTo`           |
| `collectAllNodeIds`        | validator 中为 `collectSubtreeIds` |
| `findParent`               | —                                  |
| `collectSubsequentNodeIds` | —                                  |
| `collectTaskNodes`         | —                                  |
| `findAncestorLoopId`       | —                                  |

**设计理由**：这些函数是纯节点树遍历工具，不依赖引擎状态。放在独立的 `tree-utils.ts` 中可避免 `engine-helpers.ts` ↔ `workflow-engine.ts` 循环依赖（`engine-helpers` 已导入 `workflow-engine` 的 `computeNextAction`），同时全项目只保留 1 份实现。

---

## 变更计划

### Phase A：验证器修复（问题 1 + 问题 2）

| 编号 | 内容                                                                                                          | 文件                           |
| ---- | ------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| A1   | 新增 `collectReachableIds` — 与 `collectSubtreeIds` 相同，但对 loop 只收集自身 ID 不深入 body                 | src/core/workflow-validator.ts |
| A2   | `validateGotoTargets` 的 sequence 分支（line 271），将 `collectSubtreeIds` 替换为 `collectReachableIds`       | src/core/workflow-validator.ts |
| A3   | 新增 `containsTaskNode(node)` 辅助函数；`validateLoopNode` 增加校验：loop body 子树必须包含至少一个 task 节点 | src/core/workflow-validator.ts |

### Phase B：纯函数抽取至 `tree-utils.ts`（问题 4）

| 编号 | 内容                                                                                                                                                                                                                                                                                               | 文件                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| B1   | 新建 `tree-utils.ts`，导出 7 个纯函数：`findNodeInTree`、`findPathToNode`、`collectAllNodeIds`、`findParent`、`collectSubsequentNodeIds`、`collectTaskNodes`、`findAncestorLoopId`                                                                                                                 | src/core/tree-utils.ts         |
| B2   | `workflow-engine.ts` 删除 5 个 private 函数（`findNodeInTree`:1268、`findPathTo`:876、`collectAllNodeIds`:909、`collectSubsequentNodeIds`:845、`findParent`:1200），改为从 `tree-utils` 导入。注意：`findNode`（line 1251）留在 engine 中作为私有函数，它调用 `findNodeInTree`，需通过 import 获得 | src/core/workflow-engine.ts    |
| B3   | `workflow-validator.ts` 删除 `collectSubtreeIds`（line 37）— A2 替换后该函数已无调用点，为死代码                                                                                                                                                                                                   | src/core/workflow-validator.ts |
| B4   | `loop-done.ts` 删除 `findNodeById`（line 22），改为从 `tree-utils` 导入 `findNodeInTree`                                                                                                                                                                                                           | src/tools/loop-done.ts         |
| B5   | `dispatch-role.ts` 删除 `findPathToNode`（line 69）和 `findAncestorLoopId`（line 56），改为从 `tree-utils` 导入；同时将 `collectTaskNodes` 的导入源从 `engine-helpers` 改为 `tree-utils`                                                                                                           | src/tools/dispatch-role.ts     |
| B6   | `engine-helpers.ts` 删除 `collectTaskNodes`（line 125），改为从 `tree-utils` 导入（仅内部使用，不再导出）                                                                                                                                                                                          | src/tools/engine-helpers.ts    |

### Phase C：版本号修复（问题 3）

| 编号 | 内容                            | 文件         |
| ---- | ------------------------------- | ------------ |
| C1   | MCP Server version 改为 `1.3.0` | src/index.ts |

### Phase D：测试补充（问题 5 + 问题 6 + 问题 1/2 回归）

| 编号 | 内容                                                                           | 文件                             |
| ---- | ------------------------------------------------------------------------------ | -------------------------------- |
| D1   | 验证器测试：从循环外部 goto 到循环内部节点 → 应报 `invalid_goto` 错误          | tests/workflow-validator.test.ts |
| D2   | 验证器测试：loop body 不含 task 节点（如空 sequence、纯嵌套 sequence）→ 应报错 | tests/workflow-validator.test.ts |
| D3   | 引擎测试：嵌套循环运行时 — 内层 loop_done 后外层正确推进迭代                   | tests/workflow-engine.test.ts    |
| D4   | 引擎测试：loop body 含 parallel 节点 — parallel 完成后循环正确迭代             | tests/workflow-engine.test.ts    |

### Phase E：验证

| 编号 | 内容                       |
| ---- | -------------------------- |
| E1   | `tsc --noEmit` 通过        |
| E2   | 全量测试通过（含新增测试） |

## 执行顺序

Phase A → B → C → D → E

先修复安全问题（验证器），再重构（API 提取），然后修细节（版本号），最后补测试并全量验证。
