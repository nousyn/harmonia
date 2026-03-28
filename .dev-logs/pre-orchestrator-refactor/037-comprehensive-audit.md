# 037 — 重构完整性综合审计报告

> 对照原始重构设计 (027) 和实施计划 (028)，对当前源码进行全面审计，评估重构完成度、偏差项、缺失功能和优化点。

---

## 概述

Harmonia 从**硬编码的 5 阶段开发流水线**（clarify→design→develop→test→deliver）重构为**通用多 Agent 协作框架**，核心变化是引入树状节点执行引擎（4 种节点类型：task / sequence / parallel / gate）和 workflow 插件系统。

**总体完成度**: ~85%
**测试状态**: 22 个测试文件，406 个测试全部通过

---

## 一、已完成项（符合设计）

### 1.1 类型系统 — `src/core/types.ts` (617 行) ✅

完全重写，包含所有新类型定义：

- `WorkflowNode` — 4 种节点类型的联合类型
- `GateCondition` — gate 评估条件
- `NextAction` — 引擎返回给 agent 的下一步指令
- `ActionContext` — action 执行上下文
- `WorkflowPlugin` — 插件接口
- `FailStrategy` — parallel 节点失败策略（fail-fast / wait-all）

### 1.2 工作流引擎 — `src/core/workflow-engine.ts` (1165 行) ✅

完整的状态机实现：

- 节点激活与完成
- Gate 条件评估
- Goto 跳转处理
- Parallel fail-fast / wait-all 策略
- 失败冒泡机制
- 事件系统（artifact_written, artifact_approved, node_completed, node_failed）

### 1.3 工作流验证器 — `src/core/workflow-validator.ts` ✅

7 项静态验证检查：

- ID 唯一性
- Goto 合法性
- 循环检测
- failStrategy 验证
- 浮动引用检测
- 角色引用验证
- Coordinator 存在性

### 1.4 插件系统 — `src/core/plugin.ts` ✅

6 步加载流水线：

1. `workflow.json` — 工作流定义
2. `roles/` — 角色 prompt 文件
3. validate — 静态验证
4. `schemas/` — artifact schema 文件
5. `tools.ts` — 自定义 actions（可选）
6. `hooks.ts` — hook 定义（可选）

### 1.5 状态管理 — `src/core/state.ts` ✅

从 phase-based 完全重写为 node-based `WorkflowState`，与引擎配合正确。

### 1.6 MCP 工具 ✅

所有工具均返回 `nextAction`，符合设计要求：

| 工具名             | 文件                              | 状态 |
| ------------------ | --------------------------------- | ---- |
| `artifact_write`   | `src/tools/artifact-tools.ts`     | ✅   |
| `artifact_read`    | `src/tools/artifact-tools.ts`     | ✅   |
| `artifact_list`    | `src/tools/artifact-tools.ts`     | ✅   |
| `artifact_approve` | `src/tools/approve-artifact.ts`   | ✅   |
| `review_list`      | `src/tools/approve-artifact.ts`   | ✅   |
| `role_dispatch`    | `src/tools/dispatch-role.ts`      | ✅   |
| `dispatch_report`  | `src/tools/report-dispatch.ts`    | ✅   |
| `project_init`     | `src/tools/project-init.ts`       | ✅   |
| `project_status`   | `src/tools/get-project-status.ts` | ✅   |
| `iteration_start`  | `src/tools/iteration-start.ts`    | ✅   |
| `patch_start`      | `src/tools/patch-start.ts`        | ✅   |

### 1.7 Hook 集成 ✅

- `beforeDispatch` — 在 `dispatch-role.ts` 中正确触发
- `afterComplete` — 在 `report-dispatch.ts` 中正确触发

### 1.8 清理工作 ✅

- Scale 系统：完全移除
- Override MCP 工具：已移除
- `coordinator.md`：从 `pm.md` 正确重命名，无遗留概念

---

## 二、未完成项（偏差与缺失）

### P0 — Hook 外部化未完成 [027 §17]

