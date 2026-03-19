# 040 — 兼容代码清理计划

> 基于 039 实施后的全量兼容代码审计，清除所有遗留的向后兼容逻辑。
> 本项目为 pre-1.0，无外部用户，策略为"全部改名无兼容"。

---

## 清理范围

### P1 — 高优先级（功能性兼容代码）

| 编号 | 内容                                                                             | 文件                              | 行号    | 方案                                                                                                                    |
| ---- | -------------------------------------------------------------------------------- | --------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| A1   | `@deprecated FieldOperator` 类型别名                                             | `src/core/types.ts`               | 107-108 | 删除这两行。`FieldOperator` 无外部消费者，是纯死代码                                                                    |
| A2   | `(r as any).artifactId ?? (r as any).docId` 双路径回退                           | `src/tools/get-project-status.ts` | 397     | 删除 `(r as any)` 和 `?? (r as any).docId` 回退，直接使用 `r.artifactId`（需确认 `r` 的类型定义已有 `artifactId` 字段） |
| A3   | 函数参数 `docId` 应为 `artifactId`                                               | `src/core/schema.ts`              | 27, 30  | 参数名 `docId` → `artifactId`，内部变量 `docId` → `artifactId`，路径拼接中对应更新                                      |
| A4   | `skipValidation` JSDoc 说"for partially migrated plugins"                        | `src/core/plugin.ts`              | 364     | 注释改为 `@param skipValidation - Skip workflow validation (for testing)`                                               |
| A5   | `approve-artifact.ts` 调用 `resolveReview`/`getPendingReviews` 缺少 `contextDir` | `src/tools/approve-artifact.ts`   | 30, 85  | 补传 `contextDir` 参数。此项必须在 B 组（移除回退模式）之前完成                                                         |

### P2 — 中优先级（contextDir 兼容回退模式）

> **前置条件**: A5 完成后才可执行本组。
> **附带**: 所有测试文件中缺少 `contextDir` 传参的调用也需同步修复。

| 编号 | 内容                                       | 文件                    | 行号   | 方案                                                                                                                                  |
| ---- | ------------------------------------------ | ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| B1   | `contextDir ?? getIterationDir()` 兼容回退 | `src/core/artifacts.ts` | 18     | 将 `contextDir` 从可选参数改为必传参数，删除 `?? getIterationDir()` 回退逻辑，删除 `getIterationDir` import（如不再使用）             |
| B2   | 同上                                       | `src/core/state.ts`     | 21, 34 | 同 B1                                                                                                                                 |
| B3   | 同上                                       | `src/core/reviews.ts`   | 20     | 同 B1                                                                                                                                 |
| B4   | 同上                                       | `src/core/steps.ts`     | 21     | 同 B1                                                                                                                                 |
| B5   | 同上                                       | `src/core/dispatch.ts`  | 23, 28 | 同 B1，两个路径函数均需更新                                                                                                           |
| B6   | 测试文件补传 `contextDir`                  | 多个测试文件            | —      | `artifacts.test.ts`、`reviews.test.ts`、`steps.test.ts`、`dispatch.test.ts` 中所有调用补传 `contextDir`（`state.test.ts` 已正确传参） |

### P3 — 低优先级（注释 / 变量名 / 用户面文本）

#### P3a — types.ts 迁移注释

| 编号 | 内容                          | 文件                | 行号   | 方案                                        |
| ---- | ----------------------------- | ------------------- | ------ | ------------------------------------------- |
| C1   | `(renamed from doc)` 模块注释 | `src/core/types.ts` | 11     | 删除 `(renamed from doc)` 后缀              |
| C2   | `(renamed from Doc)` 分隔注释 | `src/core/types.ts` | 156    | 删除 `(renamed from Doc)` 后缀              |
| C3   | `(renamed from docId)` JSDoc  | `src/core/types.ts` | 448    | 删除 `(renamed from docId)` 后缀            |
| C4   | `(unchanged)` 迁移注释 × 2    | `src/core/types.ts` | 13, 14 | 删除 `(unchanged)` 后缀，迁移已完成无需标注 |

#### P3b — hooks 文件旧术语

