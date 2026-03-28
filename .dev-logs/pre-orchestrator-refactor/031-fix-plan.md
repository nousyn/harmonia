# 031 — 重构后修复计划

> 基于 030-post-refactor-review.md 的分析结果，制定本修复计划。
> 按优先级分组：P0（必须修复）、P1（应修复）、P2（可选改进）。

---

## P0：必须修复

### A.1: dispatch-role.ts — 集成 beforeDispatch hooks

**问题**：`ActionRegistry` 已实现（`action-registry.ts`，60行），`TaskNode` 类型已包含 `beforeDispatch?: NodeHook`，但 `dispatch-role.ts` 完全没有调用 hook。

**修复方案**：

- 在 `dispatch-role.ts` 的 handler 中，找到 `targetNode` 后，检查 `targetNode.beforeDispatch`
- 如果有 `beforeDispatch.actions`，通过 `ActionRegistry.execute()` 逐个执行
- 如果有 `beforeDispatch.inject`，将注入文本追加到 `fullPrompt` 后面
- 需要从 `loadWorkflowForContext` 获取 `wf.actions` 来构建 `ActionRegistry`

**影响文件**：`src/tools/dispatch-role.ts`

### A.2: report-dispatch.ts — 集成 afterComplete hooks

**问题**：`TaskNode.afterComplete` 定义了 `inject` 和 `actions`，但 `report-dispatch.ts` 在 `completed` 路径上没有任何 hook 处理。

**修复方案**：

- 在 `effectiveStatus === 'completed'` 分支中，查找 dispatch 关联的 targetNode
- 如果 targetNode 有 `afterComplete.actions`，通过 `ActionRegistry.execute()` 逐个执行
- 如果有 `afterComplete.inject`，将注入文本追加到响应中
- 需要加载 workflow 来查找节点定义

**影响文件**：`src/tools/report-dispatch.ts`

### A.3: 角色提示词术语残留

**问题**：重构将 `doc` → `artifact`，`PM` → `coordinator`，但部分角色文件未更新。

**修复内容**：

- `architect.md`：5× `doc:` → `artifact:`，2× `PM` → `coordinator`，1× `doc_write` → `artifact_write`
- `developer.md`：4× `PM` → `coordinator`
- `tester.md`：2× `doc:` → `artifact:`，2× `PM` → `coordinator`，1× `doc_write` → `artifact_write`

**影响文件**：`workflows/dev/roles/architect.md`、`developer.md`、`tester.md`

---

## P1：应修复

### B.1: artifact_field gate 条件始终返回 undefined

**问题**：`engine-helpers.ts:42-48` 的 `artifactField` 函数体内有 TODO，永远返回 `undefined`。dev workflow 的 `test-gate` 使用 `artifact_field` 条件检查 `test-report.result`，导致 gate 永远无法通过。

**修复方案**：

- 将 `buildGateContext` 改为 async，或预加载需要的 artifact 内容
- 实现 JSON artifact 的 field 取值逻辑：读取 artifact → JSON.parse → 按 dot path 提取字段
- 添加比较操作符实现（eq/neq/contains 等）

**影响文件**：`src/tools/engine-helpers.ts`

### B.2: query_status 导致不必要的状态写入

**问题**：`processWorkflowEvent` 对所有事件（包括只读的 `query_status`）都调用 `persistState`。

**修复方案**：

- 在 `processWorkflowEvent` 中检查事件类型
- 如果是 `query_status`，跳过 `persistState` 调用

**影响文件**：`src/tools/engine-helpers.ts`

### B.3: patch_start 未持久化 issue_id/description

**问题**：`patch_start` 工具接受 `issue_id` 和 `description` 参数，但只在返回文本中显示，没有写入 state。

**修复方案**：

- 在 `initWorkflowState` 之后，将 `issue_id` 和 `description` 写入 state 的 metadata
- 或者在 state 类型中添加可选的 `patchMeta` 字段

**影响文件**：`src/tools/patch-start.ts`、`src/core/types.ts`、`src/core/state.ts`

### B.4: Validator cycle detection 过于保守

**问题**：`hasExit` 需要 `maxRetries` AND `onExhausted` 同时存在。但引擎实际上在只有 `maxRetries`（无 `onExhausted`）时会 `bubbleFailure`，这也是一种合法的退出路径。

**修复方案**：

- 修改 `hasExit` 判定：`maxRetries !== undefined`（不再要求 `onExhausted`）
- 只要有 `maxRetries`，无论是否有 `onExhausted`，都视为有退出路径

**影响文件**：`src/core/workflow-validator.ts`

---

## P2：可选改进

### C.1: Gate fail path 类型判别脆弱

**问题**：使用 `'goto' in node.fail && !('type' in node.fail)` 做 duck typing 区分 `GotoTarget` vs `WorkflowNode`。

**修复方案**：暂不修复。这是类型系统层面的改进，需要修改 `GotoTarget` 类型添加 discriminant 字段，影响面大且当前功能正确。

### C.2: reevaluateGates 只处理第一个通过的 gate

**问题**：`reevaluateGates` 在 920-921 行有 `return`，只处理第一个通过的 gate。

**修复方案**：暂不修复。多个 gate 同时通过是边缘场景，且当前行为在语义上是安全的（处理一个后，下次事件会继续处理其余的）。

### C.3: plugin.ts 静默吞掉错误

**问题**：3 处 `catch {}` 静默忽略加载错误（roles/、schemas/、tools.ts/hooks.ts）。

**修复方案**：

- 在 `catch` 块中添加 `console.warn` 日志输出
- 区分"目录不存在"（正常）和"文件解析失败"（应警告）

**影响文件**：`src/core/plugin.ts`

### C.4: workflow.ts 兼容层应移除

**问题**：`workflow.ts` 是 deprecated 包装层，注释说 `skipValidation=true` 因为 `coordinator.md` 缺失，但 coordinator.md 现在已存在。

**修复方案**：

- 将 `skipValidation` 改为 `false`（启用验证）
- 更新注释移除过时说明
- 完整移除需要更多调用方迁移，暂时只修正 skipValidation

**影响文件**：`src/core/workflow.ts`

---

## 执行顺序

1. A.3 → 最简单，纯文本替换
2. B.4 → 单行修改
3. B.2 → 几行修改
4. C.3 → 几行修改
5. C.4 → 单行修改 + 注释更新
6. B.1 → 中等复杂度，需要实现 field 访问逻辑
7. B.3 → 需要扩展类型
8. A.1 → 较复杂，集成 hook 系统
9. A.2 → 较复杂，集成 hook 系统
10. 运行测试 → 确认全部通过
