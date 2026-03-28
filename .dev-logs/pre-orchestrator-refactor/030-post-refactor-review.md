# 030 — 重构后代码审查报告

> 状态：审查完成
> 日期：2026-03-19

## 概述

对照 027-core-architecture-design.md（设计）和 028-implementation-plan.md（实施计划），对重构后的完整源码进行逐模块审查，评估实现完成度、发现问题并提出优化建议。

**审查范围**：src/core/（15 个模块）、src/tools/（13 个文件）、src/hooks/（5 个文件）、src/setup/（2 个文件）、workflows/dev/（完整 plugin 目录）、tests/（22 个测试文件）

**总体结论：完成度约 85%，架构和核心引擎质量优秀，但存在 2 项 P0 功能缺失和若干术语残留。**

---

## 一、重构计划 vs 实现 — 完成项

| 计划项                                     | 实现情况                                            | 代码位置                                                           |
| ------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------ |
| 4 种节点类型 (task/sequence/parallel/gate) | ✅ 完整实现                                         | `types.ts` (612 行)                                                |
| 工作流引擎                                 | ✅ 完整实现，覆盖节点推进/gate 评估/goto/失败冒泡   | `workflow-engine.ts` (1168 行)                                     |
| 静态验证器 (7 项检查)                      | ✅ 完整实现                                         | `workflow-validator.ts` (479 行)                                   |
| Plugin 加载系统                            | ✅ 完整实现                                         | `plugin.ts` (373 行)                                               |
| Action 注册表                              | ✅ 完整实现                                         | `action-registry.ts` (60 行)                                       |
| 节点状态管理                               | ✅ 完整实现                                         | `state.ts` (145 行)                                                |
| nextAction 统一返回                        | ✅ 所有状态变更工具均正确返回                       | `engine-helpers.ts` (168 行)                                       |
| Scale 系统移除                             | ✅ 工具层和类型层已完全移除                         | —                                                                  |
| Override MCP 工具移除                      | ✅ 已移除，仅保留文件配置                           | —                                                                  |
| doc → artifact 工具重命名                  | ✅ 工具层已完成                                     | `artifact-tools.ts` / `approve-artifact.ts` / `artifact-schema.ts` |
| Dev workflow.json 节点树                   | ✅ 完整映射 5 阶段流程                              | `workflows/dev/workflow.json` (243 行)                             |
| coordinator.md 角色 prompt                 | ✅ 已完全更新术语                                   | `workflows/dev/roles/coordinator.md`                               |
| Hook 安装延迟到 project_init               | ✅ 已实现                                           | `project-init.ts:151-172`                                          |
| 新增核心测试                               | ✅ engine/validator/action-registry/plugin 全部到位 | 22 文件, 5684 行                                                   |

---

## 二、发现的问题

### P0 — 必须修复

#### 问题 1：节点钩子 (beforeDispatch / afterComplete) 未实现

设计文档 027 第十四节明确定义了两个钩子时机：

- **beforeDispatch**：Core 组装 rolePrompt 时，inject 合并到组员 prompt，actions 同步执行
- **afterComplete**：Core 收到完成报告时，inject 附带在返回给协调者的指引中，actions 同步执行

`ActionRegistry` 类已实现 (`action-registry.ts`, 60 行)，但 **没有任何工具调用它**。

**影响范围**：

- `dispatch-role.ts` — 派发角色时应执行 `beforeDispatch.actions` 并将 `beforeDispatch.inject` 合并到 rolePrompt，当前完全缺失
- `report-dispatch.ts` — completed 路径应执行 `afterComplete.actions` 并将 `afterComplete.inject` 附加到返回结果，当前完全缺失
- `workflow.json` 中定义的 inject 提示（如 `"确认 PRD 和 user-stories 已完成。检查是否需要审批。"`）不会生效
- workflow plugin 通过 `tools.ts` 注册的 action 永远不会被调用

**修复方案**：

```
dispatch-role.ts:
  1. 查找目标节点的 beforeDispatch 配置
  2. 如有 actions → 通过 ActionRegistry.execute() 执行每个 action
  3. 收集 action 返回的 inject + 节点定义的静态 inject
  4. 合并到组装的 rolePrompt 中

report-dispatch.ts (completed 路径):
  1. 查找 dispatch.nodeId 对应节点的 afterComplete 配置
  2. 如有 actions → 通过 ActionRegistry.execute() 执行
  3. 收集 inject 文本
  4. 附加到 formatNextAction 的输出中
```

#### 问题 2：角色 prompt 术语残留

