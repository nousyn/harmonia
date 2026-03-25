# operations.ts 拆分计划

> 创建时间: 2026-03-25
> 状态: 待执行

## 背景

`src/core/operations.ts`（1049 行）是 Phase 3 从 `src/tools/` 提取的 transport-agnostic 业务逻辑层。该文件集中了 6 个领域的逻辑，体量偏大，需要按领域拆分以改善可维护性。

消费者：`src/api/routes.ts`、`tests/patch-start.test.ts`。

## 现状分析

| 行范围   | 内容                                                                                       | 行数 | 领域              |
| -------- | ------------------------------------------------------------------------------------------ | ---- | ----------------- |
| 1-64     | imports + `detectHostAgent` + `kit` 实例                                                   | 64   | 共享              |
| 65-188   | 返回类型 + 错误类型（6 个 interface + 3 个 Error class）                                   | 124  | 共享              |
| 189-296  | `initProject`                                                                              | 108  | 项目生命周期      |
| 297-451  | `beginIteration` + `beginPatch`                                                            | 155  | 项目生命周期      |
| 452-539  | `readArtifactOrchestrated` + `listArtifactsOrchestrated`                                   | 88   | Artifact          |
| 540-687  | `approveArtifactOrchestrated` + `listPendingReviewsOrchestrated` + `getArtifactSchemaInfo` | 148  | Artifact + Review |
| 688-900  | 7 个格式化纯函数                                                                           | 213  | 展示层            |
| 901-1049 | `getProjectStatus` + `getProjectList`                                                      | 149  | 状态查询          |

## 拆分方案

将 `src/core/operations.ts` 拆为目录 `src/core/operations/`，包含 5 个文件：

```
src/core/operations/
├── index.ts              # 统一 re-export
├── types.ts              # 返回类型 + 错误类型
├── project-lifecycle.ts  # 项目/迭代/补丁创建
├── artifact-ops.ts       # 产出读写审批 + schema 查询
├── status.ts             # 状态查询 + 展示格式化
```

### 各文件职责

#### `types.ts`（~124 行）

从原文件提取全部返回类型和错误类型：

- `InitProjectResult`
- `BeginIterationResult`
- `BeginPatchResult`
- `ApproveArtifactResult`
- `PendingReviewItem`
- `ArtifactSchemaResult`
- `ProjectStatusData`
- `ProjectListItem`
- `WorkflowChoice`
- `WorkflowSelectionRequired`（Error class）
- `ValidationError`（Error class）
- `StepPrerequisiteError`（Error class）

#### `project-lifecycle.ts`（~263 行）

项目生命周期管理：

- `initProject()` — 注册项目 + 安装 workflow hooks
- `beginIteration()` — 开始新迭代
- `beginPatch()` — 开始新补丁

内部依赖：

- `detectHostAgent()` 和 `kit` 实例移入此文件（唯一使用者是 `initProject`）

#### `artifact-ops.ts`（~236 行）

产出相关操作：

- `readArtifactOrchestrated()` — 读取 artifact
- `listArtifactsOrchestrated()` — 列出 artifacts
- `approveArtifactOrchestrated()` — 审批 artifact
- `listPendingReviewsOrchestrated()` — 列出待审列表
- `getArtifactSchemaInfo()` — 查询 artifact schema

#### `status.ts`（~362 行）

状态查询 + 展示格式化：

- `getProjectStatus()` — 详细状态查询
- `getProjectList()` — 项目列表
- `statusIcon()` — 状态图标
- `formatNodeTree()` — 节点树格式化
- `formatDispatch()` — 调度记录格式化
- `formatSession()` — 会话记录格式化
- `formatStepProgress()` — 步骤进度格式化
- `formatArtifactsSummary()` — 产出摘要格式化
- `formatInProgressArtifacts()` — 进行中产出格式化
- `getNodeDispatchInfo()`（内部函数）

> 格式化函数与 `getProjectStatus` 合并而非单独成文件的原因：
> `getProjectStatus` 是格式化函数的主要消费者（调用 `formatNodeTree`），
> 两者关系紧密。若未来有 WebSocket 或 CLI 等新消费者需要格式化函数，
> 再从 status.ts 中提取 formatters.ts 也很方便。

#### `index.ts`（~20 行）

纯 re-export 桶文件，统一导出所有公开 API：

```ts
export * from './types.js';
export * from './project-lifecycle.js';
export * from './artifact-ops.js';
export * from './status.js';
```

## 对外影响

需要修改 import 路径的文件：

1. `src/api/routes.ts`：

```diff
- import { ... } from '../core/operations.js';
+ import { ... } from '../core/operations/index.js';
```

2. `tests/patch-start.test.ts`：

```diff
- import { beginPatch } from '../src/core/operations.js';
+ import { beginPatch } from '../src/core/operations/index.js';
```

## 执行步骤

1. 创建 `src/core/operations/` 目录
2. 创建 `types.ts` — 提取类型和错误类
3. 创建 `project-lifecycle.ts` — 迁移 `initProject` / `beginIteration` / `beginPatch` + 内部依赖
4. 创建 `artifact-ops.ts` — 迁移产出相关函数
5. 创建 `status.ts` — 迁移状态查询 + 格式化函数
6. 创建 `index.ts` — 统一 re-export
7. 修改 `routes.ts` 和 `tests/patch-start.test.ts` 的 import 路径
8. 删除原 `src/core/operations.ts`
9. `tsc` 编译零错误
10. `vitest run` 全量测试通过

## 不采用的替代方案

- **按原 MCP 工具 1:1 拆分**（8+ 小文件）→ 过度碎片化，每个不到 100 行
- **只提取 formatters**（operations.ts 仍 ~836 行）→ 改善有限
- **格式化函数单独成文件**（formatters.ts）→ 当前只有 `getProjectStatus` 消费，拆分收益不足，待有新消费者时再提取
