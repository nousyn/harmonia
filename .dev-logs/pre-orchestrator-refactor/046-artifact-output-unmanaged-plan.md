# 046 — Artifact 可配置输出路径 + external → unmanaged 重命名

> 为 `ArtifactDefinition` 新增 `output` 字段实现可配置输出路径，同时将 `external` 重命名为语义更清晰的 `unmanaged`。

---

## 目标

1. **`output` 字段** — 基于占位符的路径系统，控制 artifact 存储目录
2. **`external` → `unmanaged`** — 语义重命名，明确"Harmonia 不通过 artifact_write 管理此 artifact"
3. **验证规则** — 在 `workflow-validator.ts` 中新增 artifact definition 验证
4. **prompt 提示** — unmanaged artifact 的 dispatch prompt 中注入输出路径提示

## 设计

### `output` 占位符系统

| 占位符      | 解析值                                        | 说明                                                |
| ----------- | --------------------------------------------- | --------------------------------------------------- |
| `{global}`  | `<data_dir>/<project_name>/iter-N/artifacts/` | 当前默认行为（全局 artifacts 目录）                 |
| `{project}` | `<projectDir>/`                               | 项目源码目录                                        |
| `{context}` | `iter-N` 或 `patch-N`                         | 上下文标识，必须跟在 `{global}` 或 `{project}` 后面 |

- `output` 为 `undefined` 时等同于 `{global}`（向后兼容）
- `output` 仅控制**目录**，文件名始终为 `<artifactId>.<ext>`

### 路径解析示例

| `output` 值                | 解析结果                                             |
| -------------------------- | ---------------------------------------------------- |
| `undefined`                | `<data_dir>/<project>/iter-1/artifacts/spec.md`      |
| `{global}/prds`            | `<data_dir>/<project>/iter-1/artifacts/prds/spec.md` |
| `{project}/docs`           | `<projectDir>/docs/spec.md`                          |
| `{project}/{context}/docs` | `<projectDir>/iter-1/docs/spec.md`                   |

### `unmanaged` 与 `output` 的交互

| `unmanaged`  | `output` | 行为                                                            |
| ------------ | -------- | --------------------------------------------------------------- |
| `false`/未设 | 未设     | artifact_write 写入 `{global}` 目录                             |
| `false`/未设 | 已设     | artifact_write 写入 `output` 解析后的目录                       |
| `true`       | 未设     | artifact_write 拒绝；dispatch prompt 显示默认路径提示           |
| `true`       | 已设     | artifact_write 拒绝；dispatch prompt 显示 `output` 解析路径提示 |

### 验证规则（workflow-validator.ts）

1. `output` 必须以 `{global}` 或 `{project}` 开头
2. `{context}` 必须出现在 `{global}` 或 `{project}` 之后，不能单独使用
3. 不允许未知占位符
4. 路径中不允许 `..`（防止目录穿越）

### resolveArtifactDir 接口

```typescript
/** Artifact I/O 所需的上下文信息 */
interface ArtifactIOContext {
  contextDir: string; // iter-N/ 或 patch-N/ 的绝对路径
  projectDir: string; // 项目源码目录
  contextLabel: string; // "iter-1" 或 "patch-2"
}

function resolveArtifactDir(
  output: string | undefined, // artifact definition 的 output 字段
  ioCtx: ArtifactIOContext,
): string; // 返回解析后的绝对目录路径
```

> **修正**（审查 R1）: 原设计接收 `artifactsDir`（已拼接的路径），但实际代码中所有调用者持有的是 `contextDir`（未拼接）。
> 改为接收 `contextDir`，函数内部自行拼接 `artifacts/`。同时引入 `ArtifactIOContext` 结构，为后续所有 I/O 函数提供统一的参数包。

### 设计决策

- **Overrides 不支持覆盖 `output`** — 不同输出需求应使用不同 workflow plugin
- **`{project}` 路径跨迭代写入同一位置** — 符合预期（类似源码迭代覆盖）
- **Step artifacts 跟随主 artifact 的 `output` 配置**
- **Gate `match` OR 逻辑** — 设计就绪但不实现（YAGNI）

## 变更计划

### Phase 1: 类型定义

| 编号 | 内容                                                                 | 文件              |
| ---- | -------------------------------------------------------------------- | ----------------- |
| 1.1  | `ArtifactDefinition` 新增 `unmanaged?: boolean` 和 `output?: string` | src/core/types.ts |
| 1.2  | 移除 `external?: boolean` 字段                                       | src/core/types.ts |
| 1.3  | `ValidationError` 新增 artifact 验证相关 type 值                     | src/core/types.ts |