coordinator.md 已完全更新，但其余 3 个角色文件存在旧术语，**影响 agent 运行时行为**：

**architect.md**：

| 行号 | 旧内容                        | 应改为                             |
| ---- | ----------------------------- | ---------------------------------- |
| 10   | `doc: tech-design`            | `artifact: tech-design`            |
| 12   | `doc: data-model`             | `artifact: data-model`             |
| 14   | `doc: api-design`             | `artifact: api-design`             |
| 18   | `doc: task-breakdown`         | `artifact: task-breakdown`         |
| 20   | `doc: risk-assessment`        | `artifact: risk-assessment`        |
| 39   | `根据 PM 提供的需求文档`      | `根据 coordinator 提供的需求文档`  |
| 65   | `必须通过 doc_write 工具写入` | `必须通过 artifact_write 工具写入` |
| 66   | `反馈给 PM`                   | `反馈给 coordinator`               |

**developer.md**：

| 行号           | 旧内容         | 应改为        |
| -------------- | -------------- | ------------- |
| 36, 37, 43, 44 | `PM` (共 4 处) | `coordinator` |

**tester.md**：

| 行号                 | 旧内容         | 应改为           |
| -------------------- | -------------- | ---------------- |
| capabilities 中 2 处 | `doc:`         | `artifact:`      |
| 37, 44               | `PM` (共 2 处) | `coordinator`    |
| 43                   | `doc_write`    | `artifact_write` |

**特别警告**：frontmatter 中 `doc:` 键名问题 — 如果 `plugin.ts` 的 `parseRoleFile` 解析 capabilities 时按 `artifact` 键查找关联，则 architect/tester 的 capability-artifact 关联将完全丢失。需确认 `RoleCapability` 接口中实际使用的键名。

---

### P1 — 应该修复

#### 问题 3：`artifact_field` Gate 条件未实现

`engine-helpers.ts:42-48` 的 `artifactField` 函数始终返回 `undefined`，标注了 TODO。

dev workflow.json 的 `test-gate` 使用了此条件：

```json
{
  "type": "artifact_field",
  "artifact": "test-report",
  "field": "result",
  "operator": "eq",
  "value": "pass"
}
```

**影响**：test-gate 条件评估永远为 false，测试通过后工作流无法正常推进到 deliver 阶段。

**修复方案**：在 `buildGateContext` 中，对 JSON 格式的 artifact 读取内容并解析字段值：

```typescript
artifactField: async (artifactId: string, field: string) => {
  try {
    const content = await readDoc(projectName, iteration, artifactId, contextDir);
    const data = JSON.parse(content);
    return data[field];
  } catch {
    return undefined;
  }
};
```

注意：这需要将 `GateContext.artifactField` 的签名从同步改为异步，或在构建 context 时预缓存 artifact 内容。

#### 问题 4：`query_status` 导致不必要的 state 写入

`processWorkflowEvent` (`engine-helpers.ts:111`) 对所有事件类型都执行 `persistState`，包括只读的 `query_status`。

每次调用 `project_status` 都会更新 `state.json` 的 `updatedAt` 时间戳，污染时间信息且产生不必要的磁盘 I/O。

**修复方案**：

```typescript
// engine-helpers.ts processWorkflowEvent 中
if (event.type !== 'query_status') {
  await persistState(projectName, ctx.number, result.state, ctx.dir);
}
```

#### 问题 5：`patch_start` 的 `issue_id` 和 `description` 参数未持久化

`patch-start.ts` 接受 `issue_id` 和 `description` 参数但仅用于输出文本显示，不写入 state。接口承诺了功能但没有交付。

**修复方案**：在 `WorkflowState` 中增加可选字段 `patchMeta?: { issueId?: string, description?: string }`，在 `initWorkflowState` 时写入。

#### 问题 6：验证器环检测过于保守

`workflow-validator.ts` 的 `detectCycles` 将任何没有同时具备 `maxRetries` + `onExhausted` 的 goto 都标记为 cycle 错误。

但在引擎实现中，只有 `maxRetries`（无 `onExhausted`）时会触发 `bubbleFailure`，这也是一种有效的退出路径。验证器对此过度严格。

**修复方案**：将 `hasExit` 判断条件从 `maxRetries !== undefined && onExhausted !== undefined` 放宽为 `maxRetries !== undefined`。

---

### P2 — 建议修复

#### 问题 7：Gate fail 路径的类型判断脆弱

`workflow-engine.ts:288` 使用鸭子类型判断区分 `GotoTarget` 和 `WorkflowNode`：

```typescript
'goto' in node.fail && !('type' in node.fail);
```