**设计要求**: "Hook 完全外置: Plugin 提供 hook 内容, Core 只负责传递和安装。"

**实际情况**: `src/hooks/` 下的文件仍然硬编码在源码中：

- `claude-code.ts` (228 行) — Claude Code hook 生成
- `opencode.ts` (236 行) — OpenCode hook 生成
- `openclaw.ts` (229 行) — OpenClaw hook 生成
- `content.ts` (127 行) — 共享常量
- `install.ts` (71 行) — 安装编排器，硬编码 import 上述文件

`workflows/dev/hooks.js` 只是一个 25 行的薄桥接层（`require('../../build/hooks/install.js')`），并未真正外置 hook 内容。

**影响**: 阻塞多 workflow 支持。自定义 workflow 无法定义自己的 hooks，必须修改核心代码。

---

### P1 — `doc → artifact` 术语迁移不完整

外部用户可见的 MCP 工具名已正确更新为 `artifact_*`，但内部代码仍有大量 `doc` 残留：

| 位置                          | 问题                                                                        |
| ----------------------------- | --------------------------------------------------------------------------- |
| `src/core/docs.ts`            | 文件未重命名为 `artifacts.ts`，函数仍为 `writeDoc` / `readDoc` / `listDocs` |
| `src/core/registry.ts`        | 创建 `docs/` 子目录，而非 `artifacts/`                                      |
| `src/core/overrides.ts`       | 函数 `resolveDocReview`，参数 `docId` / `docDef`                            |
| `src/core/schema.ts`          | `formatSchemaGuidance` 参数 `docId` / `docDef`                              |
| `src/tools/engine-helpers.ts` | 内部变量 `docList` / `existingDocs` / `docId`                               |
| `tests/docs.test.ts`          | 测试文件名未更新                                                            |
| `tests/doc-schema.test.ts`    | 测试文件名未更新                                                            |

**影响**: 不影响功能，但增加新开发者理解成本，与设计文档不一致。

---

### P1 — `dispatch_report` 取消状态未更新节点

当 dispatch 被取消时，dispatch/session 记录正确更新，但对应的 workflow 节点状态保持 `active` 不变，永远不会结束。

**影响**: 被取消的 dispatch 对应的节点会卡在 `active` 状态，阻塞后续流程。

---

### P2 — `getInputArtifacts` 未实现

`src/tools/engine-helpers.ts:110-111` 中 `getInputArtifacts` 返回空数组（TODO 状态）。

**影响**: 引擎无法自动确定分派角色的输入 artifacts，分派时不会携带已有 artifact 信息。

---

### P2 — `buildArtifactRequirements` 未按 role/node 过滤

当前返回所有 artifact schemas，而非仅返回与当前任务/角色相关的 schemas。

**影响**: 分派角色时收到的 artifact 要求可能包含不相关的 schemas，增加 agent 困惑。

---

### P3 — 低优先级问题

| 编号 | 问题                            | 详情                                                          |
| ---- | ------------------------------- | ------------------------------------------------------------- |
| P3-1 | `overrides.ts` 注释错误         | 注释说"三层合并"，但设计要求且实际行为是两层合并              |
| P3-2 | 缺少 `next-action.test.ts`      | 设计 §6.3 要求 5 个端到端场景测试，未实现                     |
| P3-3 | `schema.ts` 残留 scale 兼容代码 | `isRequired()` 仍有旧 `Record<string, boolean>` 格式兼容逻辑  |
| P3-4 | `fileExists` 工具函数重复       | `plugin.ts` 和 `workflow.ts` 中各有一份                       |
| P3-5 | Validator 循环检测死代码        | 构建了 `adj` 邻接表但从未使用                                 |
| P3-6 | Gate 类型判别脆弱               | 使用 `'type' in node.fail` 判别，应使用 `'goto' in node.fail` |
| P3-7 | Action/hook 加载失败静默        | 仅 `console.warn`，不抛异常                                   |

---

## 三、其他发现

### 3.1 Dev Workflow 未使用 Parallel 节点

