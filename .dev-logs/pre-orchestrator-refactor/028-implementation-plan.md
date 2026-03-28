# 028 — Core 重构实施计划

> 状态：计划
> 日期：2026-03-18

## 概述

将 Harmonia 从硬编码的开发流程引擎重构为**通用多智能体协作框架**。核心变更：

1. 工作流引擎从"线性阶段管道"变为"树状节点执行引擎"
2. 所有 dev 特有逻辑提取到 `workflows/dev/` 插件
3. Core 提供通用原语：节点执行、artifact 管理、dispatch/session、gate 评估
4. 每个工具返回统一的 `nextAction` 指引

### 范围约束

- **Dev 工作流所有功能必须完整保留**
- Scale 系统完全移除
- Override MCP 工具移除（保留文件配置）
- `doc` 术语全部重命名为 `artifact`

---

## 一、模块拆分

### 1.1 Core 层（src/core/）

| 模块                      | 文件             | 状态                                                           | 说明 |
| ------------------------- | ---------------- | -------------------------------------------------------------- | ---- |
| **types.ts**              | 重写             | 新架构类型定义：节点类型、gate、nextAction、ActionContext 等   |
| **workflow-engine.ts**    | 新建             | 节点状态机：节点状态追踪、转换、gate 评估、goto 处理           |
| **workflow-validator.ts** | 新建             | 静态验证：id 唯一性、goto 合法性、环检测、角色引用检查         |
| **workflow-loader.ts**    | 重写 workflow.ts | Plugin 加载器：扫描目录、注册角色/schema/action、加载 hooks.ts |
| **artifact.ts**           | 重写 docs.ts     | 通用 artifact 读写（重命名，逻辑基本不变）                     |
| **dispatch.ts**           | 微调             | 移除 phase 相关的 expectedOutputs 逻辑，改为节点驱动           |
| **reviews.ts**            | 保留             | 审批机制不变                                                   |
| **steps.ts**              | 保留             | 顺序写入步骤追踪不变                                           |
| **schema.ts**             | 微调             | 移除 scale 相关的 section required 判断                        |
| **registry.ts**           | 微调             | 目录结构调整：docs/ → artifacts/                               |
| **overrides.ts**          | 简化             | 移除全局层、移除 MCP 工具支持，保留两层合并                    |
| **issues.ts**             | 保留             | 不变                                                           |
| **state.ts**              | 重写             | 从 phase-based 状态变为节点状态树                              |
| **action-registry.ts**    | 新建             | 节点钩子 action 注册和执行                                     |
| **plugin.ts**             | 新建             | Plugin 接口定义、discovery、加载协调                           |

### 1.2 工具层（src/tools/）

| 工具                 | 文件                | 状态                                              | 说明 |
| -------------------- | ------------------- | ------------------------------------------------- | ---- |
| **project_init**     | 重写                | 接受 `workflow` 参数，加载 plugin，安装 hooks     |
| **iteration_start**  | 微调                | 初始化节点状态树而非 phase 列表                   |
| **project_status**   | 重写                | 显示节点树状态而非 phase 状态                     |
| **artifact_write**   | 重写 doc-tools.ts   | 重命名 + 写入后触发 gate 评估 + 返回 nextAction   |
| **artifact_read**    | 重写 doc-tools.ts   | 重命名                                            |
| **artifact_list**    | 重写 doc-tools.ts   | 重命名                                            |
| **artifact_approve** | 重写 approve-doc.ts | 重命名 + 审批后触发 gate 评估 + 返回 nextAction   |
| **artifact_schema**  | 重写 doc-schema.ts  | 重命名                                            |
| **role_dispatch**    | 重写                | 基于节点而非 phase，Core 组装完整 rolePrompt      |
| **dispatch_report**  | 重写                | 完成报告触发 afterComplete 钩子 + 返回 nextAction |
| **get_role_prompt**  | 保留/微调           |                                                   |
| **patch_start**      | 微调                | 适配新状态结构                                    |
| **issue_tools**      | 保留                | 不变                                              |
| ~~set_scale~~        | 删除                | Scale 移除                                        |
| ~~phase_update~~     | 移到 plugin         | Dev 特定工具                                      |
| ~~override_tools~~   | 删除                | Override MCP 工具移除                             |