依赖 `GotoTarget` 没有 `type` 字段这一隐式约定。如果未来给 `GotoTarget` 添加 `type` 字段会导致逻辑错误。

**建议**：给 `GotoTarget` 添加判别字段 `kind: 'goto'`，使用显式判别而非属性探测。

#### 问题 8：`reevaluateGates` 只处理第一个通过的 gate

`workflow-engine.ts:920-921` 中，如果多个 gate 因同一个 artifact 事件同时通过，只会处理第一个（函数内有 `return`）。

在当前 dev workflow 的线性结构中不太可能触发此问题，但在复杂的并行工作流中可能成为隐患。

#### 问题 9：Plugin 加载静默吞掉错误

`plugin.ts` 中 3 处关键 `catch {}`：

- `loadActions` (第 214 行) — tools.ts 加载失败时静默跳过
- `loadHookCreator` (第 241 行) — hooks.ts 加载失败时静默跳过
- `loadRoles` (第 158 行) — roles/ 读取失败时静默跳过

如果 plugin 文件有语法错误或权限问题，不会输出任何警告，使调试极为困难。

**建议**：改为 `catch (e) { console.warn('[harmonia] Failed to load ...:', e.message) }`。

#### 问题 10：`workflow.ts` 兼容层应清理

`workflow.ts` 已标记 `@deprecated`，但仍被两个模块调用：

- `schema.ts` → 调用 `resolveWorkflowDir()`
- `artifact-tools.ts` → 调用 `loadWorkflow()`

其中 `loadWorkflow()` 传入 `skipValidation=true`，注释说 "roles/coordinator.md missing"，但 `coordinator.md` 实际已存在。应迁移调用者直接使用 `plugin.ts`，然后删除 `workflow.ts`。

---

## 三、术语残留汇总

### 核心模块函数名（P2，不影响运行但影响代码一致性）

| 文件                    | 旧函数名/变量名                     | 应改为                                             |
| ----------------------- | ----------------------------------- | -------------------------------------------------- |
| `src/core/docs.ts`      | `writeDoc` / `readDoc` / `listDocs` | `writeArtifact` / `readArtifact` / `listArtifacts` |
| `src/core/reviews.ts`   | `getDocReview()`                    | `getArtifactReview()`                              |
| `src/core/steps.ts`     | `isDocFinalized()`                  | `isArtifactFinalized()`                            |
| `src/core/overrides.ts` | `resolveDocReview()`                | `resolveArtifactReview()`                          |
| 多处参数名              | `docId`, `docDef`                   | `artifactId`, `artifactDef`                        |

### Hook 层常量名（P1）

| 文件                       | 旧名称                       | 应改为                          |
| -------------------------- | ---------------------------- | ------------------------------- |
| `src/hooks/content.ts:124` | `PHASE_IDLE_TIMEOUT_MINUTES` | `WORKFLOW_IDLE_TIMEOUT_MINUTES` |

### Schema 层兼容代码（P2）

| 文件                         | 内容                                 | 处理                               |
| ---------------------------- | ------------------------------------ | ---------------------------------- |
| `src/core/schema.ts:115-121` | `isRequired()` 兼容旧 scale 对象格式 | 所有 schema 已迁移，可移除兼容分支 |

---

## 四、引擎实现细节审查

### 设计亮点

1. **被动状态机**：Core 不主动推进，每次由 coordinator 调用工具触发事件 → engine 计算 → 返回 nextAction。完美适配 MCP server 的被动约束。

2. **Gate 自动重评估**：artifact_written / artifact_approved 事件触发 `reevaluateGates()`，实现数据驱动的工作流推进，不需要 coordinator 手动检查 gate。

3. **Goto + Retry 机制**：失败后跳回目标节点重试，`retryCount` 递增（目标节点 +1，后续节点重置为 0），配合 `maxRetries` + `onExhausted` 提供可控容错。

4. **失败冒泡**：sequence 节点失败向上冒泡，parallel 节点根据 `failStrategy` (fail-fast / wait-all) 决定行为，逻辑完整。

### 值得注意的实现细节

1. **`activateParallel` 返回值**：循环中 `lastAction` 被赋值但未使用，最终构造了一个新的多重 dispatch 指令对象。属于无害的重构残留。

2. **`collectSubsequentNodeIds` 算法**：goto 时重置"目标节点之后"的所有节点。算法沿从根到目标的路径向上遍历，对 sequence 中目标之后的兄弟收集整个子树，对 parallel 的兄弟不重置（并发关系而非顺序关系）。逻辑正确。

