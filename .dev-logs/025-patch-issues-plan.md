# 025 - Patch + Issues 实施计划

## 实施顺序

### 阶段 1：类型与核心

1. **types.ts** — PhaseStatus 加 `skipped`；新增 `ContextType`, `Issue` 类型；ProjectState 加 `type: ContextType`
2. **registry.ts** — ProjectEntry 加 `currentPatch`, `totalPatches`, `activeContext`（旧数据默认 0/0/""）；新增 `getPatchDir()`, `startPatch()`, `resolveActiveContext()`
3. **state.ts** — `initProjectState` 支持 patch 模式：接收可选 overrides 参数控制 type/skipped phases/预设 scale

### 阶段 2：Issues 模块

4. **core/issues.ts** — 新文件。readIssues/writeIssues/createIssue/updateIssue/listIssues，存放在 `getProjectDataDir(projectName)/issues.json`
5. **tools/issue-tools.ts** — 新文件。issue_create / issue_update / issue_list 三个 MCP 工具

### 阶段 3：Patch 工具

6. **tools/patch-start.ts** — 新文件。类似 iteration-start，创建 patch-N/ 目录，state 中 clarify/design=skipped, scale=small, type=patch

### 阶段 4：现有工具适配

7. **update-phase.ts** — Guard 1 把 `skipped` 当 `completed`
8. **iteration-start.ts** — 设置 activeContext="iter-N", state 写入 type="iteration"
9. **所有 tool** — `entry.currentIteration` → `resolveActiveContext(entry)` 获取 iteration + type
10. **get-project-status.ts** — 显示 patch 列表、open issues 数量、activeContext；deriveNextSteps 推荐 patch_start
11. **doc-tools.ts** — doc_read/doc_list 加可选 `context` 参数支持跨上下文读取

### 阶段 5：入口与 Prompt

12. **index.ts** — 注册 patch_start + issue 工具
13. **templates.ts** — PM prompt 新增 Patch Workflow + Issue Management 章节

### 阶段 6：测试

14. 新增 issues 测试
15. 新增 patch-start 测试
16. 适配现有测试（ProjectEntry/ProjectState 加 type + activeContext 字段）
17. 全量 tsc + vitest 通过