### 1.3 Hook 层（src/hooks/）

| 模块                     | 状态        | 说明                                   |
| ------------------------ | ----------- | -------------------------------------- |
| **hooks/install.ts**     | 保留        | 通用安装器，接收 plugin 提供的 HookSet |
| **hooks/claude-code.ts** | 移到 plugin | Dev 特定 hook 内容                     |
| **hooks/opencode.ts**    | 移到 plugin | Dev 特定 hook 内容                     |
| **hooks/openclaw.ts**    | 移到 plugin | Dev 特定 hook 内容                     |
| **hooks/content.ts**     | 移到 plugin | Dev 特定常量                           |

### 1.4 Setup 层

| 模块                   | 状态 | 说明                                       |
| ---------------------- | ---- | ------------------------------------------ |
| **setup/templates.ts** | 重写 | 通用 coordinator prompt，不含 dev 特定指引 |
| **setup/inject.ts**    | 保留 | 注入逻辑不变                               |
| **cli/setup.ts**       | 微调 | 拷贝 workflow plugin 到 data_dir           |

### 1.5 Dev Workflow Plugin（workflows/dev/）

| 文件                | 说明                                             |
| ------------------- | ------------------------------------------------ |
| **workflow.json**   | 重写为节点树结构（sequence/task/gate/parallel）  |
| **roles/\*.md**     | 保留，pm.md 重命名为 coordinator.md              |
| **schemas/\*.json** | 保留，移除 scale 相关字段                        |
| **hooks.ts**        | 新建，从 src/hooks/ 迁移过来                     |
| **tools.ts**        | 新建，注册 dev 特定工具（phase_update）和 action |

---

## 二、实施顺序

### 原则

1. **自底向上**：先建基础类型和引擎，再建上层工具
2. **保持可运行**：每个阶段结束后测试应该能通过
3. **渐进迁移**：不一次性删除旧代码，通过并行新旧模块逐步替换

### 阶段划分

```
阶段 0: 准备工作（类型系统 + 工作流定义）
  ↓
阶段 1: 核心引擎（workflow-engine + validator + state）
  ↓
阶段 2: Plugin 基础设施（loader + action-registry + plugin）
  ↓
阶段 3: 工具层重写（artifact, dispatch, status → 全部返回 nextAction）
  ↓
阶段 4: Dev Workflow Plugin（workflow.json 重写 + hooks.ts + tools.ts）
  ↓
阶段 5: Setup 重构 + Hook 外置
  ↓
阶段 6: 清理 + 集成测试
```

---

### 阶段 0：准备工作

**目标**：建立新架构的类型基础，重写 workflow.json 格式

#### 任务 0.1：重写 types.ts

新增/修改的类型：