`workflows/dev/workflow.json` 定义的节点树是纯线性的 sequence 结构，没有使用 `parallel` 节点类型。引擎的 parallel 能力仅通过单元测试验证，未在实际 workflow 中使用。

### 3.2 Escalate 浮动节点缺少上下文注入

`escalate` 浮动节点没有 `beforeDispatch.inject` 配置来告知 coordinator 是哪个 gate 触发了 escalation，coordinator 收到的信息不完整。

### 3.3 `workflow.ts` 是废弃兼容层

`src/core/workflow.ts` 中所有函数标记为 `@deprecated`，仅作为向后兼容的薄包装层存在。

---

## 四、文件清单

### 核心模块 (`src/core/`)

| 文件                    | 行数 | 状态                          |
| ----------------------- | ---- | ----------------------------- |
| `types.ts`              | 617  | ✅ 完全合规                   |
| `workflow-engine.ts`    | 1165 | ✅ 完全合规                   |
| `workflow-validator.ts` | —    | ✅ 合规（minor: 死代码）      |
| `plugin.ts`             | —    | ✅ 合规                       |
| `state.ts`              | —    | ✅ 合规                       |
| `action-registry.ts`    | —    | ✅ 合规                       |
| `workflow.ts`           | —    | ⚠️ 废弃兼容层                 |
| `docs.ts`               | —    | ⚠️ 未重命名为 artifacts.ts    |
| `schema.ts`             | —    | ⚠️ scale 兼容代码残留         |
| `registry.ts`           | —    | ⚠️ 创建 docs/ 而非 artifacts/ |
| `overrides.ts`          | —    | ⚠️ 注释错误                   |

### 工具 (`src/tools/`)

| 文件                    | 状态                         |
| ----------------------- | ---------------------------- |
| `artifact-tools.ts`     | ✅                           |
| `approve-artifact.ts`   | ✅                           |
| `dispatch-role.ts`      | ✅（⚠️ artifact 要求未过滤） |
| `report-dispatch.ts`    | ✅（⚠️ 取消不更新节点）      |
| `project-init.ts`       | ✅                           |
| `get-project-status.ts` | ✅                           |
| `engine-helpers.ts`     | ⚠️ getInputArtifacts 是 TODO |
| `iteration-start.ts`    | ✅                           |
| `patch-start.ts`        | ✅                           |

### Hooks (`src/hooks/`) — ⚠️ 应迁移到插件

| 文件             | 行数 | 说明                        |
| ---------------- | ---- | --------------------------- |
| `install.ts`     | 71   | 硬编码 import，非通用安装器 |
| `content.ts`     | 127  | 共享常量，应移入插件        |
| `claude-code.ts` | 228  | Claude Code hook 生成       |
| `opencode.ts`    | 236  | OpenCode hook 生成          |
| `openclaw.ts`    | 229  | OpenClaw hook 生成          |

### Dev Workflow 插件 (`workflows/dev/`)

| 文件                   | 状态                      |
| ---------------------- | ------------------------- |
| `workflow.json`        | ✅（⚠️ 无 parallel 节点） |
| `hooks.js`             | ⚠️ 薄桥接，非自包含       |
| `roles/coordinator.md` | ✅ 已重命名               |
| `roles/architect.md`   | ✅                        |
| `roles/developer.md`   | ✅                        |
| `roles/tester.md`      | ✅                        |
| `schemas/`             | ✅ 28 个 schema 文件      |

---

## 五、结论

重构的核心目标——从硬编码流水线到通用节点引擎——已基本达成。类型系统、引擎、验证器、插件加载、状态管理均已按设计实现，406 个测试全部通过。

主要差距集中在"最后一公里"的迁移工作：

1. **P0**: Hook 外部化是唯一的架构级阻塞项，直接限制多 workflow 扩展
2. **P1**: 术语迁移和 cancelled 状态处理属于合规性问题
3. **P2-P3**: 功能增强和代码清理，不影响当前功能

建议按优先级依次处理，P0 应在任何新 workflow 开发之前完成。
