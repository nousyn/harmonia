# 037 — 全面代码审计报告

> 对照重构设计文档 (027/028)，对 Harmonia 当前源码进行完整审计，评估合规性、遗留问题和优化点。

---

## 一、审计范围

本次审计覆盖以下所有模块：

| 类别                | 文件                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 核心模块            | types.ts, workflow-engine.ts, workflow-validator.ts, plugin.ts, workflow.ts, state.ts, action-registry.ts, overrides.ts, docs.ts, schema.ts, registry.ts                    |
| 工具模块            | artifact-tools.ts, approve-artifact.ts, dispatch-role.ts, report-dispatch.ts, project-init.ts, get-project-status.ts, engine-helpers.ts, iteration-start.ts, patch-start.ts |
| Hooks               | install.ts, content.ts, claude-code.ts, opencode.ts, openclaw.ts                                                                                                            |
| Setup               | templates.ts, inject.ts                                                                                                                                                     |
| 入口                | index.ts                                                                                                                                                                    |
| Dev Workflow Plugin | workflow.json, hooks.js, coordinator.md, roles/\*, schemas/\*                                                                                                               |
| 测试                | 22 个测试文件, 406 个测试用例                                                                                                                                               |

参照文档：

- `.dev-logs/027-core-architecture-design.md` — 核心架构设计 (869 行)
- `.dev-logs/028-implementation-plan.md` — 实施计划 (946 行)

---

## 二、整体评估

**完成度: ~85%**

全部 406 个测试通过。核心引擎和类型系统扎实可靠。主要差距集中在术语迁移和 hook 外部化两方面。

---

## 三、已完成项（合规部分）

### 3.1 类型系统 — `src/core/types.ts` (617 行) ✅

完全重写，包含所有新类型定义：

- `WorkflowNode` — 4 种节点类型 (task, sequence, parallel, gate)
- `GateCondition` — gate 条件评估
- `NextAction` — 统一的下一步行动指令
- `ActionContext` — 工具执行上下文
- `WorkflowPlugin` — 插件接口
- `NodeState`, `NodeOutcome`, `ArtifactState` 等

### 3.2 工作流引擎 — `src/core/workflow-engine.ts` (1165 行) ✅

完整的状态机实现：

- 节点激活与完成
- Gate 条件评估 (`all_artifacts_approved`, `artifact_field`, `custom`)
- Goto 跳转处理
- Parallel 节点 `fail-fast` / `wait-all` 策略
- 失败冒泡 (failure bubbling)
- 引擎事件系统 (`artifact_written`, `artifact_approved`, `node_completed`, `node_failed`)

### 3.3 工作流验证器 — `src/core/workflow-validator.ts` ✅

7 项静态验证检查：

- ID 唯一性
- Goto 合法性
- 循环检测
- failStrategy 有效性
- 浮动引用检测
- Role 引用检测
- Coordinator 存在性

### 3.4 插件系统 — `src/core/plugin.ts` ✅

6 步加载管线：workflow.json → roles/ → validate → schemas/ → tools.ts → hooks.ts

### 3.5 状态管理 — `src/core/state.ts` ✅

从 phase-based 完全重写为 node-based `WorkflowState`。

### 3.6 MCP 工具 ✅

所有工具已返回 `nextAction`：

- `artifact_write` / `artifact_read` / `artifact_list`
- `artifact_approve` / `review_list`
- `role_dispatch` / `dispatch_report`
- `project_status` / `project_init`
- `iteration_start` / `patch_start`

### 3.7 Hook 集成 ✅

- `beforeDispatch` hooks — 已集成到 `dispatch-role.ts`
- `afterComplete` hooks — 已集成到 `report-dispatch.ts`

### 3.8 其他已完成项 ✅

- Scale 系统完全移除
- Override MCP 工具已移除
- `coordinator.md` 已从 `pm.md` 重命名，无遗留概念
- 入口 `index.ts` — 11 个工具注册调用，无旧工具

---

## 四、未完成项（偏差/缺失）

### P0 — Hook 外部化未完成 [027 §17]

**问题**: `src/hooks/` 下的文件仍硬编码在源码中，未迁移到 workflow 插件：