```typescript
// 节点类型
type NodeType = 'task' | 'sequence' | 'parallel' | 'gate';

// 节点定义（工作流 JSON 中的结构）
interface TaskNode {
  type: 'task';
  id: string;
  role: string;
  timeout?: number;
  onFailed?: FailureHandler;
  beforeDispatch?: NodeHook;
  afterComplete?: NodeHook;
}

interface SequenceNode {
  type: 'sequence';
  id: string;
  children: WorkflowNode[];
}

interface ParallelNode {
  type: 'parallel';
  id: string;
  failStrategy: 'fail-fast' | 'wait-all';
  children: WorkflowNode[];
  onFailed?: FailureHandler;
}

interface GateCondition {
  type: 'artifact_exists' | 'artifact_approved' | 'artifact_field';
  artifact: string;
  field?: string;
  operator?: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'in';
  value?: unknown;
}

interface GateNode {
  type: 'gate';
  id: string;
  conditions: GateCondition[];
  pass: WorkflowNode;
  fail: WorkflowNode | GotoTarget;
}

interface GotoTarget {
  goto: string;
  maxRetries?: number;
  onExhausted?: string; // 游离节点 id
}

interface FailureHandler {
  goto: string;
  maxRetries?: number;
  onExhausted?: string;
}

interface NodeHook {
  inject?: string[];
  actions?: string[];
}

type WorkflowNode = TaskNode | SequenceNode | ParallelNode | GateNode;

// 工作流定义（workflow.json 的根结构）
interface WorkflowDefinition {
  name: string;
  description: string;
  version?: string;
  coordinator: string; // coordinator 角色 id
  root: WorkflowNode;
  floatingNodes?: TaskNode[];
}

// 节点状态（运行时）
type NodeStatus = 'pending' | 'active' | 'completed' | 'failed' | 'cancelled' | 'skipped';

interface NodeState {
  id: string;
  status: NodeStatus;
  retryCount: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

// 工作流状态（state.json）
interface WorkflowState {
  projectName: string;
  projectDir: string;
  workflow: string;
  type: ContextType;
  iteration: number;
  activeNodeId: string | null;
  nodes: Record<string, NodeState>;
  createdAt: string;
  updatedAt: string;
}

// nextAction 统一返回
interface NextAction {
  type: 'dispatch' | 'write_artifact' | 'approve_artifact' | 'wait' | 'completed' | 'evaluate_gate';
  nodeId?: string;
  role?: string;
  instructions: string;
  rolePrompt?: string;
  inputArtifacts?: string[];
  gateResults?: GateEvaluationResult;
}

// Gate 评估结果
interface GateEvaluationResult {
  passed: boolean;
  conditions: Array<{
    condition: GateCondition;
    met: boolean;
    actualValue?: unknown;
  }>;
}

// Action 相关
interface ActionContext {
  nodeId: string;
  role: string;
  retryCount: number;
  projectName: string;
  pluginConfig: any;
  gateResults?: GateEvaluationResult;
  workflowState: WorkflowState;
  artifacts: { read: (id: string) => Promise<any>; list: () => Promise<string[]> };
  taskResult?: any;
}

interface ActionResult {
  inject?: string[];
  data?: any;
}

// Artifact（替代 Doc）
interface ArtifactDefinition {
  name: string;
  format?: 'md' | 'html' | 'json';
  review?: boolean;
  steps?: ArtifactStepDefinition[];
}

// Plugin 接口
interface WorkflowPlugin {
  name: string;
  definition: WorkflowDefinition;
  roles: Record<string, RoleDefinition>;
  artifactSchemas: Record<string, ArtifactSchema>;
  artifactDefinitions: Record<string, ArtifactDefinition>;
  actions?: Record<string, ActionHandler>;
  hooks?: HookCreator;
  config?: any;
}
```

移除的类型：

- `PhaseDefinition`, `PhaseState`, `PhaseStatus`（phase 概念移除）
- `ProjectScale`, `DocScale`, `ScaleDimension`（scale 移除）
- `DocDefinition` → `ArtifactDefinition`（重命名+简化）
- `DocSchema` → `ArtifactSchema`（重命名，移除 scale 相关字段）
- `ProjectState` → `WorkflowState`（重写）

**产出**：新 types.ts，编译通过（其他文件暂时 import 会报错，无所谓）
**测试**：类型编译检查

#### 任务 0.2：重写 dev workflow.json

将当前的线性阶段定义转换为节点树。

当前结构（5 阶段线性管道）：

```
clarify → design → develop → test → deliver
```

新结构（节点树）：

```
root (sequence "main")
├── task "clarify" (role: coordinator)
├── gate "prd-approved"
│   ├── pass → task "design" (role: architect)
│   └── fail → goto "clarify"
├── gate "design-approved"
│   ├── pass → task "develop" (role: developer)
│   └── fail → goto "design"
├── task "test" (role: tester)
├── gate "test-passed"
│   ├── pass → task "deliver" (role: coordinator)
│   └── fail → goto "develop"
```

**注意**：这只是初步结构。实际 dev workflow 更复杂（design 阶段有 architect 产出多个文档、test 有 test-report 检查等），需要仔细映射。完整的 workflow.json 在阶段 4 实现。

---

### 阶段 1：核心引擎

**目标**：实现工作流执行引擎的核心逻辑

