# 032 — 重构后修复完成

> 基于 031-fix-plan.md 的修复计划，所有修复已执行完毕并通过测试。

---

## 测试结果

```
22 test files | 406 tests passed | 0 failed
```

---

## 已完成修复

### P0: 必须修复 (3/3)

#### A.1: dispatch-role.ts — 集成 beforeDispatch hooks ✅

**修改文件**：`src/tools/dispatch-role.ts`

**变更内容**：

- 导入 `ActionContext` 类型和 `listDocs` 函数
- 在 targetNode 解析后、构建 fullPrompt 时，检查 `targetNode.beforeDispatch`
- 如果有 `beforeDispatch.inject`，收集静态注入文本
- 如果有 `beforeDispatch.actions`，从 `wf.actions` 查找 handler 并执行
- 将所有注入文本追加到 rolePrompt 末尾
- 错误处理：action 执行失败时 warn 但不中断 dispatch

#### A.2: report-dispatch.ts — 集成 afterComplete hooks ✅

**修改文件**：`src/tools/report-dispatch.ts`

**变更内容**：

- 导入 `loadWorkflowForContext`、`readDoc`、`listDocs`、`readState`、`ActionContext`、`TaskNode`、`WorkflowNode`
- 新增 `findTaskNodeById` 辅助函数（递归查找 task node）
- 在 `completed` 路径中，触发 engine event 后加载 workflow 并查找目标节点
- 如果节点有 `afterComplete.inject`，收集注入文本
- 如果有 `afterComplete.actions`，逐个执行并收集注入结果
- 注入结果追加到 results 的 "After-Complete Hook Output" 部分
- 全部包裹在 try/catch 中，确保 hook 失败不影响主流程

#### A.3: 角色提示词术语残留 ✅

**修改文件**：

- `workflows/dev/roles/architect.md`：5× `doc:` → `artifact:`，2× `PM` → `coordinator`，1× `doc_write` → `artifact_write`
- `workflows/dev/roles/developer.md`：4× `PM` → `coordinator`
- `workflows/dev/roles/tester.md`：2× `doc:` → `artifact:`，2× `PM` → `coordinator`，1× `doc_write` → `artifact_write`

---

### P1: 应修复 (4/4)

#### B.1: artifact_field gate 条件实现 ✅

**修改文件**：`src/tools/engine-helpers.ts`

**变更内容**：

- 新增 `resolveFieldPath(obj, path)` 函数：支持 dot-separated 路径解析（如 `stats.total`）
- 重写 `buildGateContext`：接收预加载的 `artifactCache: Map<string, unknown>` 替代 `readDocFn`
- `artifactField` 实现：从缓存中取 artifact 内容，调用 `resolveFieldPath` 提取字段值
- 重写 `buildEngineContext`：预加载所有已存在 artifact 的内容到缓存（JSON 自动解析，非 JSON 存原始字符串）
- 这修复了 dev workflow 的 `test-gate` 无法通过的问题

#### B.2: query_status 跳过 persistState ✅

**修改文件**：`src/tools/engine-helpers.ts`

**变更内容**：

- 在 `processWorkflowEvent` 中添加判断：`if (event.type !== 'query_status')` 才执行 `persistState`
- 避免只读的 query_status 事件产生不必要的磁盘写入

#### B.3: patch_start 持久化 issue_id/description ✅

**修改文件**：

- `src/core/types.ts`：`WorkflowState` 新增 `meta?: Record<string, unknown>` 可选字段
- `src/tools/patch-start.ts`：在 `initWorkflowState` 后将 `issue_id` 和 `description` 写入 `state.meta`，并立即 `persistState`

#### B.4: Validator cycle detection hasExit 逻辑 ✅

**修改文件**：

- `src/core/workflow-validator.ts`：`hasExit` 条件从 `maxRetries !== undefined && onExhausted !== undefined` 简化为 `maxRetries !== undefined`
- 更新相关注释和错误消息
- `tests/workflow-validator.test.ts`：更新测试用例，原 "should detect cycles with maxRetries but no onExhausted" 改为 "should not flag cycle when maxRetries is set without onExhausted"，预期从报 cycle 错误改为不报错

---

### P2: 可选改进 (2/4)

#### C.3: plugin.ts 静默 catch 改为日志输出 ✅

**修改文件**：`src/core/plugin.ts`

**变更内容**：

- `loadRoles` catch：区分 ENOENT（正常，目录不存在）和其他错误（warn 输出）
- `loadSchemas` catch：同上处理
- `loadActions` catch：`console.warn` 输出加载失败信息
- `loadHookCreator` catch：`console.warn` 输出加载失败信息

#### C.4: workflow.ts skipValidation 改为 false ✅

**修改文件**：`src/core/workflow.ts`

**变更内容**：

- `loadWorkflow` 中 `skipValidation` 从 `true` 改为 `false`（启用验证）
- 更新注释：移除 "roles/coordinator.md missing" 的过时说明
- coordinator.md 现在已经存在，验证可以正常运行

---

### P2: 暂缓处理 (2/4)

#### C.1: Gate fail path 类型判别 — 暂缓

**原因**：需要修改 `GotoTarget` 类型添加 discriminant 字段，影响面过大。当前 duck typing 功能正确。

#### C.2: reevaluateGates 只处理第一个 gate — 暂缓

**原因**：多个 gate 同时通过是边缘场景，当前行为在语义上安全（下次事件会继续处理）。

---

## 修改文件汇总

| 文件                               | 修改类型                                           |
| ---------------------------------- | -------------------------------------------------- |
| `src/tools/dispatch-role.ts`       | A.1 — beforeDispatch hook 集成                     |
| `src/tools/report-dispatch.ts`     | A.2 — afterComplete hook 集成                      |
| `src/tools/engine-helpers.ts`      | B.1 + B.2 — artifactField 实现 + query_status 优化 |
| `src/tools/patch-start.ts`         | B.3 — meta 持久化                                  |
| `src/core/types.ts`                | B.3 — WorkflowState.meta 字段                      |
| `src/core/workflow-validator.ts`   | B.4 — hasExit 逻辑修正                             |
| `src/core/plugin.ts`               | C.3 — 错误日志输出                                 |
| `src/core/workflow.ts`             | C.4 — 启用验证                                     |
| `workflows/dev/roles/architect.md` | A.3 — 术语修正                                     |
| `workflows/dev/roles/developer.md` | A.3 — 术语修正                                     |
| `workflows/dev/roles/tester.md`    | A.3 — 术语修正                                     |
| `tests/workflow-validator.test.ts` | B.4 — 测试用例更新                                 |