- `claude-code.ts` (228 行) — Claude Code hook 生成
- `opencode.ts` (236 行) — OpenCode hook 生成
- `openclaw.ts` (229 行) — OpenClaw hook 生成
- `content.ts` (127 行) — 共享常量
- `install.ts` (71 行) — 安装编排器，硬导入上述文件

`workflows/dev/hooks.js` 仅 25 行，只是回调到 `build/hooks/install.js` 的薄桥接层。

**影响**: 阻塞多 workflow 支持。自定义 workflow 无法定义自己的 hooks，必须修改核心代码。

### P1 — `doc → artifact` 术语迁移不完整

**问题**: 外部/用户面的 MCP 工具名已正确更新为 `artifact_*`，但内部代码仍大量使用 `doc` 术语：

| 位置                          | 具体问题                                                                |
| ----------------------------- | ----------------------------------------------------------------------- |
| `src/core/docs.ts`            | 文件未重命名为 `artifacts.ts`，函数仍为 `writeDoc`/`readDoc`/`listDocs` |
| `src/core/registry.ts`        | 仍创建 `docs/` 子目录，而非 `artifacts/`                                |
| `src/core/overrides.ts`       | 函数 `resolveDocReview`，参数 `docId`/`docDef`                          |
| `src/core/schema.ts`          | `formatSchemaGuidance` 参数 `docId`/`docDef`                            |
| `src/tools/engine-helpers.ts` | 内部变量 `docList`/`existingDocs`/`docId`                               |
| `tests/docs.test.ts`          | 测试文件名未重命名                                                      |
| `tests/doc-schema.test.ts`    | 测试文件名未重命名                                                      |

**影响**: 不影响功能，但造成概念混乱，增加新贡献者的理解成本。

### P1 — `dispatch_report` 取消状态不更新节点

**问题**: 当一个 dispatch 被取消时，dispatch/session 记录会更新，但对应的工作流节点状态保持 `active` 不变，永远不会被标记为完成或失败。

**影响**: 被取消的节点会一直占用工作流状态，可能导致后续 gate 评估异常。

### P2 — `getInputArtifacts` 未实现

**位置**: `src/tools/engine-helpers.ts:110-111`

**问题**: 函数体为 TODO，直接返回空数组。引擎无法自动确定被 dispatch 角色需要的输入 artifacts。

**影响**: 被 dispatch 的角色不会收到自动注入的输入 artifact 信息，需要手动查询。

### P2 — `buildArtifactRequirements` 未按 role/node 过滤

**位置**: `src/tools/engine-helpers.ts`

**问题**: 返回所有 artifact schemas，而不是仅返回与当前任务/角色相关的 schemas。

**影响**: 被 dispatch 的角色会收到不相关的 artifact 要求，增加 prompt 噪音。

### P3 — 低优先级问题汇总

| #   | 问题                              | 位置                                          | 说明                                                                                  |
| --- | --------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Override 注释错误                 | `src/core/overrides.ts`                       | 注释说"三层合并"，实际行为和设计都是两层                                              |
| 2   | 缺少 `next-action.test.ts`        | `tests/`                                      | 设计文档 §6.3 要求 5 个端到端集成测试场景，均未实现                                   |
| 3   | Scale 兼容代码残留                | `src/core/schema.ts` `isRequired()`           | 仍包含对旧 `Record<string, boolean>` 格式的兼容判断                                   |
| 4   | Cycle 检测死代码                  | `src/core/workflow-validator.ts`              | 构建了 `adj` 邻接表但从未使用                                                         |
| 5   | `fileExists` 重复                 | `src/core/plugin.ts` & `src/core/workflow.ts` | 两处定义了相同的工具函数                                                              |
| 6   | Gate 类型判别脆弱                 | `src/core/workflow-engine.ts`                 | 使用 `'type' in node.fail` 判别，应改为 `'goto' in node.fail`                         |
| 7   | Action/hook 加载失败静默          | `src/core/plugin.ts`                          | 仅 `console.warn`，不抛出异常                                                         |
| 8   | `workflow.ts` 废弃包装器          | `src/core/workflow.ts`                        | 所有函数标记 `@deprecated`，但未在任何地方标注移除计划                                |
| 9   | Escalate 浮动节点缺少注入         | `workflows/dev/workflow.json`                 | `escalate` 节点没有 `beforeDispatch.inject` 来告知 coordinator 是哪个 gate 触发了升级 |
| 10  | Dev workflow 未使用 parallel 节点 | `workflows/dev/workflow.json`                 | 工作流定义为纯线性流程，未利用引擎的并行能力                                          |

