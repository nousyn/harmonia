# 050 — Loop 循环节点

> 新增 `loop` 流程控制原语，支持单节点/子流程的可控重复执行，带迭代状态管理。

---

## 背景

### 问题

当前 Harmonia 的 task 是"一次性派遣"模型 — coordinator 派遣一个角色，角色执行完毕，task 结束。对于"产出一份文档"类的任务足够，但对于"执行一组子任务"类的工作不够用。

具体场景：architect 产出 task-breakdown（功能清单），developer 需要按清单逐条/分批开发，每完成一批后可能需要人工审核。当前只能一次性派遣 developer，中间没有可见性和干预点。

### 现有机制的不足

- **goto**：语义是流程级跳转（通常是失败重试），每次回跳上下文重置，无迭代状态累积
- **重复配置 task**：静态的，无法适应动态数量的子任务
- **依赖 coordinator prompt**：让 coordinator 自行多轮派遣，不可靠

### 设计目标

引入 `loop` 作为新的流程控制原语，和 `sequence`、`parallel`、`gate` 同级：

| 原语     | 语义                           |
| -------- | ------------------------------ |
| sequence | 子节点顺序执行                 |
| parallel | 子节点并行执行                 |
| gate     | 条件分支                       |
| **loop** | **子流程重复执行，带迭代状态** |

---

## 设计决策

### D1：loop 是纯粹的循环容器

loop 不关心数据源、不关心批次逻辑、不关心条目内容。所有业务逻辑（分批、注入指令等）由 `beforeDispatch.actions` 自定义实现。

**理由**：Harmonia 是编排层，不应理解内容结构。不同场景写不同的 action 就行，loop 原语保持通用。

### D2：终止控制 — `loop_done` 工具 + `maxIterations`

- 提供 `loop_done` MCP 工具，由 coordinator 调用，终止指定 loop
- `maxIterations` 作为硬上限安全兜底，防止无限循环
- 不需要 action 校验层

**理由**：与现有架构一致 — coordinator 通过调用工具驱动流程（`role_dispatch`、`dispatch_report`、`artifact_approve`），`loop_done` 只是多一个工具。Harmonia 整体设计建立在 coordinator 遵循 nextAction 指引的前提上，`loop_done` 不例外。action 校验会引入额外复杂度但不增加本质可靠性。

### D3：不需要引擎层暂停机制

每轮 body 结束后，coordinator 已在与用户对话的状态中。需要人工审核时，通过 action 注入提示词到数据包，由组员和 coordinator 在现有交互链路中完成。

**理由**：引擎层强制暂停最终也要通过 coordinator 执行恢复动作，链路上并没有减少对 LLM 的依赖。暂停是 coordinator 层面的事，不是引擎层面的事。

### D4：body 是 WorkflowNode，可以是任意节点类型

loop 的 body 可以是 task、sequence、gate 等任意节点。

**理由**：loop 是流程控制原语，body 内部可以是任意复杂的子流程。比如每轮迭代内部可以包含 develop → code-review-gate 的子流程。

### D5：body 内 goto 遵循现有祖先链规则，可以跳出 loop

body 不是独立的根节点，body 内的 gate goto 遵循现有祖先链约束，可以跳转到 loop 外部的祖先节点。跳出后 loop 状态重置。

**理由**：与 sequence、parallel 内的 goto 行为一致，不引入特殊规则。

### D6：迭代状态 — 引擎维护 `currentIteration`

引擎在 workflow state 中记录 loop 的 `currentIteration`（从 0 开始），传递给 action，让 action 能基于轮次做业务判断。

**理由**：action 需要知道当前是第几轮才能实现分批逻辑。没有它，action 每轮看到的上下文都一样，无法区分第一轮和第五轮。

### D7：不记录产出

loop 不关心 body 内部产出了什么。产出通过 artifact 体系自然累积。

**理由**：loop 是流程控制原语，不应耦合内部产出。

### D8：body 内 task 失败 — 向上传播

body 内的 task 失败时，与普通 sequence 内子节点失败的处理逻辑一致：

- task 配了 `onFailed`：走 goto 回退重试（task 自身配置，与 loop 无关）
- task 没配 `onFailed`：失败向上传播到 loop，loop 标记为 failed

