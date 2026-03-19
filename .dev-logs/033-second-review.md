# 033 — 第二轮综合分析报告

> 对照原始重构计划 (027/028) 与第一轮修复 (030/031/032)，对当前源码进行全面对比分析。

---

## 一、第一轮修复验证

第一轮 (030/031/032) 标记修复的 P0/P1/P2 项目已全部验证确认：

| ID  | 问题                                                        | 状态          |
| --- | ----------------------------------------------------------- | ------------- |
| A.1 | beforeDispatch hooks 集成到 dispatch-role.ts                | ✅ 已确认     |
| A.2 | afterComplete hooks 集成到 report-dispatch.ts               | ✅ 已确认     |
| A.3 | Role prompt 术语修复 (architect/developer/tester.md)        | ✅ 已确认     |
| B.1 | artifact_field gate 条件 (resolveFieldPath + artifactCache) | ✅ 已确认     |
| B.2 | query_status 跳过 persistState                              | ✅ 已确认     |
| B.3 | patch_start 通过 state.meta 持久化 issue_id/description     | ✅ 已确认     |
| B.4 | Validator cycle 检测放宽 (hasExit 只需 maxRetries)          | ✅ 已确认     |
| C.3 | Plugin loading 错误已改为 console.warn                      | ✅ 已确认     |
| C.4 | workflow.ts skipValidation 设为 false                       | ✅ 已确认     |
| C.1 | GotoTarget discriminant field                               | ⏸️ 按计划延期 |
| C.2 | reevaluateGates 只处理首个 gate                             | ⏸️ 按计划延期 |

**结论**: 第一轮修复全部生效，无回归。

---

## 二、架构/计划合规性问题 (Architecture Conformance)

### F1 — Hooks 未真正外置到 Plugin [027 §17]

**计划要求**: "Hook 完全外置: Plugin 提供 hook 内容, Core 只负责传递和安装。"

**实际情况**: 所有 hook 逻辑（guard 规则 + reminder 生成）仍在 `src/hooks/` 目录内：

- `claude-code.ts` (228行) — Claude Code hook 生成
- `opencode.ts` (236行) — OpenCode hook 生成
- `openclaw.ts` (229行) — OpenClaw hook 生成
- `content.ts` (127行) — 共享常量
- `install.ts` (71行) — 安装编排器

`workflows/dev/hooks.js` 只是一个薄桥接层 (`module.exports = require('../../build/hooks/install.js')`)，并未真正将 hook 内容外置。自定义 workflow 无法定义自己的 hooks。

**影响**: 中等。违反插件化设计原则，但功能正常。
**建议优先级**: P2

### F2 — `workflows/dev/tools.ts` 缺失 [028 §1.5]

**计划要求**: dev plugin 应有 `tools.ts` 用于注册 dev 特有的 actions。

**实际情况**: 文件不存在。`ActionRegistry` 类已实现但没有任何 plugin 注册过 actions。

**影响**: 低。当前功能不依赖此机制。
**建议优先级**: P3

### F3 — Override 系统仍为 3 层，计划要求 2 层 [027 §20]

**计划要求**: "全局 overrides.json 移除。两层合并: 项目级 > 工作流默认值。"

**实际情况**: `overrides.ts` 的 `getMergedOverrides()` 仍然读取全局 (`~/.config/harmonia/overrides.json`) 和项目级两个文件，实现 3 层合并 (global → project → workflow defaults)。MCP tools 中操作 overrides 的部分已正确移除，但底层文件支持仍在。

**影响**: 低。全局文件通常不存在，不影响行为。
**建议优先级**: P3

### F4 — `docs.ts` 未重命名为 `artifacts.ts` [028 §3.4]

**计划要求**: 术语映射 doc → artifact，"所有位置"。

**实际情况**: 核心文件仍为 `docs.ts`，函数命名 `writeDoc`/`readDoc`/`listDocs`，磁盘目录仍为 `docs/`，所有调用者使用旧函数名。

**影响**: 低。纯术语问题，不影响功能。
**建议优先级**: P3

### F5 — `getInputArtifacts` 是空桩 [027 §13]

**计划要求**: `NextAction.inputArtifacts` 应填充节点所需的输入 artifacts。

**实际情况**: `engine-helpers.ts:109-113` 始终返回 `[]`，注释 "Phase 4"。

**影响**: 中等。角色调度时不会自动提供上下文 artifacts。
**建议优先级**: P2

### F6 — `workflow.ts` 兼容层仍被使用 [028 Phase 6]

**计划要求**: Phase 6 应删除旧兼容层。

**实际情况**: 标记 `@deprecated` 但仍被 `schema.ts`（通过 `resolveWorkflowDir`）和 `engine-helpers.ts`（通过 `loadWorkflow`）活跃使用。

**影响**: 低。功能正确，只是依赖未清理。
**建议优先级**: P3