### Phase 2: 路径解析

| 编号 | 内容                                                     | 文件                  |
| ---- | -------------------------------------------------------- | --------------------- |
| 2.1  | 新增 `resolveArtifactDir()` 函数 — 占位符解析 + 路径拼接 | src/core/artifacts.ts |
| 2.2  | 保留 `artifactsDir()` 不变（作为 `{global}` 的底层实现） | src/core/artifacts.ts |

### Phase 3: 验证

| 编号 | 内容                                                                             | 文件                           |
| ---- | -------------------------------------------------------------------------------- | ------------------------------ |
| 3.1  | 新增 `validateArtifactDefinitions()` — 验证 output 格式和 unmanaged 配置         | src/core/workflow-validator.ts |
| 3.2  | `validateWorkflow()` 签名新增 `artifactDefinitions` 参数，内部调用 artifact 验证 | src/core/workflow-validator.ts |

### Phase 4: 写入适配

| 编号 | 内容                                                               | 文件                  |
| ---- | ------------------------------------------------------------------ | --------------------- |
| 4.1  | `writeArtifact` 接收 `artifactDef` 参数，使用 `resolveArtifactDir` | src/core/artifacts.ts |
| 4.2  | `writeStepArtifact` 同步适配                                       | src/core/artifacts.ts |

### Phase 5: 读取适配

| 编号 | 内容                                                                                                                                                                                                                        | 文件                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 5.1  | `readArtifact` 接收 `artifactDef` 参数，使用 `resolveArtifactDir`                                                                                                                                                           | src/core/artifacts.ts |
| 5.2  | `readStepArtifact` 同步适配                                                                                                                                                                                                 | src/core/artifacts.ts |
| 5.3  | `listArtifacts` 重写 — 接收 `artifactDefinitions` + `ArtifactIOContext`，按 `resolveArtifactDir` 结果分组后每个唯一目录做一次 `readdir`，在内存中匹配 artifactId（避免 N 次 `access`，改为 M 次 `readdir`，M = 唯一目录数） | src/core/artifacts.ts |

### Phase 6: Gate 适配

| 编号 | 内容                                                                      | 文件                        |
| ---- | ------------------------------------------------------------------------- | --------------------------- |
| 6.1  | `buildEngineContext` 中 `artifactExists`/`artifactField` 使用 output 路径 | src/tools/engine-helpers.ts |

### Phase 7: 工具层

| 编号 | 内容                                                                                                                                         | 文件                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 7.1  | `artifact_tools.ts` — `external` → `unmanaged` 重命名                                                                                        | src/tools/artifact-tools.ts                              |
| 7.2  | `dispatch-role.ts` — `external` → `unmanaged` 重命名 + input artifact 读取适配（L364-366 的 `readArtifact` 需传入 `artifactDef` 和路径信息） | src/tools/dispatch-role.ts                               |
| 7.3  | `dispatch-role.ts` — unmanaged artifact 的 dispatch prompt 注入 output 路径提示                                                              | src/tools/dispatch-role.ts                               |
| 7.4  | `artifact_read` — 两条路径（指定 context 跨 context 读取 / 默认 context）均需加载 workflow 以获取 `artifactDef`，用于解析 output 路径        | src/tools/artifact-tools.ts                              |
| 7.5  | `get-project-status.ts` — 适配 `listArtifacts` 新签名                                                                                        | src/tools/get-project-status.ts                          |
| 7.6  | `artifact_list` 工具 — 适配 `listArtifacts` 新签名（需加载 workflow）                                                                        | src/tools/artifact-tools.ts                              |
| 7.7  | `handleSequentialWrite` / `handleFinalStep` — 传递 output 相关参数给 `writeStepArtifact` / `writeArtifact`                                   | src/tools/artifact-tools.ts                              |
| 7.8  | `ActionContext.artifacts` 的 `read`/`list` lambda 适配新签名（`dispatch-role.ts:329-332`、`report-dispatch.ts:175-178`）                     | src/tools/dispatch-role.ts, src/tools/report-dispatch.ts |

### Phase 8: plugin.ts 集成

| 编号 | 内容                                                     | 文件               |
| ---- | -------------------------------------------------------- | ------------------ |
| 8.1  | `loadDefinition` 传递 `artifactDefinitions` 给 validator | src/core/plugin.ts |

### Phase 9: 配置 & 文档

