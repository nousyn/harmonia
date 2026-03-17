# 024-done: 迭代层实施完成

## 概述

完成了 Harmonia 迭代层（Iteration Layer）的全部实施工作。这是一个破坏性变更，引入了多迭代概念，使现有项目可以通过 Harmonia 进行迭代开发。

## 完成内容

### 核心层变更（8个模块）

1. **types.ts** — `ProjectState` 新增 `iteration: number` 字段
2. **registry.ts** — `ProjectEntry` 新增 `currentIteration`/`totalIterations`；新增 `getIterationDir()` 和 `startIteration()` 函数；`registerProject()` 不再创建 docs/ 目录
3. **state.ts** — 所有函数签名新增 `iteration: number` 参数
4. **docs.ts** — 所有函数签名新增 `iteration: number` 参数
5. **reviews.ts** — 所有函数签名新增 `iteration: number` 参数
6. **dispatch.ts** — 所有函数签名新增 `iteration: number` 参数
7. **steps.ts** — 所有函数签名新增 `iteration: number` 参数
8. **overrides.ts** — 无变更（项目级，跨迭代共享）

### 工具层变更（12个工具）

- **project-init.ts** — 简化为仅注册功能
- **iteration-start.ts** — 新文件，处理 `iteration_start` 工具
- **set-scale.ts** — 迭代解析
- **update-phase.ts** — 迭代解析
- **approve-doc.ts** — 迭代解析
- **doc-tools.ts** — `doc_write`/`doc_read`/`doc_list` 迭代解析 + `handleSequentialWrite` + `handleFinalStep`
- **dispatch-role.ts** — 迭代解析
- **report-dispatch.ts** — 迭代解析 + `resolveOrCreateSession` 更新
- **get-project-status.ts** — 迭代解析 + 迭代信息展示 + `deriveNextSteps` 推荐 `iteration_start`
- **get-role-prompt.ts** — 无变更
- **override-tools.ts** — 无变更

### 集成 & CLI

- **index.ts** — 注册 `iteration_start` 工具导入+调用，添加 `unregister` CLI 子命令
- **setup/templates.ts** — PM 提示词更新，区分 `project_init` vs `iteration_start`

### 测试更新（6个文件）

- **state.test.ts** — `iteration` 参数 + `iter-1/` 目录结构
- **docs.test.ts** — `iteration` 参数 + `iter-1/docs/` 目录结构
- **reviews.test.ts** — `iteration` 参数 + `iter-1/` 目录结构
- **dispatch.test.ts** — `iteration` 参数 + `iter-1/` 目录结构（含两个项目）
- **steps.test.ts** — `iteration` 参数 + mock `getIterationDir` 替代 `getProjectDataDir`
- **sequential.test.ts** — `iteration` 参数 + mock `getProject`/`getIterationDir`/`getProjectDataDir`/`getGlobalDir` + state.json/docs 路径移到 `iter-1/` 下

### 未变更的测试（7个文件）

- guards.test.ts, schema.test.ts, workflow.test.ts, overrides.test.ts, setup.test.ts, cli.test.ts, hooks.test.ts — 这些测试不涉及迭代层相关函数，无需修改。

## 数据目录结构

```
<data_dir>/
├── registry.json
├── overrides.json
├── .workflows/
├── my-app/
│   ├── overrides.json          (项目级，跨迭代共享)
│   ├── iter-1/
│   │   ├── state.json
│   │   ├── sessions.json
│   │   ├── dispatches.json
│   │   ├── reviews.json
│   │   ├── steps.json
│   │   └── docs/
│   ├── iter-2/
│   │   └── ...
```

## 验证结果

- `npx tsc --noEmit` — 零错误
- `npx vitest run` — 13 文件 / 262 测试全部通过

## 关键设计决策

1. `project_init` 仅注册，`iteration_start` 创建迭代
2. `currentIteration: 0` 表示未开始迭代，工具层统一检查并引导
3. `iteration` 作为所有核心函数的第二个参数（`initProjectState` 除外，为第四个）
4. overrides 保持在项目级（跨迭代共享）
5. `getIterationDir()` 为纯路径拼接，不检查目录是否存在
