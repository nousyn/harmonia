# 020 — Scale 延迟设定 & PM Prompt 去项目化 & Setup 简化

> 状态: 计划  
> 日期: 2026-03-16  
> 分支: develop

## 背景

实际使用中发现 Harmonia 的初始设计存在几个架构问题：

1. **Scale 过早确定** — `project_init` 要求指定 scale，但此时 PM 还不了解需求，无法准确评估
2. **PM Prompt 硬编码项目信息** — projectName、projectDir、scale 写死在 prompt 中，多项目场景下会产生冲突
3. **Setup 职责过重** — `harmonia setup` 同时做环境准备和项目注册，但项目注册应该由 agent 在交互中完成
4. **project_status 强制要求项目名** — 没有"列出所有项目"的能力

## 设计决策（已确认）

### D1: Scale 是工作流产物，不是输入参数

- Scale 应由 PM 在 PRD 审批通过后评估确定
- 一旦设定不可更改（immutable）— 需要改 scale 意味着需要重做 PRD
- 新增 `project_set_scale` 工具，PM-only，前置条件: PRD approved

### D2: PM Prompt 只保留工作流规则

- 移除 projectName、projectDir、scale 等项目特定信息
- 保留角色定义 + 工作流规则 + dispatch 流程等静态常量
- PM 通过 `project_status` 在运行时获取项目信息
- 工作流规则保留在 prompt 中（每次决策都需要参考，移除会翻倍交互轮次）

### D3: Setup 只做环境准备

- `harmonia setup` 只做: prompt 注入 + hook 安装
- 移除 `--name`、`--workflow` 参数，仅保留 `--agent`
- 不再调用 `registerProject` / `initProjectState`
- 项目注册由 agent 通过 `project_init` 完成

### D4: project_status 渐进式查询

- `project_name` 参数从必选变可选
- 不传: 返回所有项目的摘要列表
- 传入: 返回指定项目的详细状态

## 变更清单

### 1. 类型变更 — `src/core/types.ts`

```diff
 interface ProjectState {
-    scale: ProjectScale;
+    scale: ProjectScale | null;
 }
```

影响范围：所有读取 `state.scale` 的代码需要处理 `null` 情况。

### 2. State 初始化 — `src/core/state.ts`

```diff
 export async function initProjectState(
     projectName: string,
     projectDir: string,
     workflow: LoadedWorkflow,
-    scale: ProjectScale = 'small',
 ): Promise<ProjectState> {
     // ...
     const state: ProjectState = {
-        scale,
+        scale: null,
         // ...
     };
 }
```

新增函数：

```ts
export async function setScale(projectName: string, scale: ProjectScale): Promise<ProjectState> {
  const state = await readState(projectName);
  if (state.scale !== null) {
    throw new Error(`Scale already set to "${state.scale}". Scale is immutable once set.`);
  }
  state.scale = scale;
  await writeState(projectName, state);
  return state;
}
```

### 3. project_init 工具 — `src/tools/project-init.ts`

**变更：**

- 移除 `scale` 参数
- 移除 `workflow` 参数（默认 `dev`，后续多 workflow 时再加）
- 增加 `project_name` 强验证：非空、只允许 `[a-z0-9-]`
- 增加 `project_dir` 强验证：必须是绝对路径
- 移入 `registerProject` + `initProjectState` 逻辑（从 setup 移过来）
- 返回内容中不再列出 scale 相关文档信息（scale 尚未设定）

```ts
// 参数定义
{
    project_name: z.string()
        .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'project_name 只允许小写字母、数字和短横线，不能以短横线开头或结尾')
        .min(2, 'project_name 至少 2 个字符')
        .max(64, 'project_name 最多 64 个字符')
        .describe('唯一的项目名称（用作数据目录名，只允许小写字母、数字和短横线）'),
    project_dir: z.string()
        .startsWith('/', 'project_dir 必须是绝对路径')
        .describe('项目源代码目录的绝对路径（如不存在会自动创建）'),
}
```

**返回内容：** 项目基本信息 + 提示 PM 下一步应获取需求后设定 scale。

### 4. 新增 project_set_scale 工具 — `src/tools/set-scale.ts`（新文件）

```ts
// 参数
{
    project_name: z.string().describe('项目名称'),
    scale: z.enum(['small', 'medium', 'large']).describe('项目规模'),
}

// 前置条件
// 1. 项目已初始化
// 2. PRD 已审批通过（review status === 'approved'）
// 3. scale 尚未设定（state.scale === null）

// 返回
// 成功：scale 已设定 + 列出 required/optional 文档
// 失败：明确的错误信息和指引
```