#### 任务 1.1：workflow-validator.ts

静态验证，在加载时运行：

- **id 唯一性**：遍历整棵树 + 游离节点，检查 id 不重复
- **goto 合法性**：所有 goto 目标必须存在，且满足祖先链约束
- **环检测**：goto 不能形成无出口的循环（有 maxRetries 的不算）
- **failStrategy 检查**：parallel 节点必须有 failStrategy
- **游离节点引用检查**：所有 onExhausted 引用的 id 必须在 floatingNodes 中
- **角色引用检查**：task 节点的 role 必须在 roles registry 中
- **coordinator 检查**：definition.coordinator 必须存在于 roles 中

返回验证结果（errors 数组），调用方根据结果决定是否拒绝加载。

**测试**：

- 合法定义通过验证
- 各种非法情况被正确检出（重复 id、非法 goto、缺失 failStrategy 等）

#### 任务 1.2：workflow-engine.ts

节点状态机，核心方法：

```typescript
// 初始化：从 WorkflowDefinition 生成初始 NodeState 树
function initNodeStates(definition: WorkflowDefinition): Record<string, NodeState>;

// 计算下一步：给定当前状态和触发事件，计算 nextAction
function computeNextAction(
  definition: WorkflowDefinition,
  state: WorkflowState,
  event: WorkflowEvent,
  context: EngineContext,
): NextAction;

// Gate 评估
function evaluateGate(gate: GateNode, context: GateContext): GateEvaluationResult;

// Goto 处理：重置目标节点及后续节点状态
function executeGoto(state: WorkflowState, definition: WorkflowDefinition, targetId: string): WorkflowState;

// 节点完成处理：标记完成，推进到下一个节点
function completeNode(
  state: WorkflowState,
  definition: WorkflowDefinition,
  nodeId: string,
  result?: any,
): { state: WorkflowState; nextAction: NextAction };

// 节点失败处理：检查 onFailed，处理 goto 或冒泡
function failNode(
  state: WorkflowState,
  definition: WorkflowDefinition,
  nodeId: string,
  error: string,
): { state: WorkflowState; nextAction: NextAction };
```

**WorkflowEvent 类型**：

```typescript
type WorkflowEvent =
  | { type: 'node_completed'; nodeId: string; result?: any }
  | { type: 'node_failed'; nodeId: string; error: string }
  | { type: 'artifact_written'; artifactId: string }
  | { type: 'artifact_approved'; artifactId: string }
  | { type: 'dispatch_requested'; nodeId: string }
  | { type: 'query_status' }; // 纯查询，不改变状态
```

**关键逻辑**：

- sequence 节点：子节点按序推进，一个完成自动激活下一个
- parallel 节点：所有子节点同时激活，根据 failStrategy 处理完成/失败
- gate 节点：评估条件，走 pass 或 fail 路径
- goto：重置目标节点及其后续节点，递增 retryCount

**测试**（核心，需要覆盖全面）：

- sequence 顺序执行
- parallel fail-fast / wait-all
- gate pass / fail
- goto + retryCount 递增
- goto maxRetries 耗尽 → onExhausted
- onFailed 处理
- 复杂嵌套场景

#### 任务 1.3：state.ts 重写

从 phase-based 状态管理变为节点状态树管理：

```typescript
// 初始化工作流状态
async function initWorkflowState(
  projectName: string,
  projectDir: string,
  workflow: WorkflowPlugin,
  iteration: number,
  type: ContextType,
  contextDir?: string,
): Promise<WorkflowState>;

// 读/写状态
async function readState(projectName: string, iteration: number, contextDir?: string): Promise<WorkflowState>;
async function writeState(
  projectName: string,
  iteration: number,
  state: WorkflowState,
  contextDir?: string,
): Promise<void>;

// 更新节点状态（由 engine 调用后写入）
async function updateNodeState(
  projectName: string,
  iteration: number,
  nodeId: string,
  update: Partial<NodeState>,
  contextDir?: string,
): Promise<WorkflowState>;
```

移除：`updatePhaseStatus`, `setScale`, `ScaleNotSetError`

---

### 阶段 2：Plugin 基础设施