---

## 三、术语残留 (Terminology Residuals)

### F7 — 核心模块函数/变量名未迁移

以下位置仍使用旧的 `doc` 术语（应为 `artifact`）：

| 文件           | 位置     | 当前                              | 应改为                                           |
| -------------- | -------- | --------------------------------- | ------------------------------------------------ |
| `docs.ts`      | 全文件   | `writeDoc`, `readDoc`, `listDocs` | `writeArtifact`, `readArtifact`, `listArtifacts` |
| `docs.ts`      | 磁盘目录 | `docs/`                           | `artifacts/` (需迁移策略)                        |
| `reviews.ts`   | 函数名   | `getDocReview`                    | `getArtifactReview`                              |
| `reviews.ts`   | 内部 key | `docs`                            | `artifacts`                                      |
| `steps.ts`     | 函数名   | `isDocFinalized`                  | `isArtifactFinalized`                            |
| `steps.ts`     | 内部 key | `docs`                            | `artifacts`                                      |
| `overrides.ts` | 函数名   | `resolveDocReview`                | `resolveArtifactReview`                          |
| `schema.ts`    | 参数名   | `docId`, `docDef`                 | `artifactId`, `artifactDef`                      |
| `content.ts`   | 常量名   | `PHASE_IDLE_TIMEOUT_MINUTES`      | `WORKFLOW_IDLE_TIMEOUT_MINUTES`                  |

**建议优先级**: P3（纯重命名，可批量处理）

### F8 — 注释残留

| 文件                | 行号 | 残留注释                                                       |
| ------------------- | ---- | -------------------------------------------------------------- |
| `dispatch-role.ts`  | 多处 | "of phase definitions", "No scale filtering", "not from phase" |
| `engine-helpers.ts` | ~113 | "Phase 4"                                                      |

**建议优先级**: P3

---

## 四、代码质量问题 (Code Quality)

### F9 — DRY 违反: buildOverrideSection 重复 [P2]

`dispatch-role.ts` 中的 `buildOverrideSection()` 与 `get-role-prompt.ts` 中的 `buildOverridePromptSection()` 功能几乎完全相同。

**建议**: 抽取到 `utils.ts` 或新建共享模块。

### F10 — DRY 违反: collectTaskNodes 重复 [P2]

`dispatch-role.ts` 中的 `collectTaskNodes()` 与 `report-dispatch.ts` 中的 `findTaskNodeById()` 是同一逻辑的两种实现（遍历节点树查找 task 节点）。

**建议**: 合并到 `engine-helpers.ts`。

### F11 — approve-artifact.ts: resolveReview 缺少 dir 参数 [P1]

`approve-artifact.ts:30` 调用 `resolveReview()` 时未传递 `ctx.dir`，如果 `contextDir` 对路径解析有影响，这可能是一个 bug。

**建议**: 检查 `resolveReview()` 是否依赖 dir 参数，如是则修复。

### F12 — iteration-start.ts: rootState 未使用 [P3]

`iteration-start.ts:57` 声明了 `rootState` 变量但从未使用（死代码）。

**建议**: 删除。

### F13 — patch-start.ts: meta 可能被覆盖 [P2]

如果 `startWorkflow` 深拷贝了 state，那么之后对 `state.meta` 的第二次 `persistState` 写入的 `issue_id`/`description` 可能不会生效。

**建议**: 确认 `startWorkflow` 的拷贝行为，或将 meta 写入移到 `startWorkflow` 调用之前。

### F14 — artifact-tools.ts handleFinalStep: 格式验证用错来源 [P1]

`handleFinalStep` 中 `isJson` 使用 `stepDef.format` 而非 `artifactDef.format` 来决定最终 schema 验证的格式。如果 step 没有定义 `format` 但 artifact 定义了 `json`，最终验证会跳过 JSON schema 校验。

**建议**: 应使用 `artifactDef.format` 作为最终验证的格式依据。

### F15 — readDoc 不支持 JSON 格式 [P2]

`docs.ts` 的 `readDoc()` 只尝试 `.md` 和 `.html` 扩展名，但 `ArtifactDefinition` 支持 `format: 'json'`。如果 artifact 以 JSON 格式写入，`readDoc` 无法读取。

**建议**: 添加 `.json` 扩展名支持。

### F16 — schema.ts 依赖废弃的 workflow.ts [P3]

`loadArtifactSchema` 从 `workflow.ts` 导入 `resolveWorkflowDir`。应迁移到直接使用 plugin 系统的路径解析。

### F17 — ValidationError 类型冲突 [P2]

`schema.ts` 和 `types.ts` 都定义了 `ValidationError`，结构不同：

- `types.ts`: `{ path: string; message: string; keyword?: string }`
- `schema.ts`: `{ instancePath: string; message?: string; keyword: string; params: any }`

