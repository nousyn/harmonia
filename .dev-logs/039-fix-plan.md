# 039 — 综合修复计划

> 基于 038 元分析结论和遗漏项补充，对所有待处理项制定统一修复计划。
> 按 P1 → P2 → P3 顺序执行，每个优先级完成后跑全量测试。

---

## 修复范围

### P1 — 功能缺陷修复

| 编号 | 内容                                                                  | 文件                           | 方案                                                                                                                                                                  |
| ---- | --------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | `dispatch_report` cancelled 路径不触发 engine 事件，节点永远 `active` | `src/tools/report-dispatch.ts` | cancelled 路径增加 `processWorkflowEvent({ type: 'node_failed' })`，reason 标记为 cancelled。设计上 cancelled 等同于"被手动终止的失败"，节点应变为 failed 状态        |
| A2   | `getInputArtifacts` 空桩返回 `[]`                                     | `src/tools/engine-helpers.ts`  | 实现基于节点 `beforeDispatch.inject` 中引用的 artifact IDs 做解析，读取已存在的 artifacts 内容返回。最小可行版本：遍历节点 role 的 capabilities 中声明的 artifact IDs |

### P2 — 架构合规

| 编号 | 内容                                         | 文件                                                     | 方案                                                                                                                                                                                                                                                                                     |
| ---- | -------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1   | Hooks 外置到 plugin                          | `src/hooks/install.ts` + `workflows/dev/hooks.ts`        | `install.ts` 改为通过 plugin 的 `hookCreator` 动态获取 hook 内容，移除硬编码 import。`workflows/dev/hooks.ts` 改为直接 export hook 创建函数。常量名 `PHASE_IDLE_TIMEOUT_MINUTES` → `WORKFLOW_IDLE_TIMEOUT_MINUTES` 一并处理（F8 随附）                                                   |
| B2   | `docs.ts` → `artifacts.ts` 重命名 + 术语迁移 | `src/core/docs.ts` + 5 个消费者 + `src/core/registry.ts` | 文件重命名，函数名 `writeDoc/readDoc/listDocs/writeStepArtifact/readStepArtifact` 全部改为 `writeArtifact/readArtifact/listArtifacts/writeStepArtifact/readStepArtifact`，磁盘目录 `docs/` → `artifacts/`（新项目用新目录，读取时同时尝试旧目录做兼容），更新 5 个消费者的 import 和调用 |
| B3   | Override 系统简化                            | `src/core/overrides.ts`                                  | 移除 `readGlobalOverrides()` 调用，`getMergedOverrides` 只读项目级配置，工作流默认值通过参数传入统一合并。修正文件头注释 "three-layer" → "two-layer: project > workflow defaults"                                                                                                        |
| B4   | `workflows/dev/tools.ts` 创建                | `workflows/dev/tools.ts`                                 | 创建空的 action 注册文件，导出符合 plugin `tools.ts` 接口的函数。当前无实际 action 需要注册，但让 plugin 结构完整                                                                                                                                                                        |

### P3 — 清理与测试

| 编号 | 内容                                | 文件                                              | 方案                                                                                                                                                                               |
| ---- | ----------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1   | 删除 `src/hooks/` 下硬编码文件      | `src/hooks/claude-code.ts` 等                     | B1 完成后，将 hook 生成逻辑迁移到 `workflows/dev/hooks.ts`，然后删除 `src/hooks/` 下的 `claude-code.ts`、`opencode.ts`、`openclaw.ts`、`content.ts`，`install.ts` 保留为通用安装器 |
| C2   | `schema.ts` scale 兼容代码清理      | `src/core/schema.ts`                              | 删除 `isRequired()` 中 `Record<string, boolean>` 兼容分支，类型签名简化为 `boolean`（F18 随附）                                                                                    |
| C3   | 测试文件重命名                      | `tests/docs.test.ts` + `tests/doc-schema.test.ts` | 重命名为 `artifacts.test.ts` 和 `artifact-schema.test.ts`                                                                                                                          |
| C4   | 创建 `next-action.test.ts` 集成测试 | `tests/next-action.test.ts`                       | 按 028 §6.3 要求创建 5 个端到端场景测试                                                                                                                                            |
| C5   | `overrides.ts` 注释修正             | `src/core/overrides.ts`                           | 随 B3 一并完成                                                                                                                                                                     |
| C6   | `workflow.ts` 兼容层移除            | `src/core/workflow.ts`                            | 将 `schema.ts` 的 `resolveWorkflowDir` 依赖和 `engine-helpers.ts` 的 `loadWorkflow` 依赖迁移到 plugin.ts，然后删除 `workflow.ts`。`fileExists` 重复问题随之消除（P3-4）            |

