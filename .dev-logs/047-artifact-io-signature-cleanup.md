# 047 — Artifact I/O 签名清理 + 046 审查修复

> 移除 artifact I/O 函数中的死参数和冗余参数，统一 `ArtifactIOContext` 为唯一路径来源，修复 046 审查发现的问题。

---

## 背景

046 实现了可配置输出路径（`output` 字段）和 `external→unmanaged` 重命名。为保持向后兼容，新增参数均设为可选，保留了 legacy `contextDir` 路径。
现在功能已合入，所有调用者都已适配，可以清理技术债。

## 目标

1. **移除死参数** — `projectName` 和 `iteration` 从未被函数体使用（N1 技术债）
2. **统一路径来源** — 移除冗余的 `contextDir` 参数，`ArtifactIOContext` 作为唯一路径来源
3. **移除过渡代码** — 删除 `resolveDir` 辅助函数和 legacy 分支
4. **修复 046 审查问题** — B1-B5

## 变更计划

### Phase 1: 签名重构（artifacts.ts）

| 编号 | 内容                                                                                                                                               | 文件                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 1.1  | `writeArtifact` 签名: 移除 `projectName`, `iteration`, `contextDir`; `ioCtx` 改为必填                                                              | src/core/artifacts.ts |
| 1.2  | `readArtifact` 签名: 同上                                                                                                                          | src/core/artifacts.ts |
| 1.3  | `listArtifacts` 签名: 移除 `projectName`, `iteration`, `contextDir`; `artifactDefinitions` + `ioCtx` 改为必填                                      | src/core/artifacts.ts |
| 1.4  | `writeStepArtifact` 签名: 移除 `projectName`, `iteration`, `contextDir`; `ioCtx` 改为必填                                                          | src/core/artifacts.ts |
| 1.5  | `readStepArtifact` 签名: 移除 `projectName`, `iteration`, `contextDir`; `ioCtx` 改为必填                                                           | src/core/artifacts.ts |
| 1.6  | 删除 `resolveDir` 辅助函数 — 所有函数直接调用 `resolveArtifactDir(def?.output, ioCtx)`                                                             | src/core/artifacts.ts |
| 1.7  | `listArtifacts` 删除 legacy 分支（扫描 `contextDir/artifacts/`） — 改为 `artifactDefinitions` 为空时返回 `[]` 或仍用 `ioCtx.contextDir` 做默认扫描 | src/core/artifacts.ts |
| 1.8  | 更新文件头注释，反映新的参数设计                                                                                                                   | src/core/artifacts.ts |

#### 目标签名

```typescript
// writeArtifact
writeArtifact(artifactId: string, content: string, ioCtx: ArtifactIOContext, artifactDef?: ArtifactDefinition): Promise<string>

// readArtifact
readArtifact(artifactId: string, ioCtx: ArtifactIOContext, artifactDef?: ArtifactDefinition): Promise<string>

// listArtifacts
listArtifacts(ioCtx: ArtifactIOContext, artifactDefinitions: Record<string, ArtifactDefinition>): Promise<string[]>

// writeStepArtifact
writeStepArtifact(artifactId: string, stepId: string, content: string, format: 'json' | 'md', ioCtx: ArtifactIOContext, artifactDef?: ArtifactDefinition): Promise<string>

// readStepArtifact
readStepArtifact(artifactId: string, stepId: string, ioCtx: ArtifactIOContext, artifactDef?: ArtifactDefinition): Promise<string>
```

### Phase 2: 调用者适配（源码）

| 编号 | 内容                                                                                                                                            | 文件                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 2.1  | `artifact-tools.ts` — 所有 `writeArtifact`/`readArtifact`/`listArtifacts`/`writeStepArtifact` 调用去掉 `projectName`, `iteration`, `contextDir` | src/tools/artifact-tools.ts     |
| 2.2  | `dispatch-role.ts` — `readArtifact`/`listArtifacts` 调用及 `ActionContext.artifacts` lambda 适配                                                | src/tools/dispatch-role.ts      |
| 2.3  | `report-dispatch.ts` — `ActionContext.artifacts` lambda 适配；同时修复 B5（提取 `ioCtx` 到 lambda 外部）                                        | src/tools/report-dispatch.ts    |
| 2.4  | `engine-helpers.ts` — `listArtifacts`/`readArtifact` 调用适配                                                                                   | src/tools/engine-helpers.ts     |
| 2.5  | `get-project-status.ts` — `listArtifacts` 调用适配；同时修复 B4（加 `: ArtifactIOContext` 类型标注）                                            | src/tools/get-project-status.ts |

### Phase 3: 调用者适配（测试）

| 编号 | 内容                                                                                   | 文件                    |
| ---- | -------------------------------------------------------------------------------------- | ----------------------- |
| 3.1  | `tests/artifacts.test.ts` — 所有现有测试调用适配新签名（需为 legacy 测试构造 `ioCtx`） | tests/artifacts.test.ts |
| 3.2  | `tests/artifacts.test.ts` — output path 集成测试调用适配                               | tests/artifacts.test.ts |

### Phase 4: 046 审查修复

| 编号 | 内容                                                                             | 文件                             |
| ---- | -------------------------------------------------------------------------------- | -------------------------------- |
| 4.1  | **B1** — `validateArtifactDefinitions` 注释修正：Rule 2 改为"由 Rule 1 隐式覆盖" | src/core/workflow-validator.ts   |
| 4.2  | **B2** — 测试数据补 `name` 字段，`format: 'ts'` 改为合法值                       | tests/workflow-validator.test.ts |
| 4.3  | **B3** — `resolveDir` 已在 Phase 1.6 删除，问题自动消除                          | —                                |

### Phase 5: 验证

| 编号 | 内容                          |
| ---- | ----------------------------- |
| 5.1  | `npx tsc --noEmit` 编译通过   |
| 5.2  | `npx vitest run` 全量测试通过 |

## 执行顺序

Phase 1 → 2 → 3 → 4 → 5

先改函数签名（会导致所有调用者编译失败），然后逐文件适配调用者，最后修复审查问题并验证。

## 预估变更量

- 修改约 60 行函数签名和内部逻辑
- 修改约 40 处调用（~20 源码 + ~20 测试）
- 删除约 15 行（`resolveDir` + legacy 分支）
- 涉及 8 个文件

## 设计决策

### listArtifacts 无 definitions 时的行为

`listArtifacts` 在 Phase 1 后 `artifactDefinitions` 变为必填。当传入空 `{}` 时：

- **选择**: 用 `ioCtx.contextDir` 做默认 artifacts 目录扫描（保留 legacy 行为但通过 ioCtx 获取路径）
- **理由**: engine-helpers 等场景可能在 definitions 为空时仍需要扫描磁盘

### 参数顺序原则

采用 "what → where → how" 顺序：

1. 标识参数（`artifactId`, `stepId`）
2. 数据参数（`content`, `format`）
3. 上下文参数（`ioCtx`）
4. 可选定义（`artifactDef`）