如果两者在同一调用链中使用，可能导致类型混淆。

**建议**: 统一为单一定义或重命名以区分。

### F18 — isRequired() 类型签名与实际逻辑不匹配 [P3]

`schema.ts` 中 `isRequired()` 仍包含对旧 scale-based `Record<string, boolean>` 格式的向后兼容代码，但 TypeScript 类型签名只声明 `boolean`。

**建议**: 如果旧格式已彻底不用，删除兼容代码；否则修正类型签名。

---

## 五、引擎边缘情况 (Engine Edge Cases)

### F19 — activateParallel 子节点调度信息丢失 [P2]

`workflow-engine.ts` 中 `activateParallel` 激活并行子节点时，各子节点的 `nextAction` 被收集后合并为单条指令。但合并过程中可能丢失"哪些具体子节点需要调度"的信息，导致调用方无法准确知道应该分派哪些角色。

### F20 — 根节点失败返回 completed 而非 failure [P3]

当根节点失败时，引擎返回 `type: 'completed'` 的 nextAction 而非失败指示。调用方可能误判整个 workflow 成功完成。

**建议**: 根节点失败时返回包含 failure 信息的响应。

---

## 六、测试状态

```
22 个测试文件 · 406 个测试 · 全部通过 ✅
```

测试覆盖范围: engine, validator, action-registry, plugin, state, dispatch, hooks, schema, steps, reviews, overrides, issues, CLI, setup。

---

## 七、优先级汇总

### P1 — 潜在 Bug（建议尽快修复）

| ID  | 问题                               | 文件                     |
| --- | ---------------------------------- | ------------------------ |
| F11 | `resolveReview()` 缺少 dir 参数    | `approve-artifact.ts:30` |
| F14 | `handleFinalStep` 格式验证用错来源 | `artifact-tools.ts`      |

### P2 — 设计偏差 / 中等影响（建议近期修复）

| ID  | 问题                            | 文件                                     |
| --- | ------------------------------- | ---------------------------------------- |
| F1  | Hooks 未外置到 Plugin           | `src/hooks/*`, `workflows/dev/hooks.js`  |
| F5  | `getInputArtifacts` 空桩        | `engine-helpers.ts:109-113`              |
| F9  | buildOverrideSection 重复       | `dispatch-role.ts`, `get-role-prompt.ts` |
| F10 | collectTaskNodes 重复           | `dispatch-role.ts`, `report-dispatch.ts` |
| F13 | patch-start meta 可能被覆盖     | `patch-start.ts`                         |
| F15 | readDoc 不支持 JSON 格式        | `docs.ts`                                |
| F17 | ValidationError 类型冲突        | `schema.ts`, `types.ts`                  |
| F19 | activateParallel 子节点信息丢失 | `workflow-engine.ts`                     |

### P3 — 技术债务 / 低影响（可规划批量处理）

| ID  | 问题                     | 文件                                    |
| --- | ------------------------ | --------------------------------------- |
| F2  | `tools.ts` 缺失          | `workflows/dev/`                        |
| F3  | Override 仍 3 层         | `overrides.ts`                          |
| F4  | `docs.ts` 未重命名       | `docs.ts`                               |
| F6  | 废弃兼容层仍在用         | `workflow.ts`                           |
| F7  | 术语残留 (doc→artifact)  | 多个文件                                |
| F8  | 注释残留                 | `dispatch-role.ts`, `engine-helpers.ts` |
| F12 | rootState 未使用         | `iteration-start.ts:57`                 |
| F16 | schema 依赖废弃模块      | `schema.ts`                             |
| F18 | isRequired 类型不匹配    | `schema.ts`                             |
| F20 | 根节点失败返回 completed | `workflow-engine.ts`                    |

---

## 八、结论

### 整体评估

重构后的 Harmonia 架构在**功能层面基本符合 027/028 计划**:

- 工作流引擎（节点状态机、gate 评估、goto、failure 冒泡）完整实现 ✅
- Plugin 发现/加载机制完整 ✅
- 验证器 7 项检查完整 ✅
- 第一轮修复全部生效，无回归 ✅
- 406 项测试全部通过 ✅

### 主要差距

1. **2 个潜在 Bug** (F11, F14) 需要立即验证和修复
2. **Hook 外置**和 **inputArtifacts** 是最大的架构偏差（F1, F5），但不阻塞当前使用
3. **术语迁移** (doc→artifact) 未完成，约 9 个文件需要批量处理
4. **代码重复** 2 处 (F9, F10) 可在下次维护窗口合并

### 建议下一步

1. 先修 P1（2 个潜在 bug），确认影响范围
2. 再处理 P2 中的实际 bug (F13, F15, F17)
3. P2 中的设计项 (F1, F5, F9, F10, F19) 可按迭代安排
4. P3 术语/清理项批量处理