工具描述（关键）:

```
"Set the project scale after PRD approval. Scale determines which documents are required (full/lite/skip) and enables sequential mode for medium/large projects. Scale is immutable once set — if requirements change significantly, redo the PRD."
```

### 5. Setup 简化 — `src/cli/setup.ts`

**移除：**

- `--name` 参数及解析逻辑
- `--workflow` 参数及解析逻辑
- `loadWorkflow()` 调用
- `registerProject()` / `initProjectState()` 调用
- `readState()` 调用

**保留：**

- `--agent` 参数
- `detectHostAgent()` 自动检测
- `injectPrompt()` 调用（但参数改变，见下）
- `installHooks()` 调用（但参数改变，见下）

**变更后 `parseSetupArgs`：**

```ts
interface SetupOptions {
  agent?: AgentType;
}
// 只接受 --agent 参数
```

**变更后 `runSetup`：**

```ts
export async function runSetup(opts: SetupOptions): Promise<void> {
  const projectDir = resolve(process.cwd());

  // 1. Detect agent
  const agentType = opts.agent ?? (await detectHostAgent(projectDir));

  // 2. Inject prompt (无项目信息)
  await injectPrompt(projectDir, agentType);

  // 3. Install hooks (无项目特定信息)
  // 注意: hook 需要重构 — 目前 hookParams 需要 projectName 和 projectDir
  // 但 setup 阶段没有项目信息了
  // 方案: hook 安装时写入通用脚本，运行时从环境或 state 获取项目信息
  // → 这是一个值得单独讨论的问题，见"Hook 重构"章节
}
```

### 6. PM Prompt 去项目化 — `src/setup/templates.ts`

**变更：**

```diff
-export interface PromptTemplateParams {
-    projectName: string;
-    projectDir: string;
-    workflow: string;
-    scale: string;
-}
-
-export function generatePmPrompt(params: PromptTemplateParams): string {
+export function generatePmPrompt(): string {
```

移除 prompt 中的：

```diff
-You are the **PM (Project Manager)** for project **${params.projectName}**.
+You are the **PM (Project Manager)** for a Harmonia-managed project.
-
-- **Project directory**: ${params.projectDir}
-- **Workflow**: ${params.workflow}
-- **Scale**: ${params.scale}
```

新增 prompt 中的"首次启动"指引：

```markdown
### Getting Started

1. **Check for existing projects**: Call `project_status` (no params) to list registered projects
2. **If resuming**: Call `project_status(project_name)` to see current state and next steps
3. **If new project**: Talk to user, then call `project_init(project_name, project_dir)` to register
4. **After PRD approved**: Call `project_set_scale(project_name, scale)` to set project scale
```

保留不变：

- 工作流各阶段指引 (Phase 1-5)
- Dispatch 流程
- Agent 启动方式
- Session 恢复流程
- 文档审核流程
- 重要规则

**注意**：Workflow Guide 中提到 scale 的地方需要调整措辞：

- Phase 1 第4步 "If the project is medium/large" → 保留，PM 通过 project_status 知道 scale
- 第159行 "Scale appropriately" → 改为 "Always check scale with project_status before deciding which documents to produce"

### 7. project_status 渐进式查询 — `src/tools/get-project-status.ts`

**参数变更：**

```diff
 {
-    project_name: z.string().describe('Project name'),
+    project_name: z.string().optional().describe('项目名称。不传则返回所有项目的摘要列表。'),
 }
```

**新增列表模式（不传 project_name）：**

```ts
// 调用 listProjects() 获取所有项目
// 对每个项目读取 state.json
// 返回摘要:
// # Harmonia Projects
//
// | 项目 | 目录 | 阶段 | Scale | 更新时间 |
// |------|------|------|-------|----------|
// | my-app | /path/to/app | design | medium | 2026-03-16 |
// | api-v2 | /path/to/api | clarify | (未设定) | 2026-03-15 |
//
// 使用 project_status(project_name) 查看项目详情。
```

**详情模式变更：**

- `Scale: ${state.scale}` → 当 scale 为 null 时显示 `Scale: (未设定) — 请在 PRD 审批后调用 project_set_scale`
- `deriveNextSteps` 函数需要处理 scale === null 的情况