| 编号 | 内容                                                        | 文件                       | 行号     | 方案                                                                                             |
| ---- | ----------------------------------------------------------- | -------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| D1   | `idle phase` → `idle timeout`                               | `src/hooks/claude-code.ts` | 10, 110  | 注释文本修正（行 10 模块注释 + 行 110 函数 JSDoc `Idle phase warning` → `Idle timeout warning`） |
| D2   | `Pending document reviews` → `Pending artifact reviews`     | `src/hooks/claude-code.ts` | 111, 157 | 注释文本修正                                                                                     |
| D3   | `PENDING_DOCS`/`DOC_ID` → `PENDING_ARTIFACTS`/`ARTIFACT_ID` | `src/hooks/claude-code.ts` | 162-177  | Shell 变量名和相关引用全部重命名                                                                 |
| D4   | `文档待审核` → `制品待审核`                                 | `src/hooks/claude-code.ts` | 177      | 用户面中文文本修正                                                                               |
| D5   | `idle phases` → `idle timeouts`                             | `src/hooks/opencode.ts`    | 16       | 注释文本修正                                                                                     |
| D6   | `Pending document reviews` → `Pending artifact reviews`     | `src/hooks/opencode.ts`    | 173      | 注释文本修正                                                                                     |
| D7   | `pendingDocs`/`docId` → `pendingArtifacts`/`artifactId`     | `src/hooks/opencode.ts`    | 176-187  | TS 变量名全部重命名                                                                              |
| D8   | `文档待审核` → `制品待审核`                                 | `src/hooks/opencode.ts`    | 187      | 用户面中文文本修正                                                                               |
| D9   | `idle phase` → `idle timeout`                               | `src/hooks/openclaw.ts`    | 34       | 注释文本修正                                                                                     |
| D10  | `Pending document reviews` → `Pending artifact reviews`     | `src/hooks/openclaw.ts`    | 156      | 注释文本修正                                                                                     |
| D11  | `pendingDocs`/`docId` → `pendingArtifacts`/`artifactId`     | `src/hooks/openclaw.ts`    | 159-170  | TS 变量名全部重命名                                                                              |
| D12  | `文档待审核` → `制品待审核`                                 | `src/hooks/openclaw.ts`    | 170      | 用户面中文文本修正                                                                               |
| D13  | `Harmonia PM 边界守卫` → `Harmonia coordinator 边界守卫`    | `src/hooks/openclaw.ts`    | 227      | 旧角色名修正                                                                                     |

#### P3c — 其他文件旧术语

| 编号 | 内容                                                   | 文件                          | 行号 | 方案                                       |
| ---- | ------------------------------------------------------ | ----------------------------- | ---- | ------------------------------------------ |
| E1   | `PM does project registration` → `Coordinator does...` | `src/cli/setup.ts`            | 6    | 注释文本修正                               |
| E2   | `Inject PM prompt` → `Inject coordinator prompt`       | `src/index.ts`                | 62   | CLI help 文本修正                          |
| E3   | `Scale concept removed` 迁移注释                       | `src/core/schema.ts`          | 7    | 删除该注释行（迁移已完成，不需要解释历史） |
| E4   | `Scale concept removed` 迁移注释                       | `src/tools/artifact-tools.ts` | 35   | 同 E3                                      |

---

## 执行顺序

```
阶段 1: P1 高优先级
  ├── A1  删除 @deprecated FieldOperator
  ├── A2  移除 docId 双路径回退
  ├── A3  schema.ts docId → artifactId
  ├── A4  plugin.ts skipValidation 注释修正
  ├── A5  approve-artifact.ts 补传 contextDir
  └── 🧪 运行全量测试

阶段 2: P2 contextDir 兼容回退移除
  ├── B1-B5  五个核心模块移除 contextDir 回退
  ├── B6     测试文件补传 contextDir
  └── 🧪 运行全量测试

阶段 3: P3 注释/术语/变量名清理
  ├── C1-C3  types.ts 迁移注释清理
  ├── D1-D13 hooks 文件旧术语修正
  ├── E1-E4  其他文件旧术语修正
  └── 🧪 运行全量测试
```

---

## 依赖关系

```
A5 (approve-artifact 补传 contextDir) ─── 必须先于 ──→ B1-B5 (移除 contextDir 回退)
B1-B5 (移除回退) ─── 必须同步 ──→ B6 (测试文件补传 contextDir)
其余项无强依赖，可并行执行
```

---

## 风险评估

| 风险                                         | 影响 | 缓解                                                                   |
| -------------------------------------------- | ---- | ---------------------------------------------------------------------- |
| B 组移除 contextDir 可选后编译不通过         | 中   | 先 grep 所有调用点，确保每处都已补传 contextDir 再改签名               |
| D 组 hooks shell 变量重命名可能遗漏引用      | 低   | 逐行检查 shell 脚本中变量引用，改完后跑测试验证                        |
| A5 需要从 approve-artifact 中获取 contextDir | 中   | 检查调用上下文（handler 中是否有 ctx 包含 contextDir），确保数据流畅通 |

---

## 统计

| 优先级   | 项目数 | 涉及文件数       |
| -------- | ------ | ---------------- |
| P1 高    | 5      | 5                |
| P2 中    | 6      | 6 (含测试)       |
| P3 低    | 22     | 8                |
| **合计** | **33** | **12 (+4 测试)** |

> 估算：约 3-4 小时。可在一次会话中完成。