| 编号 | 内容                                                                | 文件                        |
| ---- | ------------------------------------------------------------------- | --------------------------- |
| 9.1  | `workflow.json` — `code` artifact: `external` → `unmanaged`         | workflows/dev/workflow.json |
| 9.2  | `workflow-guide.md` — artifact 字段表更新（新增 output、unmanaged） | docs/workflow-guide.md      |
| 9.3  | `workflow-guide.md` — 新增 output 路径示例                          | docs/workflow-guide.md      |

### Phase 10: 测试

| 编号 | 内容                                                                                       | 文件                             |
| ---- | ------------------------------------------------------------------------------------------ | -------------------------------- |
| 10.1 | `resolveArtifactDir` 单元测试 — 各占位符组合                                               | tests/artifacts.test.ts          |
| 10.2 | artifact definition 验证测试 — 合法/非法 output 格式                                       | tests/workflow-validator.test.ts |
| 10.3 | `writeArtifact`/`readArtifact` 集成测试 — output 路径写入/读取                             | tests/artifacts.test.ts          |
| 10.4 | 运行全量测试确认无回归                                                                     | —                                |
| 10.5 | `tests/workflow-validator.test.ts` — 所有 `validateWorkflow` 调用（25处）补充第三参数 `{}` | tests/workflow-validator.test.ts |

## 执行顺序

Phase 1 → 2 → 3 → 8 → 4 → 5 → 6 → 7 → 9 → 10

先确保类型和路径解析就位，再接入验证和 plugin 加载，然后改造读写和 gate 逻辑，最后更新工具层、文档和测试。

## 预估变更量

- 修改约 50 行现有代码（含 25 处测试调用签名适配）
- 新增约 180 行代码
- 涉及 13-17 个文件

## 审查记录

> 审查日期: 2026-03-20

### 修正项

| ID  | 问题                                                                                                       | 修正                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| R1  | `resolveArtifactDir` 参数用 `artifactsDir`（已拼接路径），但调用者持有 `contextDir`                        | 改为接收 `contextDir`，引入 `ArtifactIOContext` 统一参数包                              |
| R2  | Phase 5.3 `listArtifacts` "基于 definition 检查" 描述含糊，未说明需要 `artifactDefinitions` 参数和遍历机制 | 明确写清：接收 `artifactDefinitions` + `ArtifactIOContext`，遍历 resolve 后检查文件存在 |
| R3  | Phase 3.2 未说明 `validateWorkflow()` 签名需要新增 `artifactDefinitions` 参数                              | 已补充签名变更                                                                          |
| R4  | 预估变更量偏低（16行修改+120行新增）                                                                       | 修正为 ~30 行修改 + ~170 行新增                                                         |

### 遗漏项（已补入计划）

| ID  | 遗漏内容                                                                                                                      | 补入 Phase       |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| M1  | `artifact_list` 工具（`artifact-tools.ts:304`）也调用 `listArtifacts`，签名变更后需适配                                       | Phase 7.6        |
| M2  | `handleSequentialWrite` / `handleFinalStep` 中的 `writeStepArtifact` / `writeArtifact` 调用需传递 output 相关参数             | Phase 7.7        |
| M3  | `ActionContext.artifacts` 的 `read`/`list` lambda（`dispatch-role.ts:329-332`、`report-dispatch.ts:175-178`）签名变更后需适配 | Phase 7.8        |
| M4  | `validateWorkflow` 签名新增参数后，`tests/workflow-validator.test.ts` 中 25 处调用需加第三参数 `{}`                           | Phase 10.5       |
| M5  | `dispatch-role.ts:366` 读取 input artifacts 的 `readArtifact` 调用需传入 `artifactDef` + 路径解析参数                         | Phase 7.2 (扩展) |

### 已验证无误项

- `writeArtifact` 已有 `artifactDef` 参数（L33），Phase 4 只需内部使用 `output` 字段，无需改签名
- `readArtifact` 不接收 `artifactDef`，Phase 5 需新增参数 + 各调用者适配
- `buildEngineContext` 通过 `wf` 参数可获取 `artifactDefinitions`，无需额外参数
- `registry.ts` 中 `artifacts/` 目录创建保留不动（`{global}` 路径仍需要）
- `{project}` 路径写入时 `mkdir(dir, { recursive: true })` 已存在，自动创建中间目录
- `readArtifact` 的 try-catch 扩展名探测机制兼容新路径，不会产生误导错误

### 优化建议

1. **`readArtifact` 精确定位优化** — 传入 `artifactDef` 后可用 `getArtifactExtension(artifactDef)` 直接定位文件，失败时再 fallback 到扩展名探测，减少无谓的 fs 调用（Phase 5 中一并实施）
2. **`ArtifactIOContext` 复用** — 引入后可在后续重构中统一所有 artifact I/O 函数的参数风格（当前各函数分别接收 `projectName, iteration, contextDir` 三个独立参数，可简化。后续单独做）