---

## 五、文件清单与状态

### 核心模块 (`src/core/`)

| 文件                    | 行数 | 状态                                    |
| ----------------------- | ---- | --------------------------------------- |
| `types.ts`              | 617  | ✅ 完全合规                             |
| `workflow-engine.ts`    | 1165 | ✅ 完全合规                             |
| `workflow-validator.ts` | —    | ✅ 合规 (P3: 死代码)                    |
| `plugin.ts`             | —    | ✅ 合规 (P3: fileExists 重复, 加载静默) |
| `state.ts`              | —    | ✅ 完全合规                             |
| `action-registry.ts`    | —    | ✅ 完全合规                             |
| `docs.ts`               | —    | ⚠️ P1: 未重命名为 artifacts.ts          |
| `schema.ts`             | —    | ⚠️ P3: scale 兼容残留                   |
| `registry.ts`           | —    | ⚠️ P1: 仍创建 docs/ 目录                |
| `overrides.ts`          | —    | ⚠️ P1: doc 术语 / P3: 注释错误          |
| `workflow.ts`           | —    | ⚠️ P3: 废弃包装器未清理                 |

### 工具模块 (`src/tools/`)

| 文件                    | 状态                                          |
| ----------------------- | --------------------------------------------- |
| `artifact-tools.ts`     | ✅ 完全合规                                   |
| `approve-artifact.ts`   | ✅ 完全合规                                   |
| `dispatch-role.ts`      | ✅ 合规 (⚠️ P2: 未过滤 artifact requirements) |
| `report-dispatch.ts`    | ✅ 合规 (⚠️ P1: cancelled 不更新节点)         |
| `project-init.ts`       | ✅ 完全合规                                   |
| `get-project-status.ts` | ✅ 完全合规                                   |
| `engine-helpers.ts`     | ⚠️ P1: doc 术语 / P2: getInputArtifacts TODO  |
| `iteration-start.ts`    | ✅ 完全合规                                   |
| `patch-start.ts`        | ✅ 完全合规                                   |

### Hooks (`src/hooks/`) — ⚠️ P0: 应迁移至插件

| 文件             | 行数 | 说明             |
| ---------------- | ---- | ---------------- |
| `install.ts`     | 71   | 应改为通用安装器 |
| `content.ts`     | 127  | 共享常量，应外置 |
| `claude-code.ts` | 228  | 硬编码，应外置   |
| `opencode.ts`    | 236  | 硬编码，应外置   |
| `openclaw.ts`    | 229  | 硬编码，应外置   |

### 测试 (`tests/`)

- 22 个测试文件，406 个测试用例，**全部通过**
- ⚠️ 缺少 `next-action.test.ts` (设计要求)
- ⚠️ `docs.test.ts` / `doc-schema.test.ts` 文件名未更新

---

## 六、测试结果

```
Test Suites: 22 passed, 22 total
Tests:       406 passed, 406 total
Snapshots:   0 total
```

全部通过，无失败、无跳过。

---

## 七、结论与建议

### 优先修复路径

1. **P0**: Hook 外部化 — 这是唯一阻塞多 workflow 支持的架构级问题
2. **P1**: `doc → artifact` 术语迁移 + `dispatch_report` 取消状态处理
3. **P2**: `getInputArtifacts` 实现 + `buildArtifactRequirements` 过滤
4. **P3**: 代码清理和补充测试

### 风险评估

- **功能风险**: 低。所有现有功能正常工作，406 测试全部通过
- **架构风险**: 中。P0 的 hook 外部化未完成限制了插件化扩展能力
- **维护风险**: 低-中。术语不一致增加理解成本，但不影响运行

---

_审计日期: 2026-03-19_
_审计方式: 只读代码分析，未进行任何代码修改_
