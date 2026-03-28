# 010 — 完成：集成 @s_s/agent-kit

**日期**: 2026-03-16
**类型**: 完成记录

## 背景

P4（Session 管理 + Dispatch 追踪）已在 007 完成。Gap 评估（008）识别出 Harmonia 自实现的 agent 检测、prompt 注入、跨平台数据目录逻辑与 `@s_s/agent-kit` 高度重合。计划（009）制定了 8 步集成方案。

## 完成内容

### 1. 安装依赖

- `package.json` 新增 `@s_s/agent-kit` 依赖

### 2. 统一 AgentType 类型

- `src/core/types.ts` 删除本地 `AgentType` 定义，改为从 `@s_s/agent-kit` import + re-export
- 使用 `import type` + `export type` 模式确保同文件内可引用

### 3. 替换 getGlobalDir()

- `src/core/registry.ts` 删除 `homedir`/`platform` 导入和 switch 平台逻辑（~15 行）
- 改用 `createKit('harmonia').getDataDir()`，一行替代
- `HARMONIA_DATA_DIR` 环境变量兼容性经验证完全一致

### 4. 重写 inject.ts

- `src/setup/inject.ts` 从 137 行精简至 69 行
- `detectHostAgent()` → 委托 agent-kit 的 `detectAgent()`，null 时 fallback 到 `'opencode'`
- `injectPrompt()` → 委托 `kit.injectPrompt()`，通过前后状态检查重建 `{ filePath, created, replaced }` 返回值
- `removePrompt()` 删除（死代码，无调用方）
- 标记管理完全由 agent-kit 负责（`<!-- harmonia:start/end -->`）

### 5. 精简 templates.ts

- `generateOpenCodePrompt()` 不再包裹 `<!-- harmonia:start/end -->` 标记
- 标记常量移至 `inject.ts` 仅用于测试断言
- 函数返回纯 prompt 内容

### 6. 适配 setup-project.ts

- `HostAgentType` → `AgentType`（从 agent-kit re-export）
- 导入路径对齐

### 7. 重写测试文件

- `tests/setup.test.ts` 改为 mock `@s_s/agent-kit` 的 `detectAgent`
- 原因：agent-kit 的 `detectAgent()` 检查全局路径（如 `~/.config/opencode/opencode.json`），测试机器上 OpenCode 运行中，全局配置始终存在，导致无论 tempDir 内容如何都会检测到 opencode
- mock 后测试独立于宿主环境，验证 `detectHostAgent` 的 fallback 逻辑和透传行为
- 删除 3 个 `removePrompt` 测试

### 8. 构建 + 测试验证

- TypeScript 编译零错误
- 7 个测试文件，83 个测试全部通过

## 构建过程中发现并修复的问题

| 问题                                                      | 原因                                                | 修复                                                                      |
| --------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| `Cannot find name 'AgentType'` (types.ts:135, 194)        | `export type { X } from '...'` 不在当前模块引入类型 | 改为 `import type { AgentType } from '...'` + `export type { AgentType }` |
| 测试 `detectHostAgent` 返回 `opencode` 而非 `claude-code` | agent-kit 检查全局路径，宿主 opencode 配置始终命中  | mock `detectAgent` 隔离宿主环境                                           |

## 兼容性验证结果

| 项目                                   | 结果                             |
| -------------------------------------- | -------------------------------- |
| 标记格式 `<!-- harmonia:start/end -->` | 完全兼容                         |
| 环境变量 `HARMONIA_DATA_DIR`           | 完全兼容                         |
| 数据目录路径（macOS/Linux/Windows）    | 完全兼容                         |
| Agent 检测                             | 兼容，支持范围更广（4 种 agent） |

## 修改文件列表

| 文件                         | 操作                                     |
| ---------------------------- | ---------------------------------------- |
| `package.json`               | 新增 `@s_s/agent-kit` 依赖               |
| `src/core/types.ts`          | AgentType 改为 import + re-export        |
| `src/core/registry.ts`       | getGlobalDir() 改用 kit.getDataDir()     |
| `src/setup/inject.ts`        | 重写，委托 agent-kit（137→69 行）        |
| `src/setup/templates.ts`     | 删除标记包裹，返回纯 prompt              |
| `src/tools/setup-project.ts` | HostAgentType → AgentType                |
| `tests/setup.test.ts`        | mock detectAgent，删除 removePrompt 测试 |

净减少约 70 行自维护代码。

## 测试结果

- 7 个测试文件，83 个测试全部通过
- TypeScript 构建成功

## 后续可选项（本次未实施）

- 引入 agent-kit 的 hook 能力（`defineHooks` + `installHooks`）
- 使用 `detectAgentFromClient()` 在 MCP 连接时自动识别宿主 agent