### 三次审查补充（N1-N3）

| ID  | 内容                                                                                                                                                                                        | 处理                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| N1  | `artifacts.ts` 5 个函数的 `projectName` 和 `iteration` 参数完全是死代码（从未使用），引入 `ArtifactIOContext` 时可一步清理。但会扩大变更面。                                                | 记录，后续计划考虑优化        |
| N2  | `listArtifacts` 重写方案：按 `resolveArtifactDir` 结果分组，相同目录的 definitions 合并，每个唯一目录只做一次 `readdir` 后内存匹配，避免 N×3 次 `fs.access`                                 | 已采纳，已更新 Phase 5.3 描述 |
| N3  | `artifact_read`（Phase 7.4）有两条路径：指定 `context` 的跨 context 读取和默认 context 读取，两条路径当前都没有 workflow 加载逻辑，实现时需在**两个分支**都加载 workflow 获取 `artifactDef` | 已采纳，已更新 Phase 7.4 描述 |

### 二次审查确认（全量 grep 验证）

- [x] `.external` 引用：4 处（`artifact-tools.ts` 2处、`dispatch-role.ts` 2处），均已在 Phase 7.1/7.2 覆盖
- [x] `"external"` JSON 引用：1 处（`workflows/dev/workflow.json:245`），已在 Phase 9.1 覆盖
- [x] `external` 文档引用：2 处（`docs/workflow-guide.md:412, 429`），已在 Phase 9.2 覆盖
- [x] `types.ts:176` 类型定义：已在 Phase 1.2 覆盖
- [x] `readArtifact` 调用：6 处源码 + 6 处测试，所有源码调用已在 Phase 5-7 覆盖
- [x] `listArtifacts` 调用：5 处源码 + 3 处测试，所有源码调用已在 Phase 5-7 覆盖
- [x] `writeArtifact` 调用：3 处源码 + 8 处测试，所有源码调用已在 Phase 4/7 覆盖
- [x] `validateWorkflow` 调用：1 处源码（plugin.ts:286）+ 25 处测试，分别在 Phase 8.1 和 Phase 10.5 覆盖
- [x] `ActionContext.artifacts` lambda：2 处（dispatch-role、report-dispatch），已在 Phase 7.8 覆盖
- [x] `overrides.ts`：不涉及 `external`，不受影响
- [x] `workflow-engine.ts`：不直接调用 artifact I/O，通过 `GateContext` 接口间接使用，接口不变
- [x] `schema.ts` / `steps.ts` / `reviews.ts`：不涉及 artifact 路径，不受影响
- [x] 仅 1 个 `workflow.json`（`workflows/dev/`），无其它 plugin 需要同步

---

## 完成状态

> 完成日期: 2026-03-20

### 全部 10 个 Phase 已完成

| Phase | 描述                                                                   | 状态 |
| ----- | ---------------------------------------------------------------------- | ---- |
| 1     | 类型定义（`unmanaged`/`output`/`invalid_artifact_output`）             | ✅   |
| 2     | 路径解析（`ArtifactIOContext`/`resolveArtifactDir`/`resolveDir`）      | ✅   |
| 3     | 验证（`validateArtifactDefinitions` + `validateWorkflow` 签名扩展）    | ✅   |
| 8     | plugin.ts 集成（传递 `artifactDefinitions` 到 validator）              | ✅   |
| 4     | 写入适配（`writeArtifact`/`writeStepArtifact` + `ioCtx`）              | ✅   |
| 5     | 读取适配（`readArtifact`/`readStepArtifact`/`listArtifacts` 重写）     | ✅   |
| 6     | Gate 适配（`buildEngineContext` + `ioCtx`）                            | ✅   |
| 7     | 工具层（7.1-7.8 全部子任务完成）                                       | ✅   |
| 9     | 配置 & 文档（`workflow.json` + `workflow-guide.md`）                   | ✅   |
| 10    | 测试（resolveArtifactDir 8例 + 集成 3例 + validator 13例 = 24 新测试） | ✅   |

### 测试统计

- 总测试数：355（原 331 + 新增 24）
- TypeScript 编译：通过（`npx tsc --noEmit`）
- 全量测试：通过（`npx vitest run`）

### 遗留事项

- **N1**（技术债）：`artifacts.ts` 5 个导出函数的 `projectName`/`iteration` 参数为死代码，后续可清理