**理由**：loop 是循环容器，不应有自己的容错逻辑。保持与其他容器节点一致。

### D9：`loop_done` 是标记，不是立即终止

coordinator 调用 `loop_done` 后，引擎将 loop 状态中的 `done` 标记为 `true`，但**不立即终止当前迭代**。当前迭代的 body 继续执行完毕后，引擎在 `handleLoopBodyComplete` 中检查 `done` 字段，决定终止 loop。

**理由**：立即终止会导致 body 内正在执行的 task 状态不一致。loop 的自然终止点是每轮 body 完成后。

### D10：`maxIterations` 到达标记为 failed

`maxIterations` 是安全兜底。正常流程中 coordinator 应在合适时机调用 `loop_done` 终止循环。到达 `maxIterations` 说明 coordinator 未正常终止，属于异常情况，标记为 failed。

**理由**：标记为 completed 会让后续流程继续执行，但任务可能并未真正完成。标记为 failed 后，loop 的 `onFailed` 可以接管处理（如 escalate），给流程恢复机会。

---

## 类型定义变更

### LoopNode（新增）

```typescript
/** Loop node — repeated execution of a sub-workflow with iteration state */
export interface LoopNode {
  type: 'loop';
  id: string;
  /** Maximum iterations (safety cap) */
  maxIterations: number;
  /** The sub-workflow to repeat each iteration */
  body: WorkflowNode;
  /** Optional failure handler */
  onFailed?: FailureHandler;
}
```

### WorkflowNode 联合类型（修改）

```typescript
// 之前
export type WorkflowNode = TaskNode | SequenceNode | ParallelNode | GateNode;

// 之后
export type WorkflowNode = TaskNode | SequenceNode | ParallelNode | GateNode | LoopNode;
```

### NodeType（修改）

```typescript
// 之前
export type NodeType = 'task' | 'sequence' | 'parallel' | 'gate';

// 之后
export type NodeType = 'task' | 'sequence' | 'parallel' | 'gate' | 'loop';
```

### LoopNodeState（新增，扩展 NodeState）

```typescript
export interface LoopNodeState extends NodeState {
  /** Current iteration index (0-based) */
  currentIteration: number;
  /** Whether loop_done has been called — loop will terminate after current iteration completes */
  done: boolean;
}
```

### ActionContext（修改）

```typescript
export interface ActionContext {
  artifacts: { read: (id: string) => Promise<string> };
  // 新增
  loopIteration?: number;
}
```

### WorkflowEvent（新增事件类型）

```typescript
export type WorkflowEvent =
  | { type: 'node_completed'; nodeId: string; result?: unknown }
  | { type: 'node_failed'; nodeId: string; error: string }
  | { type: 'artifact_written'; artifactId: string }
  | { type: 'artifact_approved'; artifactId: string }
  | { type: 'dispatch_requested'; nodeId: string }
  | { type: 'query_status' }
  | { type: 'loop_done'; nodeId: string }; // 新增
```

---

## 实现计划

### Phase 1：类型定义（5 tasks）

#### 1.1 新增 `LoopNode` 接口

- 文件：`src/core/types.ts`
- 在 `GateNode` 之后新增 `LoopNode` 接口定义

#### 1.2 修改 `WorkflowNode` 联合类型

- 文件：`src/core/types.ts`
- 将 `LoopNode` 加入 `WorkflowNode` 联合类型

#### 1.3 修改 `NodeType`

- 文件：`src/core/types.ts`
- 将 `'loop'` 加入 `NodeType`

#### 1.4 新增 `LoopNodeState` 接口

- 文件：`src/core/types.ts`
- 扩展 `NodeState`，增加 `currentIteration` 字段

#### 1.5 新增 `loop_done` 事件类型

- 文件：`src/core/types.ts`
- 在 `WorkflowEvent` 联合类型中新增 `{ type: 'loop_done'; nodeId: string }`

### Phase 2：引擎核心逻辑（9 tasks）

#### 2.1 `collectNodeStates` 增加 loop 分支

