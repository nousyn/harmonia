# 023 — 自定义工作流优化完成

> 状态: 完成
> 日期: 2026-03-17
> 分支: develop

## 概述

实现了 Plan 022 的所有 7 个 Phase：两层工作流查找、环境变量移除、签名级联更新、project_init workflow 参数、workflow.json 元数据、测试更新、README 更新。

## 变更汇总

### Phase 1: workflow.ts — 两层查找 + 友好错误

- 新增 `resolveWorkflowDir(builtinDir, customDir, name)` — 先查自定义目录，再查内置目录
- 新增 `WorkflowNotFoundError` — 自定义错误类，包含搜索路径列表
- `loadWorkflow` 签名改为 `(builtinDir, customDir, name)`
- `listWorkflows` 签名改为 `(builtinDir, customDir)` — 合并两目录，去重排序
- `WorkflowDefinition` 新增 `version?: string` 和 `author?: string`

### Phase 2: index.ts — 双目录传递

- 移除 `HARMONIA_WORKFLOWS_DIR` 环境变量
- 计算 `BUILTIN_WORKFLOWS_DIR`（包内 `workflows/`）和 `CUSTOM_WORKFLOWS_DIR`（`<data_dir>/.workflows`）
- 所有 `registerXxx()` 调用改为传递两个目录

### Phase 3: 8 个工具文件签名适配

- `set-scale.ts`, `get-role-prompt.ts`, `update-phase.ts`, `doc-tools.ts`, `get-project-status.ts`, `dispatch-role.ts`, `report-dispatch.ts`, `schema.ts`
- 函数签名: `(server, workflowsDir)` → `(server, builtinDir, customDir)`
- `loadWorkflow(workflowsDir, name)` → `loadWorkflow(builtinDir, customDir, name)`
- `loadDocSchema(workflowsDir, wfName, docId)` → `loadDocSchema(builtinDir, customDir, wfName, docId)`

### Phase 4: project-init.ts — workflow 参数 + 自动选择

- 新增可选参数 `workflow: z.string().optional()`
- 自动选择逻辑：单工作流自动选中，多工作流返回错误 + 可用列表（含描述）
- 验证指定工作流是否存在

### Phase 5: workflow.json 元数据

- `workflows/dev/workflow.json` 新增 `"version": "1.0.0"` 和 `"author": "harmonia"`

### Phase 6: 测试更新

- `workflow.test.ts` — 适配新签名 + 新增 version/author 元数据测试
- `state.test.ts` — 适配新 `loadWorkflow` 签名
- `schema.test.ts` — 适配新 `loadDocSchema` 4 参数签名 + 创建 workflow.json fixture
- `sequential.test.ts` — 适配新 `registerDocTools` 签名

### Phase 7: README 更新

- 移除 `HARMONIA_WORKFLOWS_DIR` 环境变量说明
- 重写"自定义工作流"章节：两层查找机制、创建方式、workflow.json 格式、project_init 工作流选择
- 全局目录结构图新增 `.workflows/` 目录
- 更新测试数量为 261

## 测试结果

```
Test Files  13 passed (13)
     Tests  261 passed (261)
```

## 设计决策回顾

| 决策          | 选择                        | 理由                                      |
| ------------- | --------------------------- | ----------------------------------------- |
| 工作流查找    | 两层（自定义 > 内置）       | 内置跟包更新，自定义可覆盖/扩展           |
| 环境变量      | 移除 HARMONIA_WORKFLOWS_DIR | 两层查找已覆盖所有场景                    |
| 元信息        | 扩展 workflow.json          | 不新增 manifest.json，减少复杂度          |
| workflow 选择 | 可选参数 + 自动/列表        | MCP 工具无交互，返回列表让 agent 重新调用 |
| 目录命名      | `.workflows`（dot-prefix）  | 避免与项目名冲突                          |