### 8. Scale-null Guard — 需要 scale 的工具拦截

以下工具/函数在 `scale === null` 时应该报错并引导：

| 位置                               | 使用 scale 的方式                                                                      | Guard 策略                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `doc_write` (doc-tools.ts)         | `isSequentialActive(docDef, scale)` + schema validation `validateDoc(..., scale, ...)` | 在入口检查 scale !== null，否则返回 "请先设定 scale" |
| `phase_update` (update-phase.ts)   | `docDef.scale[state.scale]` 用于判断文档是否必需                                       | 同上                                                 |
| `role_dispatch` (dispatch-role.ts) | `resolveExpectedOutputs(...)` 使用 scale                                               | 同上                                                 |
| `project_status` 详情模式          | `state.scale` 用于 step progress 显示                                                  | 允许 scale=null，显示 "(未设定)" 即可，不 block      |
| `project_init` 返回内容            | 当前列出 scale 相关文档                                                                | 移除这部分，scale 尚未设定                           |

**Guard 实现方式 — 提取公共函数：**

```ts
// src/core/state.ts 或 src/tools/helpers.ts
function requireScale(state: ProjectState): asserts state is ProjectState & { scale: ProjectScale } {
  if (state.scale === null) {
    throw new ScaleNotSetError(state.projectName);
  }
}

class ScaleNotSetError extends Error {
  constructor(projectName: string) {
    super(`项目 "${projectName}" 尚未设定 scale。请先完成 PRD 审批，然后调用 project_set_scale 设定项目规模。`);
    this.name = 'ScaleNotSetError';
  }
}
```

### 9. inject.ts 变更 — `src/setup/inject.ts`

`injectPrompt` 函数签名变更：

```diff
-export async function injectPrompt(
-    projectDir: string,
-    agentType: AgentType,
-    params: PromptTemplateParams,
-): Promise<InjectResult> {
+export async function injectPrompt(
+    projectDir: string,
+    agentType: AgentType,
+): Promise<InjectResult> {
```

内部调用改为 `generatePmPrompt()`（无参数）。

### 10. Hook 重构问题

**问题**: 当前 hook 安装时需要 `HookParams`（dataDir, projectName, projectDir），这些信息在安装时被 bake 到脚本中。但 setup 简化后，安装时没有项目信息了。

**方案 A — 运行时查找项目（推荐）**:

- Hook 脚本只 bake `HARMONIA_DATA_DIR`
- 运行时根据当前工作目录从 `registry.json` 反查 projectName
- 优势: 天然支持多项目
- 劣势: 需要额外的 registry 查询逻辑（在 bash 脚本中实现 JSON 读取稍复杂）

**方案 B — Hook 只检查 Harmonia 工具调用**:

- Hook 的核心价值是阻止 PM 直接写代码
- 这个规则不依赖项目信息，只需要检查 tool name + file path
- `HARMONIA_DATA_DIR` 仍需 bake 用于读取 dispatch 状态
- 项目信息可以从 tool 调用的参数中提取（MCP tool 参数里有 project_name）

**方案 C — 保持现状，setup 后重新安装**:

- `harmonia setup` 安装通用 hook（不含项目信息）
- `project_init` 成功后自动更新 hook（bake 项目信息）
- 劣势: 需要在 MCP server 端调用 hook install，增加复杂度

**当前选择**: 方案 B — hook 的核心规则（阻止 PM 写代码）不依赖项目名和项目目录。dispatch 超时检查等需要读取状态的功能，可以通过 `HARMONIA_DATA_DIR` + 扫描活跃项目实现。

### 11. HARMONIA_TOOLS 更新 — `src/hooks/content.ts`

```diff
 export const HARMONIA_TOOLS = [
     'project_init',
     'project_status',
+    'project_set_scale',
     'phase_update',
     // ... rest unchanged
 ] as const;
```

### 12. README 更新

需要更新的章节：

- Quick Start — setup 命令参数变更
- Tool Reference — 新增 `project_set_scale`，更新 `project_init` 和 `project_status`
- 工作流说明 — scale 设定流程变更

### 13. 测试影响