- 文件：`src/core/workflow-engine.ts`
- `collectNodeStates` 负责初始化所有节点状态（`initNodeStates` 调用），当前只处理 sequence/parallel/gate/task
- 增加 `case 'loop'`：递归处理 `loop.body`，确保 body 内所有节点的初始状态被创建

#### 2.2 `activateNode` 增加 loop 分支

- 文件：`src/core/workflow-engine.ts`
- 在 `activateNode` 的 switch 中增加 `case 'loop'`，调用新函数 `activateLoop`

#### 2.3 实现 `activateLoop`

- 文件：`src/core/workflow-engine.ts`
- 初始化 loop 状态（`currentIteration: 0`）
- 激活 body 节点（调用 `activateNode(loop.body, ...)`）

#### 2.4 `completeNode` 增加 loop 父节点处理

- 文件：`src/core/workflow-engine.ts`
- 在 `completeNode` 的 `parentInfo.parent.type` switch 中增加 `case 'loop'`
- 调用新函数 `handleLoopBodyComplete`

#### 2.5 实现 `handleLoopBodyComplete`

- 文件：`src/core/workflow-engine.ts`
- 当 body 完成时：
  - 检查 loop 状态 `done` 是否为 true（由 `loop_done` 事件标记）→ 是则标记 loop 为 completed，向上传播
  - 检查 `currentIteration + 1 >= maxIterations` → 是则标记 loop 为 **failed**（安全兜底触发意味着异常），向上传播
  - 否则：`currentIteration++`，重置 body 内所有节点状态为 pending，重新激活 body

#### 2.6 实现 body 节点状态重置逻辑

- 文件：`src/core/workflow-engine.ts`
- 新函数 `resetLoopBody(state, loopNode)`：收集 body 内所有节点 ID，将其状态重置为 pending（retryCount 也重置为 0）
- 可复用 `collectAllNodeIds` 函数

#### 2.7 处理 `loop_done` 事件

- 文件：`src/core/workflow-engine.ts`
- 在 `computeNextAction` 的 switch 中增加 `case 'loop_done'`
- 在 loop 的 `LoopNodeState` 上将 `done` 设为 `true`
- 返回 wait 类型的 nextAction，告知 coordinator loop 将在当前迭代完成后终止
- **语义明确**：`loop_done` 不是立即终止，而是标记。当前迭代 body 继续执行完毕后，引擎在 `handleLoopBodyComplete` 中检查 `done` 字段决定终止

#### 2.8 `getFailureHandler` 增加 loop 支持

- 文件：`src/core/workflow-engine.ts`
- `getFailureHandler` 当前只对 `task` 和 `parallel` 返回 `onFailed`，loop 也有 `onFailed`
- 增加 `node.type === 'loop'` 分支，返回 `node.onFailed`
- 不改此函数则 loop 失败时 `onFailed` 永远不会被触发，失败会直接冒泡跳过 loop 自身的处理

#### 2.9 `bubbleFailure` 确认 loop 父节点传播路径

- 文件：`src/core/workflow-engine.ts`
- `bubbleFailure` 对 `parallel` 有特殊处理（fail-fast / wait-all），其余走 `failNode(parent.id)`
- loop 作为父节点时走 else 分支 → `failNode` → `getFailureHandler`（2.8 已修改）→ 检查 `onFailed`
- 确认此路径正确即可，无需额外代码变更，但实现时需验证

### Phase 3：验证器（5 tasks）

#### 3.1 `collectAndValidateIds` 增加 loop 分支

- 文件：`src/core/workflow-validator.ts`
- 在递归遍历中增加 `case 'loop'`，递归处理 body

#### 3.2 `validateGotoTargets` 增加 loop 分支

- 文件：`src/core/workflow-validator.ts`
- 在 goto 目标验证的递归中增加 loop 处理
- body 内的 goto 可达范围包括 body 内部节点 + loop 的祖先链上的节点

#### 3.3 `validateRoleReferences` 增加 loop 分支

- 文件：`src/core/workflow-validator.ts`
- 递归进入 body 检查 role 引用

#### 3.4 `validateInputArtifactReferences` 增加 loop 分支

- 文件：`src/core/workflow-validator.ts`
- 递归进入 body 检查 inputArtifacts 引用