**目标**：建立 plugin 发现、加载和注册机制

#### 任务 2.1：action-registry.ts

```typescript
class ActionRegistry {
  register(name: string, handler: ActionHandler): void;
  execute(name: string, context: ActionContext): Promise<ActionResult>;
  has(name: string): boolean;
  list(): string[];
}
```

**测试**：注册、执行、缺失 action 报错

#### 任务 2.2：plugin.ts

Plugin 发现和加载协调器：

```typescript
// 扫描 config.json，发现已注册的 workflows
async function discoverPlugins(configPath: string): Promise<PluginEntry[]>;

// 加载单个 plugin
async function loadPlugin(pluginPath: string, config?: any): Promise<WorkflowPlugin>;

// Plugin 加载流程：
// 1. 读 workflow.json → 解析节点树
// 2. 静态验证（调用 validator）
// 3. 扫描 roles/ → 注册角色
// 4. 扫描 schemas/ → 注册 artifact schema
// 5. 如果存在 tools.ts → 动态 import，注册 actions
// 6. 如果存在 hooks.ts → 记录（不立即执行）
```

#### 任务 2.3：workflow-loader.ts 重写

从当前的两层解析（builtin + custom）改为基于 config.json 的 plugin 注册发现。

核心变更：

- 不再传递 `builtinDir` + `customDir` 两个参数
- 改为读 config.json 获取 workflow 路径
- `loadWorkflow()` → `loadPlugin()` 委托

**兼容层**：暂时保留旧接口作为 thin wrapper，逐步迁移调用方。

---

### 阶段 3：工具层重写

**目标**：所有 MCP 工具迁移到新架构，返回 nextAction

#### 任务 3.1：artifact 工具（替代 doc 工具）

**artifact_write**（替代 doc_write）：

1. 验证 artifact 存在于 plugin 定义中
2. Schema 验证（保留）
3. 写入 artifact 文件
4. 触发 engine 事件 `artifact_written`
5. Engine 评估相关 gate
6. 返回写入结果 + nextAction

**artifact_read**（替代 doc_read）：直接重命名

**artifact_list**（替代 doc_list）：直接重命名

**artifact_approve**（替代 doc_approve）：

1. 设置审批状态
2. 触发 engine 事件 `artifact_approved`
3. Engine 评估相关 gate
4. 返回审批结果 + nextAction

**artifact_schema**（替代 doc_schema）：重命名 + 移除 scale 相关过滤

#### 任务 3.2：role_dispatch 重写

核心变更：

- 不再基于 phase 做角色验证 → 基于节点状态（当前激活的 task 节点的 role）
- 不再自行拼装 prompt → 由 engine 组装完整 rolePrompt（role prompt + inject + gate results + task context）
- expectedOutputs 从 phase.outputs 改为从节点定义推导
- 触发 `beforeDispatch` 钩子：执行 actions，合并 inject
- 返回完整数据包 + nextAction

流程：

```
1. 验证 nodeId 对应的 task 节点处于 active 状态
2. 验证 role 匹配节点定义
3. 执行 beforeDispatch hooks（actions + inject）
4. 从 plugin 加载角色 prompt
5. 组装 rolePrompt = 角色prompt + inject + overrides + gate results
6. 创建 dispatch record
7. 查找 idle session
8. 返回数据包 + nextAction(type='wait', instructions='等待组员完成')
```

#### 任务 3.3：dispatch_report 重写

核心变更：

- 完成报告触发 `node_completed` 事件
- 执行 `afterComplete` 钩子
- Engine 计算下一步
- 返回 nextAction

流程：

```
1. 更新 dispatch record 状态
2. 如果 status='completed':
   a. 执行 afterComplete hooks
   b. 调用 engine.completeNode()
   c. Engine 推进到下一个节点
   d. 返回 nextAction
3. 如果 status='failed':
   a. 调用 engine.failNode()
   b. Engine 检查 onFailed
   c. 返回 nextAction（可能是重试或升级）
```

#### 任务 3.4：project_status 重写

从 phase 视图改为节点树视图：