3. **`markCompleted` 与 `completeNode` 双重调用**：`markCompleted` 先设置节点为 completed 再调用 `completeNode`，后者再次设置同一节点为 completed。冗余但幂等，不会导致错误。

4. **浅拷贝策略**：`computeNextAction` 做 `{ ...state, nodes: { ...state.nodes } }` 的浅拷贝，每个 NodeState 都创建新对象 `{ ...existing, ... }`，保证不修改原引用。正确。

---

## 五、nextAction 返回覆盖情况

| 工具               | 返回 nextAction    | 说明                                                 |
| ------------------ | ------------------ | ---------------------------------------------------- |
| `artifact_write`   | ✅                 | 通过 `artifact_written` 事件触发引擎                 |
| `artifact_approve` | ✅ (approved 路径) | rejected 路径不触发（正确）                          |
| `artifact_read`    | ➖ 不返回          | 只读工具，合理                                       |
| `artifact_list`    | ➖ 不返回          | 只读工具，合理                                       |
| `artifact_schema`  | ➖ 不返回          | 只读工具，合理                                       |
| `role_dispatch`    | ✅                 | 通过 `dispatch_requested` 事件                       |
| `dispatch_report`  | ✅                 | completed → `node_completed`，failed → `node_failed` |
| `project_init`     | ➖ 不返回          | 指引调用 `iteration_start`，合理                     |
| `project_status`   | ✅                 | 通过 `query_status` 事件                             |
| `iteration_start`  | ✅                 | 通过 `startWorkflow`                                 |
| `patch_start`      | ✅                 | 通过 `startWorkflow`                                 |
| `review_list`      | ➖ 不返回          | 只读工具，合理                                       |

**结论**：nextAction 返回机制**完整且正确**，是重构最成功的部分之一。

---

## 六、测试覆盖评估

| 测试文件                     | 行数 | 覆盖内容                                           |
| ---------------------------- | ---- | -------------------------------------------------- |
| `workflow-engine.test.ts`    | 1312 | 核心引擎（最大测试文件）                           |
| `workflow-validator.test.ts` | 452  | 静态验证器 7 项检查                                |
| `plugin.test.ts`             | 307  | Plugin 发现/加载/验证                              |
| `action-registry.test.ts`    | 158  | Action 注册和执行                                  |
| `state.test.ts`              | 347  | 节点状态管理                                       |
| `dispatch.test.ts`           | 357  | Session/Dispatch CRUD                              |
| `hooks.test.ts`              | 419  | Hook 安装/内容                                     |
| 其余 15 个文件               | 2332 | schema/steps/reviews/overrides/issues/CLI/setup 等 |

**总计 22 个文件，5684 行，406 个测试全部通过。**

新架构核心组件（engine/validator/action-registry/plugin）的测试全部到位。测试中无残留的 scale/phase_update 功能引用（仅有回归保护性断言确认已删除）。

---

## 七、修复优先级建议

```
阶段 A（P0，阻塞功能正确性）:
  ├── A.1  实现 beforeDispatch 钩子 (dispatch-role.ts)
  ├── A.2  实现 afterComplete 钩子 (report-dispatch.ts)
  └── A.3  修复角色 prompt 术语 (architect.md / developer.md / tester.md)

阶段 B（P1，影响流程完整性）:
  ├── B.1  实现 artifactField gate 条件 (engine-helpers.ts)
  ├── B.2  query_status 跳过 persistState
  ├── B.3  patch_start 参数持久化
  └── B.4  放宽验证器环检测条件

阶段 C（P2，代码质量优化）:
  ├── C.1  GotoTarget 添加判别字段
  ├── C.2  Plugin 加载添加 warn 日志
  ├── C.3  移除 workflow.ts 兼容层
  └── C.4  术语统一 (doc→artifact 函数名/参数名/常量名)
```

---

## 八、总体评价

**架构设计：优秀。** 四种节点类型 + 树状工作流模型表达力强，被动引擎 + nextAction 的模式完美适配 MCP server 约束，Gate + Goto + Retry 提供了灵活的流程控制和容错能力。

**实现质量：良好，但有关键遗漏。** 核心引擎（1168 行）和验证器（479 行）实现扎实，测试覆盖充分。最大的问题是钩子系统 `ActionRegistry` 已建好但未接入工具层（相当于建了发动机但没连传动轴），以及 `artifact_field` 未实现导致 test-gate 无法正常工作。

**完成度估算：~85%。** 架构骨架和核心逻辑 100% 完成，剩余工作集中在：钩子接入（P0）、artifact_field 实现（P1）、术语清理（P0/P2）。预计修复工作量为中等。
