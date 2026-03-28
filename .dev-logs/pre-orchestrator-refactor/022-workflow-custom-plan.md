# 022 — 自定义工作流优化

> 状态: 计划  
> 日期: 2026-03-16  
> 分支: develop

## 背景

当前工作流系统存在几个问题：

1. **workflow 名称硬编码** — `project_init` 固定使用 `'dev'`，无法选择其他工作流
2. **自定义工作流无标准位置** — 依赖 `HARMONIA_WORKFLOWS_DIR` 环境变量，不直观
3. **缺少工作流发现机制** — agent 无法知道有哪些可用工作流
4. **workflow.json 缺少元信息** — 没有 version/author 等字段

## 设计决策

### D1: 两层工作流查找，不复制

```
加载优先级:
1. <data_dir>/.workflows/<name>/    ← 用户自定义（可覆盖同名内置）
2. <package>/workflows/<name>/       ← 内置（fallback）
```

- 内置 `dev` 工作流始终跟着包版本更新，零维护
- 用户在 `.workflows/dev/` 放自己的版本可覆盖内置
- 用户在 `.workflows/research/` 创建新工作流可扩展
- `.workflows` 使用 dot-prefix 避免与项目名冲突

### D2: 砍掉 HARMONIA_WORKFLOWS_DIR 环境变量

两层查找机制已覆盖所有场景，环境变量不再需要。

### D3: project_init 加回可选 workflow 参数

- `workflow` 参数可选
- 单个工作流 → 自动选中
- 多个工作流 → 返回错误 + 可用列表，要求 agent 重新调用并指定
- init 成功后返回：工作流名称 + 描述 + 阶段概览

### D4: 扩展 workflow.json 加元信息

不新增 manifest.json，在现有 workflow.json 中增加可选字段：

```json
{
  "name": "dev",
  "description": "软件开发流程",
  "version": "1.0.0",
  "author": "harmonia",
  ...
}
```

### D5: loadWorkflow 友好错误提示

不加中间件。在 `loadWorkflow` 中捕获文件读取异常，抛出包含工作流名称的友好错误。

## 变更清单

### Phase 1: workflow.ts — 两层查找 + 友好错误

**`src/core/workflow.ts`**

1. 新增 `resolveWorkflowDir(builtinDir, customDir, name)` 函数
   - 先检查 `customDir/<name>/workflow.json` 是否存在
   - 再检查 `builtinDir/<name>/workflow.json`
   - 都不存在抛 `WorkflowNotFoundError`（自定义错误类，含工作流名称）
2. 修改 `loadWorkflow` 签名：`loadWorkflow(builtinDir: string, customDir: string, name: string)`
   - 内部调用 `resolveWorkflowDir` 确定实际目录
   - 用 try/catch 包装 readFile，抛友好错误
3. 修改 `listWorkflows` 签名：`listWorkflows(builtinDir: string, customDir: string)`
   - 合并两个目录下的工作流名称（去重，自定义优先）
   - 排序返回
4. 新增类型：`WorkflowNotFoundError`

**`src/core/types.ts`**

5. `WorkflowDefinition` 增加可选字段：
   ```ts
   version?: string;
   author?: string;
   ```

### Phase 2: index.ts — 双目录传递

**`src/index.ts`**

1. 移除 `HARMONIA_WORKFLOWS_DIR` 环境变量
2. 计算两个目录：
   ```ts
   const BUILTIN_WORKFLOWS_DIR = resolve(join(__dirname, '..', 'workflows'));
   const CUSTOM_WORKFLOWS_DIR = join(getGlobalDir(), '.workflows');
   ```
3. 所有 `registerXxx(server, workflowsDir)` 改为 `registerXxx(server, builtinDir, customDir)`

### Phase 3: 所有工具函数签名适配

需要适配签名的工具文件（`workflowsDir` → `builtinDir, customDir`）：

- `src/tools/project-init.ts`
- `src/tools/set-scale.ts`
- `src/tools/get-role-prompt.ts`
- `src/tools/update-phase.ts`
- `src/tools/doc-tools.ts`
- `src/tools/get-project-status.ts`
- `src/tools/dispatch-role.ts`
- `src/tools/report-dispatch.ts`

每个文件中：

- register 函数签名：`(server, builtinDir: string, customDir: string)`
- `loadWorkflow(workflowsDir, name)` → `loadWorkflow(builtinDir, customDir, name)`
- `listWorkflows(workflowsDir)` → `listWorkflows(builtinDir, customDir)` （如有）

### Phase 4: project-init.ts — workflow 参数 + 自动选择

**`src/tools/project-init.ts`**

1. 添加可选参数 `workflow: z.string().optional()`
2. 逻辑：
   ```
   available = listWorkflows(builtinDir, customDir)
   if workflow 参数指定:
     验证 workflow 在 available 中
   else if available.length === 1:
     自动选中唯一的工作流
   else:
     返回错误 + 可用工作流列表（含名称和描述）
   ```
3. init 成功后返回增加工作流信息

### Phase 5: workflow.json 元信息 + schema.ts 适配

**`workflows/dev/workflow.json`**

1. 添加 `"version": "1.0.0"` 和 `"author": "harmonia"`

**`src/core/schema.ts`**

2. `loadDocSchema` 签名适配：`(builtinDir, customDir, workflowName, docId)` → 使用 `resolveWorkflowDir` 查找 schema 目录

### Phase 6: 测试更新

- `tests/workflow.test.ts` — 测试两层查找、friendly error、listWorkflows 合并
- 其他涉及 `loadWorkflow` 的测试文件 — 适配新签名

### Phase 7: README 更新

- 移除 `HARMONIA_WORKFLOWS_DIR` 环境变量说明
- 重写"自定义工作流"章节：说明 `.workflows` 目录位置 + 目录结构 + 创建方式

## 影响评估

| 文件                          | 变更类型     | 说明                                  |
| ----------------------------- | ------------ | ------------------------------------- |
| `src/core/workflow.ts`        | **核心改动** | 两层查找 + 友好错误                   |
| `src/core/types.ts`           | 小改         | WorkflowDefinition 加 version/author  |
| `src/core/schema.ts`          | 签名改动     | loadDocSchema 适配双目录              |
| `src/index.ts`                | 改动         | 移除环境变量，双目录计算              |
| `src/tools/*.ts` (8个)        | 签名改动     | workflowsDir → builtinDir + customDir |
| `workflows/dev/workflow.json` | 小改         | 加 version/author                     |
| `tests/workflow.test.ts`      | 测试新增     | 两层查找测试                          |
| `tests/*.test.ts` (若干)      | 签名适配     | 跟随工具签名变化                      |
| `README.md`                   | 文档         | 自定义工作流说明                      |

## 实施顺序

Phase 1 → 2 → 3 → 4 → 5 → 6 → 7

Phase 1-3 是签名级联变更，一起做可减少中间编译错误。Phase 4 是功能新增。Phase 5-7 收尾。
