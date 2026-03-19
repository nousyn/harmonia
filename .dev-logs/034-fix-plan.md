# 034 — 第二轮修复计划

> 基于 033-second-review.md 的发现，经二次审查确认后的修复计划。

---

## 审查修正

033 报告中的部分发现经二次代码审查后调整：

- **F11** (approve-artifact resolveReview 缺 dir): `contextDir` 是可选参数，当前调用路径自洽 → **降为 P3，本轮不修**
- **F13** (patch-start meta 覆盖): 确认浅拷贝保留 `meta`，不是 bug → **移除**
- **F19** (activateParallel): 确认 `dispatchActions` 构建了但未放入返回值，`lastAction` 被计算但未使用 → **升为 P1**

---

## 修复项（按优先级分组）

### P1 — 必须修复

| ID  | 问题                                                                          | 文件                                                               | 修复方案                                                                                                                                    |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| F14 | `handleFinalStep` 中 `isJson` 使用 `stepDef.format` 而非 `artifactDef.format` | `artifact-tools.ts:476`                                            | 改为 `artifactDef.format === 'json'`                                                                                                        |
| F19 | `activateParallel` 返回值丢失子节点调度信息                                   | `workflow-engine.ts:230-267`                                       | 1) 在 `NextAction` 接口新增 `parallelDispatch?: Array<{nodeId, role}>` 字段；2) 将 `dispatchActions` 放入返回值；3) 删除无用的 `lastAction` |
| F20 | 根节点/重试耗尽失败时返回 `type: 'completed'`                                 | `types.ts:313-320`, `workflow-engine.ts:567-575,678-685,1053-1058` | 1) `NextActionType` 新增 `'failed'`；2) 三处改用 `type: 'failed'`                                                                           |

### P2 — 应该修复

| ID  | 问题                                         | 文件                                     | 修复方案                                         |
| --- | -------------------------------------------- | ---------------------------------------- | ------------------------------------------------ |
| F15 | `readDoc` 不支持 JSON 格式                   | `docs.ts:61`                             | 扩展名列表增加 `.json`；`listDocs` 同步更新      |
| F17 | `ValidationError` 类型冲突                   | `schema.ts:41-54`                        | 重命名为 `ArtifactValidationError`，更新所有引用 |
| F9  | `buildOverrideSection` 重复                  | `dispatch-role.ts`, `get-role-prompt.ts` | 提取到 `utils.ts`，两处改为引用                  |
| F10 | `collectTaskNodes` / `findTaskNodeById` 重复 | `dispatch-role.ts`, `report-dispatch.ts` | 提取到 `engine-helpers.ts`，统一实现             |

### P3 — 可以修复

| ID  | 问题                              | 文件                                                  | 修复方案                                 |
| --- | --------------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| F12 | `rootState` 未使用                | `iteration-start.ts:57`                               | 删除该行                                 |
| F7  | 注释中术语残留 (phase→workflow)   | `dispatch-role.ts`, `engine-helpers.ts`, `content.ts` | 批量替换                                 |
| F8  | `PHASE_IDLE_TIMEOUT_MINUTES` 命名 | `content.ts`                                          | 重命名为 `WORKFLOW_IDLE_TIMEOUT_MINUTES` |

### 本轮不修（延期）

| ID  | 原因                                     |
| --- | ---------------------------------------- |
| F1  | Hooks 外置是架构级变更，需独立设计       |
| F2  | tools.ts 缺失，当前无实际需求            |
| F3  | Override 3层问题，全局文件通常不存在     |
| F4  | docs.ts 重命名涉及磁盘目录迁移，影响面大 |
| F5  | getInputArtifacts 空桩，标记为 Phase 4   |
| F6  | workflow.ts 兼容层，需先解决所有依赖     |
| F11 | contextDir 可选参数，当前自洽            |
| F18 | isRequired 向后兼容，类型签名问题小      |

---

## 执行顺序

1. F14 — 单行修复
2. F20 — types.ts 新增 `'failed'`，然后修改 engine 三处
3. F19 — types.ts 新增 `parallelDispatch` 字段，修改 engine
4. F15 — docs.ts 扩展名支持
5. F17 — schema.ts 重命名 ValidationError
6. F9 — 提取 buildOverrideSection
7. F10 — 提取 findTaskNode
8. F12 — 删除死代码
9. F7/F8 — 术语批量替换
10. 运行测试