```
Project: my-project (workflow: dev)
Iteration: 1

Workflow Tree:
  ● main (sequence) — active
    ✓ clarify (task, coordinator) — completed
    ✓ prd-approved (gate) — passed
    ● design (task, architect) — active [dispatch-003, running]
    ○ design-approved (gate) — pending
    ○ develop (task, developer) — pending
    ○ test (task, tester) — pending
    ○ test-passed (gate) — pending
    ○ deliver (task, coordinator) — pending

Artifacts: prd ✓, user-stories ✓, tech-design (writing...)
Reviews: prd ✓ approved
Active Dispatches: dispatch-003 (architect, running)

Next Action: 等待 architect 完成 design 任务
```

#### 任务 3.5：project_init 重写

变更：

- 接受 `workflow` 参数（默认 "dev"）
- 通过 plugin.ts 加载 workflow plugin
- 调用 plugin 的 hooks.ts 安装 hooks
- 返回初始 nextAction

#### 任务 3.6：iteration_start / patch_start 微调

适配新的状态初始化（节点树而非 phase 列表）。

---

### 阶段 4：Dev Workflow Plugin

**目标**：将 dev 特有逻辑完整迁移到 plugin

#### 任务 4.1：workflow.json 完整重写

将 5 阶段线性管道转换为完整的节点树。需要仔细映射所有现有功能：

**clarify 阶段**：

- coordinator 写 PRD、user-stories
- PRD 需要审批
- 审批通过后可以继续

**design 阶段**：

- architect 写 tech-design、task-breakdown
- tech-design 有顺序步骤（data-model → api → draft → final）
- task-breakdown 有顺序步骤
- 可能还有 fsd、prototype（按需）

**develop 阶段**：

- developer 根据 task-breakdown 实现代码
- 多个 developer 可以并行

**test 阶段**：

- tester 写 test-plan、执行测试、写 test-report
- test-report 结果检查（pass/fail）

**deliver 阶段**：

- coordinator 写 retrospective
- 最终交付确认

节点树结构（完整版）：

```json
{
  "name": "dev",
  "description": "Software development workflow",
  "coordinator": "coordinator",
  "root": {
    "type": "sequence",
    "id": "main",
    "children": [
      {
        "type": "task",
        "id": "clarify",
        "role": "coordinator",
        "afterComplete": {
          "inject": ["确认 PRD 和 user-stories 已完成。检查是否需要审批。"]
        }
      },
      {
        "type": "gate",
        "id": "prd-gate",
        "conditions": [
          { "type": "artifact_exists", "artifact": "prd" },
          { "type": "artifact_approved", "artifact": "prd" }
        ],
        "pass": { "type": "task", "id": "design", "role": "architect" },
        "fail": { "goto": "clarify", "maxRetries": 5, "onExhausted": "escalate" }
      },
      {
        "type": "gate",
        "id": "design-gate",
        "conditions": [
          { "type": "artifact_exists", "artifact": "tech-design" },
          { "type": "artifact_exists", "artifact": "task-breakdown" }
        ],
        "pass": { "type": "task", "id": "develop", "role": "developer" },
        "fail": { "goto": "design", "maxRetries": 3, "onExhausted": "escalate" }
      },
      {
        "type": "task",
        "id": "test",
        "role": "tester"
      },
      {
        "type": "gate",
        "id": "test-gate",
        "conditions": [
          { "type": "artifact_field", "artifact": "test-report", "field": "result", "operator": "eq", "value": "pass" }
        ],
        "pass": { "type": "task", "id": "deliver", "role": "coordinator" },
        "fail": { "goto": "develop", "maxRetries": 3, "onExhausted": "escalate" }
      }
    ]
  },
  "floatingNodes": [{ "type": "task", "id": "escalate", "role": "coordinator" }]
}
```

**注意**：上面的结构是简化版。实际实现时需要考虑 design 阶段内部的多文档顺序、develop 阶段的并行性等。可能需要更深层的嵌套。

#### 任务 4.2：coordinator.md（重命名 pm.md）

更新 prompt 内容，适配新的工具名称和流程：