#### 3.5 新增 loop 专属验证

- 文件：`src/core/workflow-validator.ts`
- 验证 `maxIterations` 必须为正整数
- 验证 `body` 存在且为有效 WorkflowNode
- 验证 loop 的 `onFailed`（如有）的 goto 目标合法性

### Phase 4：`loop_done` MCP 工具（3 tasks）

#### 4.1 创建 `loop-done.ts` 工具文件

- 文件：`src/tools/loop-done.ts`（新文件）
- 注册 `loop_done` MCP 工具
- 参数：`project_name`、`node_id`（loop 节点的 ID）
- 验证：
  - 项目存在且有活跃上下文
  - `node_id` 对应的节点确实是 loop 类型
  - 该 loop 当前处于 active 状态
- 调用 `processWorkflowEvent` 发送 `{ type: 'loop_done', nodeId }` 事件
- 返回确认信息 + nextAction

#### 4.2 在 MCP server 中注册工具

- 文件：`src/index.ts`（第 85-116 行，MCP 工具集中注册区域）
- 新增 `import` 和 `registerLoopDone(server, WORKFLOWS_DIR)` 调用

#### 4.3 `processWorkflowEvent` 增加 `loop_done` 事件处理

- 文件：`src/tools/engine-helpers.ts`
- 如果 `processWorkflowEvent` 中有事件类型过滤或预处理，确保 `loop_done` 事件能正确传递到引擎

### Phase 5：ActionContext 扩展（2 tasks）

#### 5.1 ActionContext 增加 `loopIteration` 字段

- 文件：`src/core/types.ts`（或 action-registry 相关文件）
- 在 ActionContext 中新增 `loopIteration?: number`

#### 5.2 action 执行时注入 loopIteration

- 文件：`src/tools/dispatch-role.ts`（第 406-418 行，ActionContext 构建区域）
- 当 task 处于 loop 内部时，从 workflow definition 中找到父级 loop 节点，再从 `workflowState.nodes[loopId]` 的 `LoopNodeState` 中读取 `currentIteration`，赋给 `actionCtx.loopIteration`
- 不在 loop 内部时，`loopIteration` 为 `undefined`

### Phase 6：辅助函数适配（7 tasks）

#### 6.1 `findParent` 增加 loop 支持

- 文件：`src/core/workflow-engine.ts`
- `findParent` 递归查找父节点时，需要递归进入 loop 的 body

#### 6.2 `collectAllNodeIds` 增加 loop 支持

- 文件：`src/core/workflow-engine.ts`
- 递归收集 loop 的 body 中所有节点 ID

#### 6.3 `collectSubsequentNodeIds` / `findPathTo` 增加 loop 支持

- 文件：`src/core/workflow-engine.ts`
- `findPathTo` 当前只递归 sequence/parallel/gate，需增加 loop 分支递归进入 body
- `collectSubsequentNodeIds` 依赖 `findPathTo`，如果 goto 目标在 loop 内部或穿过 loop，不改 `findPathTo` 则找不到路径
- goto 状态重置时，如果目标在 loop 外，loop 及其 body 内所有节点需要被重置

#### 6.4 `findNode` / `findNodeInTree` 增加 loop 支持

- 文件：`src/core/workflow-engine.ts`
- 递归查找节点时需要递归进入 loop 的 body

#### 6.5 `findActiveGates` 增加 loop 支持

- 文件：`src/core/workflow-engine.ts`
- reevaluateGates 查找活跃 gate 时，需要递归进入 active 的 loop 的 body

#### 6.6 `collectTaskNodes` 增加 loop 支持

- 文件：`src/tools/engine-helpers.ts`
- `collectTaskNodes` 递归收集 task 节点，被 `findDispatchableNodes`（dispatch-role.ts）和 `findTaskNode` 使用
- 不改则 loop body 内的 task 节点无法被自动发现，coordinator 无法 auto-dispatch loop 内任务

#### 6.7 `collectSubtreeIds` 增加 loop 支持

- 文件：`src/core/workflow-validator.ts`
- `collectSubtreeIds` 是验证器的辅助函数，收集子树所有 ID，被 `validateGotoTargets` 使用
- 需增加 `case 'loop'` 递归进入 body

