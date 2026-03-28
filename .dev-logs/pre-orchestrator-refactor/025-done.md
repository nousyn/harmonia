# 025-done: Patch + Issues 系统完成

## 概述

实现了轻量级补丁（Patch）工作流和问题跟踪（Issue）系统，使 Harmonia 能够处理在测试或用户反馈中发现的 bug 修复和小改进。

## 完成内容

### 核心层新增

1. **registry.ts** — `ProjectEntry` 新增 `currentPatch`/`totalPatches`/`activeContext` 字段；新增 `startPatch()`、`resolveContextDir()` 函数
2. **types.ts** — 新增 `ContextType`、`IssueStatus`、`IssueSource`、`Issue` 等类型定义
3. **issues.ts** — 新文件，Issue CRUD（create/list/update）

### 工具层新增/修改

4. **patch-start.ts** — 新文件，`patch_start` 工具实现
5. **issue-tools.ts** — 新文件，`issue_create`/`issue_list`/`issue_update` 工具
6. **utils.ts** — `resolveActive()` 辅助函数，统一解析活跃上下文
7. **所有工具** — 统一使用 `resolveActive()` 替代直接读取 `currentIteration`

### PM Prompt + CLI

8. **templates.ts** — 新增 Patch Workflow、Issue Management、Cross-Context Document Access 章节
9. **index.ts** — 注册 `patch_start`、`issue_create`/`issue_list`/`issue_update` 工具

### 测试

10. **patch-start.test.ts** — Patch 工作流测试
11. **issues.test.ts** — Issue CRUD 测试

## 验证结果

- `npx tsc --noEmit` — 零错误
- `npx vitest run` — 288 测试全部通过
- Commit: `de1fc6c`，已合并到 `main`
