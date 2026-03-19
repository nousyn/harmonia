# 043 — 移除内置工作流回退

## 目标

移除工作流查找中的内置目录（`<package>/workflows/`）回退逻辑，统一从 `<data_dir>/harmonia/.workflows/` 查找工作流。在 setup 流程中添加内置工作流的自动复制。

## 背景

当前 `resolveWorkflowDir(builtinDir, customDir, name)` 有两层查找：先查 customDir，再回退到 builtinDir。这导致：

- 两个目录的合并查找逻辑增加了复杂度
- 所有 13+ 个 tools 文件都需要传递 `builtinDir` 参数
- 内置工作流"隐式可用"不符合统一管理的设计意图

目标状态：只从 `.workflows/` 查找，setup 时将内置工作流复制过去。

## 变更清单

### 阶段 1：核心函数签名简化

| 编号 | 文件                 | 操作 | 说明                                                                                                                      |
| ---- | -------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------- |
| A1   | `src/core/plugin.ts` | 改   | `resolveWorkflowDir(builtinDir, customDir, name)` → `resolveWorkflowDir(workflowsDir, name)` — 移除两层查找，只查一个目录 |
| A2   | `src/core/plugin.ts` | 改   | `listWorkflows(builtinDir, customDir)` → `listWorkflows(workflowsDir)` — 只扫描一个目录                                   |
| A3   | `src/core/plugin.ts` | 改   | `loadWorkflow(builtinDir, customDir, name)` → `loadWorkflow(workflowsDir, name)` — 传递简化                               |
| A4   | `src/core/plugin.ts` | 删   | `loadPluginByName()` — 仅测试调用的旧 API，一并移除                                                                       |
| A5   | `src/core/schema.ts` | 改   | `loadArtifactSchema(builtinDir, customDir, ...)` → `loadArtifactSchema(workflowsDir, ...)`                                |

### 阶段 2：入口与 tools 文件参数传递更新

| 编号 | 文件                              | 操作 | 说明                                                                                                              |
| ---- | --------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------- |
| B1   | `src/index.ts`                    | 改   | 删除 `BUILTIN_WORKFLOWS_DIR`，所有 `register*(server, builtinDir, customDir)` → `register*(server, workflowsDir)` |
| B2   | `src/tools/project-init.ts`       | 改   | 函数签名和内部调用移除 `builtinDir`                                                                               |
| B3   | `src/tools/get-project-status.ts` | 改   | 同上                                                                                                              |
| B4   | `src/tools/get-role-prompt.ts`    | 改   | 同上                                                                                                              |
| B5   | `src/tools/iteration-start.ts`    | 改   | 同上                                                                                                              |
| B6   | `src/tools/engine-helpers.ts`     | 改   | 同上                                                                                                              |
| B7   | `src/tools/artifact-tools.ts`     | 改   | 同上                                                                                                              |
| B8   | `src/tools/dispatch-role.ts`      | 改   | 同上                                                                                                              |
| B9   | `src/tools/artifact-schema.ts`    | 改   | 同上                                                                                                              |
| B10  | `src/tools/approve-artifact.ts`   | 改   | 同上                                                                                                              |
| B11  | `src/tools/patch-start.ts`        | 改   | 同上                                                                                                              |
| B12  | `src/tools/report-dispatch.ts`    | 改   | 同上                                                                                                              |

### 阶段 3：Setup 添加内置工作流复制

| 编号 | 文件               | 操作 | 说明                                                                                                        |
| ---- | ------------------ | ---- | ----------------------------------------------------------------------------------------------------------- |
| C1   | `src/cli/setup.ts` | 改   | 添加复制逻辑：将 `<package>/workflows/*` 复制到 `<data_dir>/harmonia/.workflows/`，已存在则跳过或按版本更新 |

### 阶段 4：测试更新

| 编号 | 文件                   | 操作 | 说明                                                     |
| ---- | ---------------------- | ---- | -------------------------------------------------------- |
| D1   | `tests/plugin.test.ts` | 改   | 移除 `loadPluginByName` 相关测试，更新其他测试的参数传递 |
| D2   | `tests/schema.test.ts` | 改   | 更新 `loadArtifactSchema` 调用的参数                     |
| D3   | 其他测试文件           | 检查 | grep 确认无遗漏的 builtinDir 引用                        |
| D4   | 运行全量测试           | 验证 | `tsc --noEmit` + `npm test` 全部通过                     |

## 执行顺序

```
阶段 1: A1-A5 核心函数签名
  └── 🧪 tsc --noEmit 检查编译
阶段 2: B1-B12 入口 + 13 个 tools 文件
  └── 🧪 tsc --noEmit 检查编译
阶段 3: C1 Setup 复制逻辑
阶段 4: D1-D4 测试更新 + 全量测试
```

## 参数命名

统一将 `builtinDir + customDir` 合并为单一参数 `workflowsDir`，含义为"工作流查找目录"，即 `<data_dir>/harmonia/.workflows/`。

## 风险

| 风险                                     | 影响 | 缓解                                      |
| ---------------------------------------- | ---- | ----------------------------------------- |
| 遗漏某个文件的 builtinDir 引用           | 中   | tsc --noEmit 会报参数数量不匹配的编译错误 |
| setup 复制逻辑覆盖用户修改的自定义工作流 | 低   | 只在目标目录不存在对应工作流时才复制      |
| 现有测试依赖内置目录路径                 | 中   | 阶段 4 中逐一检查修复                     |

## 统计

| 阶段 | 项目数 | 涉及文件数 |
| ---- | ------ | ---------- |
| 1    | 5      | 2          |
| 2    | 12     | 12         |
| 3    | 1      | 1          |
| 4    | 4      | 3+         |
| 合计 | 22     | ~18        |