### Phase 7：`project_status` 展示（1 task）

#### 7.1 loop 状态展示

- 文件：`src/tools/get-project-status.ts`
- 展示 loop 节点的当前迭代轮次、maxIterations、是否已标记 done

### Phase 8：`plugin.ts` 适配（0 tasks）

不需要修改。`loadDefinition` 使用 `JSON.parse` + `as` 类型断言，新增的 `loop` 类型会自动从 JSON 映射。

### Phase 9：测试（5 tasks）

#### 9.1 引擎测试 — loop 基本流程

- 文件：`tests/workflow-engine.test.ts`
- 测试 loop 激活、body 执行完成后自动开始下一轮、currentIteration 递增

#### 9.2 引擎测试 — loop 终止

- 文件：`tests/workflow-engine.test.ts`
- 测试 `loop_done` 事件后 body 完成时 loop 终止
- 测试 `maxIterations` 到达时 loop 终止

#### 9.3 引擎测试 — loop 内失败传播

- 文件：`tests/workflow-engine.test.ts`
- 测试 body 内 task 失败无 onFailed 时向上传播到 loop
- 测试 body 内 task 有 onFailed 时正常重试
- 测试 loop 自身有 onFailed 时的处理

#### 9.4 引擎测试 — loop 内 goto 跳出

- 文件：`tests/workflow-engine.test.ts`
- 测试 body 内 gate fail goto 到 loop 外部节点时，loop 状态重置

#### 9.5 验证器测试 — loop 验证

- 文件：`tests/workflow-validator.test.ts`
- 测试 loop 节点的 ID 唯一性检查
- 测试 maxIterations 验证
- 测试 body 内 goto 目标的合法性检查
- 测试 body 内 role 和 inputArtifacts 引用检查
- 测试嵌套 loop（loop body 内包含另一个 loop）的验证

### Phase 10：类型检查 + 全量测试（1 task）

#### 10.1 验证

- 执行 `tsc --noEmit` 确保类型检查通过
- 执行全量测试套件确保所有测试通过

---

## 文件变更清单

| 文件                               | 变更类型 | 说明                                                                                                                                                                                                                                                      |
| ---------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/types.ts`                | 修改     | 新增 LoopNode、LoopNodeState，修改 WorkflowNode、NodeType、WorkflowEvent、ActionContext                                                                                                                                                                   |
| `src/core/workflow-engine.ts`      | 修改     | activateNode、completeNode、collectNodeStates、getFailureHandler、findParent、collectAllNodeIds、collectSubsequentNodeIds、findPathTo、findNode、findNodeInTree、findActiveGates 增加 loop 分支；新增 activateLoop、handleLoopBodyComplete、resetLoopBody |
| `src/core/workflow-validator.ts`   | 修改     | 所有递归验证函数增加 loop 分支（含 collectSubtreeIds）；新增 loop 专属验证                                                                                                                                                                                |
| `src/tools/loop-done.ts`           | 新增     | `loop_done` MCP 工具                                                                                                                                                                                                                                      |
| `src/tools/engine-helpers.ts`      | 修改     | processWorkflowEvent 适配 loop_done 事件（如需要）；collectTaskNodes 增加 loop 分支                                                                                                                                                                       |
| `src/tools/get-project-status.ts`  | 修改     | loop 状态展示                                                                                                                                                                                                                                             |
| `src/tools/dispatch-role.ts`       | 修改     | beforeDispatch action 执行时注入 loopIteration                                                                                                                                                                                                            |
| `tests/workflow-engine.test.ts`    | 修改     | 新增 loop 相关引擎测试                                                                                                                                                                                                                                    |
| `tests/workflow-validator.test.ts` | 修改     | 新增 loop 验证测试                                                                                                                                                                                                                                        |

---

## 不变更

| 文件                          | 理由                                       |
| ----------------------------- | ------------------------------------------ |
| `src/core/plugin.ts`          | JSON.parse + as 断言，新类型自动映射       |
| `workflows/dev/workflow.json` | 本计划只实现 loop 原语，不改现有工作流配置 |
