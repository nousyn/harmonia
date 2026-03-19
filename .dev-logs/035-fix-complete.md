# 035 — 第二轮修复完成

> 执行 034-fix-plan.md 中的修复项。全部 10 项修复完成，406 项测试通过，TypeScript 编译零错误。

---

## 修复总结

### P1 — Bug 修复 (3 项)

#### F14 ✅ `handleFinalStep` 格式验证来源修正

- **文件**: `src/tools/artifact-tools.ts:476`
- **修改**: `stepDef.format === 'json'` → `artifactDef.format === 'json'`
- **说明**: 最终 artifact 校验应使用 artifact 级别的 format 定义，而非最后一个 step 的 format。中间步骤校验（第 394 行）仍正确使用 `stepDef.format`。

#### F19 ✅ `activateParallel` 子节点调度信息完整传递

- **文件**: `src/core/types.ts`, `src/core/workflow-engine.ts`, `src/tools/engine-helpers.ts`
- **修改**:
  1. `NextAction` 接口新增 `parallelDispatch?: Array<{ nodeId: string; role: string }>` 字段
  2. `activateParallel` 将 `dispatchActions` 数组放入返回值的 `parallelDispatch` 字段
  3. 移除无用的 `lastAction` 变量
  4. `instructions` 字符串包含各子任务的 role 和 nodeId 明细
  5. `formatNextAction` 支持 parallel dispatch 的格式化输出

#### F20 ✅ 工作流失败返回 `'failed'` 而非 `'completed'`

- **文件**: `src/core/types.ts`, `src/core/workflow-engine.ts`, `src/tools/engine-helpers.ts`, `src/setup/templates.ts`
- **修改**:
  1. `NextActionType` 新增 `'failed'` 类型
  2. `bubbleFailure` 根节点失败 → `type: 'failed'`
  3. `handleGoto` 重试耗尽 → `type: 'failed'`
  4. `computeStatusAction` 根节点 failed 状态 → `type: 'failed'`
  5. `formatNextAction` 新增 `'failed'` case
  6. coordinator prompt 文档新增 `type: "failed"` 说明
  7. 测试断言同步更新（2 处）

### P2 — 改进修复 (4 项)

#### F15 ✅ `readDoc` / `listDocs` 支持 JSON 格式

- **文件**: `src/core/docs.ts`
- **修改**: 扩展名列表从 `['.md', '.html']` 扩展为 `['.md', '.html', '.json']`。`listDocs` 的过滤和去扩展名逻辑同步更新。

#### F17 ✅ `ValidationError` 类型冲突消除

- **文件**: `src/core/schema.ts`
- **修改**: `ValidationError` → `ArtifactValidationError`（仅 schema.ts 内部使用）。`types.ts` 中的 `ValidationError` 保持不变（工作流验证器使用）。`ValidationResult.errors` 和 `formatValidationErrors` 参数类型同步更新。

#### F9 ✅ `buildOverrideSection` 去重

- **文件**: `src/tools/utils.ts`, `src/tools/dispatch-role.ts`, `src/tools/get-role-prompt.ts`
- **修改**: 将函数提取到 `utils.ts` 并导出。两个调用方改为引用共享版本。`dispatch-role.ts` 移除不再需要的 `CapabilityOverride` import。`get-role-prompt.ts` 移除不再需要的 `CapabilityOverride` 和 `OverrideConfig` import。

#### F10 ✅ `collectTaskNodes` / `findTaskNode` 去重

- **文件**: `src/tools/engine-helpers.ts`, `src/tools/dispatch-role.ts`, `src/tools/report-dispatch.ts`
- **修改**: 将 `collectTaskNodes` 和 `findTaskNode`（含 floating nodes 处理）提取到 `engine-helpers.ts`。`dispatch-role.ts` 移除本地实现，改为导入。`report-dispatch.ts` 移除 `findTaskNodeById` 和手动 floating nodes 查找，改用统一的 `findTaskNode`。移除不再需要的 `WorkflowNode` import。

### P3 — 清理 (3 项)

#### F12 ✅ 死代码移除

- **文件**: `src/tools/iteration-start.ts:57`
- **修改**: 删除未使用的 `rootState` 变量声明。

#### F7 ✅ 注释术语残留修复

- **文件**: `src/tools/dispatch-role.ts`, `src/tools/engine-helpers.ts`
- **修改**:
  - "of phase definitions" → 删除
  - "No scale filtering" → 删除
  - "not from phase" → "by workflow engine"
  - "Phase 4" → "TODO"

#### F8 ⏸️ `PHASE_IDLE_TIMEOUT_MINUTES` 变量名 — 延期

- **原因**: 该常量被嵌入到 3 个 agent hook 生成器（claude-code.ts, opencode.ts, openclaw.ts）的模板字符串中，变更变量名会同时影响生成的 bash/JS 脚本中的变量名。影响面较大且纯命名问题，延期到 hooks 外置（F1）时一并处理。

---

## 本轮延期项

| ID  | 问题                            | 原因                           |
| --- | ------------------------------- | ------------------------------ |
| F1  | Hooks 外置到 Plugin             | 架构级变更，需独立设计         |
| F2  | workflows/dev/tools.ts 缺失     | 无实际需求                     |
| F3  | Override 仍 3 层                | 全局文件通常不存在，不影响行为 |
| F4  | docs.ts 未重命名为 artifacts.ts | 涉及磁盘目录迁移，影响面大     |
| F5  | getInputArtifacts 空桩          | 标记为 TODO                    |
| F6  | workflow.ts 兼容层仍在用        | 需先解决所有依赖               |
| F8  | PHASE_IDLE_TIMEOUT_MINUTES 命名 | 随 F1 一并处理                 |
| F11 | resolveReview 缺 dir 参数       | contextDir 可选，当前自洽      |
| F18 | isRequired 类型签名不匹配       | 向后兼容，影响小               |

---

## 验证结果

```
TypeScript 编译: 零错误 ✅
测试: 22 文件 · 406 通过 · 0 失败 ✅
```

## 变更文件清单

| 文件                            | 变更类型                                                                   |
| ------------------------------- | -------------------------------------------------------------------------- |
| `src/core/types.ts`             | 新增 `'failed'` 到 NextActionType，新增 `parallelDispatch` 到 NextAction   |
| `src/core/workflow-engine.ts`   | 修改 activateParallel、bubbleFailure、handleGoto、computeStatusAction      |
| `src/core/docs.ts`              | readDoc/listDocs 新增 .json 支持                                           |
| `src/core/schema.ts`            | ValidationError → ArtifactValidationError                                  |
| `src/tools/artifact-tools.ts`   | handleFinalStep isJson 来源修正                                            |
| `src/tools/engine-helpers.ts`   | 新增 collectTaskNodes/findTaskNode，新增 failed case，更新 dispatch 格式化 |
| `src/tools/utils.ts`            | 新增 buildOverrideSection                                                  |
| `src/tools/dispatch-role.ts`    | 移除重复函数，使用共享引用                                                 |
| `src/tools/get-role-prompt.ts`  | 移除重复函数，使用共享引用                                                 |
| `src/tools/report-dispatch.ts`  | 移除 findTaskNodeById，使用共享 findTaskNode                               |
| `src/tools/iteration-start.ts`  | 移除死代码                                                                 |
| `src/setup/templates.ts`        | coordinator prompt 新增 failed 类型说明                                    |
| `tests/workflow-engine.test.ts` | 2 处断言更新 (completed → failed)                                          |