- `doc_write` → `artifact_write`
- `doc_read` → `artifact_read`
- `phase_update` → 由 engine 自动推进（可能仍需保留作为手动覆盖）
- `project_set_scale` → 移除
- 添加对 nextAction 的理解说明

#### 任务 4.3：hooks.ts

从 src/hooks/ 迁移 hook 生成逻辑：

```typescript
export function createHooks(agentType: AgentType, context: HookContext) {
  const { defineHooks, dataDir, projectName } = context;
  // 迁移 claude-code.ts / opencode.ts / openclaw.ts 中的内容
  // 边界守卫 + 提醒
}
```

#### 任务 4.4：tools.ts

注册 dev 特定的 MCP 工具和 action：

```typescript
export function registerActions(registry: ActionRegistry, context: PluginContext) {
  // 如果有 dev 特定的 action（如 collect-review-comments）
}

export function registerTools(server: McpServer, context: PluginContext) {
  // phase_update（如果保留作为手动覆盖工具）
}
```

#### 任务 4.5：Schema 文件清理

- 移除所有 `required: { small: ..., medium: ..., large: ... }` → 改为 `required: boolean`
- 移除 `scale` 相关字段
- 保持实际验证逻辑不变

---

### 阶段 5：Setup 重构 + Hook 外置

#### 任务 5.1：templates.ts 重写

通用 coordinator prompt，不含 dev 特定操作手册：

```
你是 Harmonia 管理的项目协调者。

你的职责：
1. 与用户沟通需求
2. 调用 Harmonia 工具驱动工作流
3. 派发任务给团队成员
4. 跟踪进度，确保质量

每次调用工具后，检查返回的 nextAction 字段，按照 instructions 执行下一步。

工具列表：
- project_init：初始化项目
- iteration_start：开始新迭代
- project_status：查看项目状态
- role_dispatch：派发任务给团队成员
- dispatch_report：报告派发进度
- artifact_write / artifact_read / artifact_list：管理 artifact
- artifact_approve：审批 artifact
- artifact_schema：查看 artifact 结构要求
- patch_start：开始补丁
- issue_create / issue_list / issue_update：管理问题

工作流特定的操作指引由工作流 plugin 提供，在 project_init 后注入。
```

#### 任务 5.2：cli/setup.ts 更新

- 拷贝内置 dev workflow 到 `<data_dir>/workflows/dev/`
- 写入 config.json 注册 dev workflow
- 注入通用 coordinator prompt
- 不再在 setup 时安装 hooks（延迟到 project_init）

#### 任务 5.3：Hook 安装流程

在 `project_init` 中：

1. 加载 plugin 的 hooks.ts
2. 调用 `createHooks(agentType, context)`
3. 收集返回的 HookSet
4. 调用 agent-kit 安装

---

### 阶段 6：清理 + 集成测试

#### 任务 6.1：删除旧代码

- 删除 `src/tools/set-scale.ts`
- 删除 `src/tools/update-phase.ts`（已迁移到 plugin）
- 删除 `src/tools/override-tools.ts`
- 删除 `src/hooks/claude-code.ts`, `opencode.ts`, `openclaw.ts`, `content.ts`（已迁移到 plugin）
- 清理 types.ts 中的旧类型
- 清理 index.ts 中的旧工具注册

#### 任务 6.2：测试重构

当前 314 个测试需要大幅调整：

| 测试文件                | 处理方式                                                |
| ----------------------- | ------------------------------------------------------- |
| workflow.test.ts        | 重写为 plugin 加载测试                                  |
| state.test.ts           | 重写为节点状态测试                                      |
| dispatch.test.ts        | 更新参数和断言                                          |
| guards.test.ts          | 拆分：通用 guard → engine 测试，dev guard → plugin 测试 |
| schema.test.ts          | 移除 scale 相关测试                                     |
| schema-guidance.test.ts | 移除 scale 相关测试                                     |
| sequential.test.ts      | 保留，更新术语                                          |
| steps.test.ts           | 保留，更新术语                                          |
| hooks.test.ts           | 拆分：安装机制 → core 测试，hook 内容 → plugin 测试     |
| overrides.test.ts       | 简化（移除全局层、MCP 工具测试）                        |
| reviews.test.ts         | 保留，更新术语                                          |
| docs.test.ts            | 重命名为 artifact.test.ts                               |
| doc-schema.test.ts      | 重命名                                                  |
| issues.test.ts          | 保留不变                                                |
| patch-start.test.ts     | 更新                                                    |
| cli.test.ts             | 更新                                                    |
| setup.test.ts           | 更新                                                    |
| utils.test.ts           | 保留                                                    |