| 测试文件                   | 影响                                              | 工作量 |
| -------------------------- | ------------------------------------------------- | ------ |
| `cli.test.ts`              | setup 参数变更，移除项目注册逻辑                  | 中     |
| `setup.test.ts`            | prompt 模板参数变更                               | 小     |
| `state.test.ts`            | `initProjectState` 签名变更，新增 `setScale` 测试 | 中     |
| `docs.test.ts`             | scale=null guard 测试                             | 小     |
| `guards.test.ts`           | 可能需要 scale=null 场景                          | 小     |
| `schema.test.ts`           | scale=null 时不应调用 validation                  | 无     |
| 新文件 `set-scale.test.ts` | `project_set_scale` 全流程测试                    | 中     |

## 实现顺序

按依赖关系排序：

### Phase 1 — 基础类型与状态层

1. `types.ts` — `ProjectState.scale` 改为 `ProjectScale | null`
2. `state.ts` — `initProjectState` 移除 scale 参数，新增 `setScale` 函数，新增 `ScaleNotSetError`
3. 对应测试更新

### Phase 2 — 核心工具变更

4. `project-init.ts` — 移除 scale/workflow 参数，增加强验证
5. `set-scale.ts` — 新文件，`project_set_scale` 工具
6. `get-project-status.ts` — project_name 可选，列表模式，scale=null 显示
7. 对应测试

### Phase 3 — Scale-null Guard

8. `doc-tools.ts` — 入口 scale-null 检查
9. `update-phase.ts` — 入口 scale-null 检查
10. `dispatch-role.ts` — 入口 scale-null 检查
11. 对应测试

### Phase 4 — Prompt & Setup

12. `templates.ts` — 去项目化，生成无参数 prompt
13. `inject.ts` — 移除 params 参数
14. `setup.ts` — 简化，移除项目注册逻辑
15. `index.ts` — 更新 --help 文本
16. `content.ts` — HARMONIA_TOOLS 增加 `project_set_scale`
17. 对应测试

### Phase 5 — Hook 适配

18. Hook 脚本生成 — 移除项目特定信息依赖
19. `install.ts` — HookParams 简化

### Phase 6 — 收尾

20. `server.ts` — 注册新工具 `project_set_scale`
21. README 更新
22. 全量测试通过

## 风险与注意事项

1. **TypeScript 严格模式**：`scale: ProjectScale | null` 会让所有 `docDef.scale[state.scale]` 类型报错（null 不能做 index）。需要在每个使用点先经过 `requireScale()` 或显式检查。

2. **Hook 脚本向后兼容**：已安装 hook 的用户需要重新运行 `harmonia setup` 更新 hook。应在 README 中说明。

3. **project_init 幂等性**：当前 `project_init` 已存在项目时返回现有状态。参数变更后需要保持这个行为。

4. **PRD 文档写入**：scale=null 时，`doc_write("prd", ...)` 是否应该允许？
   - 是，PRD 写入不依赖 scale（small scale 下 PRD 也可以用 normal mode 写）
   - 但 sequential mode 依赖 scale — scale=null 时 sequential 自动不激活，等效于 small scale 行为
   - **决定**：scale=null 时 `doc_write` 允许，但 sequential 不激活（按 small 处理）。schema validation 跳过 scale-dependent 的 section 检查。
     → 这意味着 `doc_write` 的 scale-null guard 只在以下情况触发：
     - `phase_update` 完成时需要检查 required docs（依赖 scale）
     - `role_dispatch` 计算 expected outputs（依赖 scale）
       → `doc_write` 本身**不需要** scale-null guard，只需要处理 `scale === null` 的 fallback 逻辑

5. **deriveNextSteps 逻辑**：scale=null 时无法判断哪些文档是 required。建议在 "Next Steps" 中提示 "设定 scale 后才能确定必需文档"。

## 风险修正：doc_write scale 处理

重新审视 `doc_write` 的 scale 依赖：

| 代码位置                                      | scale 用途                                | scale=null 行为                                      |
| --------------------------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| `isSequentialActive(docDef, scale)`           | 判断是否启用分步模式                      | null → 不激活 → normal 模式                          |
| `validateDoc(content, schema, scale, isHtml)` | schema 的 required sections 按 scale 判断 | null → 跳过 scale-dependent sections，只校验基础结构 |

**结论**：`doc_write` 不需要硬 block，但 `validateDoc` 需要处理 `scale === null`。在 schema.ts 中，当 scale 为 null 时，将所有 `required[scale]` 视为 `false`（即不强制任何 scale-specific 的 section）。

## MCP Server 注册 — `src/server.ts`

```diff
+import { registerSetScale } from './tools/set-scale.js';

 // in createServer():
+registerSetScale(server, workflowsDir);
```