### 遗漏项补充

| 编号 | 内容                                            | 文件                             | 方案                                                                                                               |
| ---- | ----------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| D1   | `buildArtifactRequirements` 未按 role/node 过滤 | `src/tools/dispatch-role.ts`     | 接受 nodeId 参数，从节点定义的 capabilities 中提取该角色关联的 artifact IDs，只加载和格式化这些 artifact 的 schema |
| D2   | escalate 浮动节点缺少 `beforeDispatch.inject`   | `workflows/dev/workflow.json`    | 为 escalate 节点添加 `beforeDispatch.inject`，内容指引 coordinator 说明是哪个 gate 的失败触发了 escalation         |
| D3   | Validator `detectCycles` 中 `adj` 邻接表死代码  | `src/core/workflow-validator.ts` | `adj` 构建后仅用于 `adj.size === 0` 快速返回，可简化为计数器或直接遍历 edges 过滤 `!hasExit`                       |
| D4   | `F16` schema.ts 依赖废弃模块                    | `src/core/schema.ts`             | 随 C6 一并完成，`resolveWorkflowDir` 迁移到 plugin 路径                                                            |

---

## 执行顺序

```
阶段 1: P1 修复
  ├── A1  cancelled 路径修复
  ├── A2  getInputArtifacts 实现
  └── 🧪 运行全量测试

阶段 2: P2 架构合规
  ├── B2  docs→artifacts 重命名（先做，因为 B1 的 hooks 代码中也引用 docs 函数）
  ├── B3  override 简化 + C5 注释修正
  ├── B4  tools.ts 创建
  ├── B1 + C1  hooks 外置 + 旧文件删除（最大变更，放最后）
  └── 🧪 运行全量测试

阶段 3: P3 清理 + 遗漏项
  ├── C2  schema.ts scale 兼容清理
  ├── C3  测试文件重命名
  ├── C6 + D4  workflow.ts 兼容层移除
  ├── D1  buildArtifactRequirements 按 role 过滤
  ├── D2  escalate inject 补充
  ├── D3  validator 死代码清理
  ├── C4  next-action 集成测试（最后写，确保所有修复就位）
  └── 🧪 运行全量测试
```

---

## 依赖关系

```
B2 (docs→artifacts) ─── 必须先于 ──→ B1 (hooks 外置，hooks 代码引用 docs 函数)
B1 (hooks 外置)    ─── 必须先于 ──→ C1 (删除旧 hooks 文件)
C6 (workflow.ts 移除) ── 隐含覆盖 ──→ D4 (schema.ts 依赖)
B3 (override 简化) ─── 隐含覆盖 ──→ C5 (注释修正)
其余项无强依赖，可并行或按顺序执行
```

---

## 风险评估

| 风险                                                        | 影响 | 缓解                                                               |
| ----------------------------------------------------------- | ---- | ------------------------------------------------------------------ |
| B2 磁盘目录 `docs/` → `artifacts/` 迁移可能影响已有项目数据 | 高   | 读取时先尝试 `artifacts/`，回退到 `docs/`；写入始终用 `artifacts/` |
| B1 hooks 外置涉及约 900 行代码迁移                          | 中   | 保持函数签名不变，只改导入路径和加载方式                           |
| C6 移除 workflow.ts 可能遗漏依赖                            | 低   | 先 grep 所有 import，逐个迁移后再删除                              |

---

> 总估算：约 15 小时。建议分 3 次会话完成，每次对应一个阶段。