新增测试文件：

- **workflow-engine.test.ts** — 核心！覆盖所有节点类型、gate、goto、失败处理
- **workflow-validator.test.ts** — 静态验证
- **action-registry.test.ts** — action 注册和执行
- **plugin.test.ts** — plugin 加载和发现
- **next-action.test.ts** — nextAction 集成测试

#### 任务 6.3：集成测试

端到端场景测试：

1. Setup → project_init → clarify → PRD审批 → design → develop → test → deliver
2. Gate fail → goto 跳回 → 重试成功
3. Gate fail → maxRetries 耗尽 → onExhausted 触发
4. 并行任务 → fail-fast / wait-all
5. Patch 流程

---

## 三、迁移策略

### 3.1 分支策略

- 在 `develop` 分支上开发
- 每个阶段完成后推送
- 全部完成后合并到 `main`

### 3.2 破坏性变更处理

这是一次大型重构，几乎所有 API 都会变化。不做渐进兼容，直接替换：

- **工具名称变更**：doc_write → artifact_write 等
- **状态格式变更**：phase-based → node-based
- **概念移除**：scale, phase_update, set_scale

**已有项目数据不做迁移**。这是 pre-1.0 软件，用户量极少。如果需要，后续可以写迁移脚本。

### 3.3 术语映射

| 旧术语                | 新术语                             |
| --------------------- | ---------------------------------- |
| doc                   | artifact                           |
| doc_write             | artifact_write                     |
| doc_read              | artifact_read                      |
| doc_list              | artifact_list                      |
| doc_approve           | artifact_approve                   |
| doc_schema            | artifact_schema                    |
| phase                 | node                               |
| PM                    | coordinator                        |
| scale                 | (移除)                             |
| phase_update          | (移到 plugin 或由 engine 自动处理) |
| project_set_scale     | (移除)                             |
| guard_set / guard_get | (移除)                             |

### 3.4 风险点

1. **Dev workflow 功能遗漏**：最大风险。需要逐功能对照检查。设计文档第 21 节有完整清单。
2. **Engine 复杂度**：goto + gate + parallel 的组合可能产生边界情况。需要充分的单元测试。
3. **Plugin 动态加载**：hooks.ts 和 tools.ts 的动态 import 在不同运行环境可能有问题。
4. **Coordinator prompt 质量**：通用 prompt + plugin 特定 prompt 的组合效果需要实际测试。

---

## 四、工作量估算

| 阶段     | 任务数 | 预估工作量                      |
| -------- | ------ | ------------------------------- |
| 阶段 0   | 2      | 中                              |
| 阶段 1   | 3      | 大（engine 是核心）             |
| 阶段 2   | 3      | 中                              |
| 阶段 3   | 6      | 大（工具层代码量最多）          |
| 阶段 4   | 5      | 大（dev workflow 映射需要仔细） |
| 阶段 5   | 3      | 小                              |
| 阶段 6   | 3      | 大（测试重构）                  |
| **合计** | **25** |                                 |

---

## 五、验收标准

1. ✅ 所有旧 dev workflow 功能在新架构下可用
2. ✅ 测试全部通过（数量可能变化但覆盖率不降低）
3. ✅ `harmonia setup` + `project_init` + 完整 dev 流程可以端到端运行
4. ✅ 自定义 workflow plugin 可以被加载和使用（至少有一个非 dev 的示例）
5. ✅ Scale 相关代码完全移除
6. ✅ Doc → Artifact 术语全部替换
7. ✅ PM → Coordinator 术语替换
8. ✅ Override MCP 工具移除，文件配置保留
9. ✅ nextAction 在所有关键工具的返回值中出现
