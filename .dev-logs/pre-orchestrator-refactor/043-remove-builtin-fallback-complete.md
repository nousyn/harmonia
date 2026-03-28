# 043 — Remove built-in workflow fallback（完成）

> 简化 workflow 查找逻辑：从「包内 workflows/ + 用户目录 .workflows/ 双层回退」
> 改为「仅查找用户目录 .workflows/」。setup 命令负责将内置 workflows 复制到用户目录。

---

## 变更概览

| 阶段    | 内容                                                       | 涉及文件数 |
| ------- | ---------------------------------------------------------- | ---------- |
| Phase 1 | 核心函数签名简化：`builtinDir, customDir` → `workflowsDir` | 3          |
| Phase 2 | 入口 + 12 个 tool 文件统一参数                             | 13         |
| Phase 3 | setup.ts 添加 workflow 复制逻辑                            | 1          |
| Phase 4 | 测试文件更新 + 全局扫描 + 编译/测试验证                    | 3          |

## 详细变更清单

### Phase 1 — 核心函数签名 (A1-A5)

| 编号 | 内容                                                                                             | 涉及文件           |
| ---- | ------------------------------------------------------------------------------------------------ | ------------------ |
| A1   | `resolveWorkflowDir(builtinDir, customDir, name)` → `resolveWorkflowDir(workflowsDir, name)`     | src/core/plugin.ts |
| A2   | `listWorkflows(builtinDir, customDir)` → `listWorkflows(workflowsDir)`                           | src/core/plugin.ts |
| A3   | `loadWorkflow(builtinDir, customDir, name)` → `loadWorkflow(workflowsDir, name)`                 | src/core/plugin.ts |
| A4   | 删除 `loadPluginByName()` (仅测试使用，无生产调用)                                               | src/core/plugin.ts |
| A5   | `loadArtifactSchema(builtinDir, customDir, wf, id)` → `loadArtifactSchema(workflowsDir, wf, id)` | src/core/schema.ts |

### Phase 2 — 入口 + Tool 文件 (B1-B12)

| 编号 | 内容                                                                                                 | 涉及文件                        |
| ---- | ---------------------------------------------------------------------------------------------------- | ------------------------------- |
| B1   | 删除 `BUILTIN_WORKFLOWS_DIR`，`CUSTOM_WORKFLOWS_DIR` → `WORKFLOWS_DIR`，10 处 register 调用 3→2 参数 | src/index.ts                    |
| B2   | `processWorkflowEvent` / `loadWorkflowForContext` 参数更新                                           | src/tools/engine-helpers.ts     |
| B3   | register 签名 + 3 处内部调用                                                                         | src/tools/project-init.ts       |
| B4   | register 签名 + 2 处内部调用                                                                         | src/tools/get-project-status.ts |
| B5   | register 签名 + 1 处内部调用                                                                         | src/tools/get-role-prompt.ts    |
| B6   | register 签名 + 1 处内部调用                                                                         | src/tools/iteration-start.ts    |
| B7   | register 签名 + 1 处内部调用                                                                         | src/tools/approve-artifact.ts   |
| B8   | register 签名 + 1 处内部调用                                                                         | src/tools/patch-start.ts        |
| B9   | register 签名 + ~12 处内部调用                                                                       | src/tools/artifact-tools.ts     |
| B10  | register 签名 + ~8 处内部调用                                                                        | src/tools/dispatch-role.ts      |
| B11  | register 签名 + 5 处内部调用                                                                         | src/tools/artifact-schema.ts    |
| B12  | register 签名 + 5 处内部调用                                                                         | src/tools/report-dispatch.ts    |

### Phase 3 — Setup workflow 复制 (C1)

| 编号 | 内容                                                                                                  | 涉及文件         |
| ---- | ----------------------------------------------------------------------------------------------------- | ---------------- |
| C1   | setup 命令新增步骤：将 `<package>/workflows/*` 复制到 `<data_dir>/harmonia/.workflows/`，已存在则跳过 | src/cli/setup.ts |

### Phase 4 — 测试 + 验证 (D1-D4)

| 编号 | 内容                                                                     | 涉及文件                  |
| ---- | ------------------------------------------------------------------------ | ------------------------- |
| D1   | 删除 `loadPluginByName` 导入 + 测试块 (37 行)                            | tests/plugin.test.ts      |
| D2   | `loadArtifactSchema` 调用 4→3 参数，删除 `NO_CUSTOM_DIR`                 | tests/schema.test.ts      |
| D3   | `patch-start.test.ts` 修复：删除 `NO_CUSTOM_DIR`，register 调用 3→2 参数 | tests/patch-start.test.ts |
| D4   | `tsc --noEmit` 零错误，`npm test` 20/331 全部通过                        | —                         |

## 验证结果

- **tsc --noEmit**: 零错误
- **npm test**: 20 test files, 331 tests passed
- **全局扫描**: src/ 和 tests/ 中无残留 `builtinDir` / `customDir` / `BUILTIN_WORKFLOWS_DIR` / `NO_CUSTOM_DIR` 引用

## 架构变化

```
Before:
  resolveWorkflowDir(builtinDir, customDir, name)
    → 先查 customDir/<name>/workflow.json
    → 再查 builtinDir/<name>/workflow.json（回退）

After:
  resolveWorkflowDir(workflowsDir, name)
    → 仅查 workflowsDir/<name>/workflow.json
  setup 命令负责在首次安装时将内置 workflows 复制到 workflowsDir
```

## 后续待做

- dispatch prompt 优化（Configuration 数据罗列 → 行动指引文本）
- role_prompt 工具输出格式同步调整
