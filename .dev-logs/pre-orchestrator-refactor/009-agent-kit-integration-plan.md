# 009 — 集成 @s_s/agent-kit 计划

**日期**: 2026-03-16
**类型**: 执行计划

## 目标

引入 `@s_s/agent-kit` 作为底层依赖，替换 Harmonia 自实现的 agent 检测、prompt 注入、跨平台数据目录逻辑。减少自维护代码，统一 agent 适配层。

## 背景

agent-kit 提供：

- `detectAgent()` — 文件特征检测 agent 类型（opencode/claude-code/openclaw/codex）
- `detectAgentFromClient()` — MCP clientInfo.name 映射
- `createKit(name)` → `kit.injectPrompt()` — 幂等标记块注入（`<!-- name:start/end -->`）
- `createKit(name)` → `kit.getDataDir()` — 跨平台数据目录
- `defineHooks()` / `kit.installHooks()` — hook 声明与安装（本次不引入）

Harmonia 当前自实现了以上前三项能力，逻辑高度重合。

## 兼容性验证

| 项目         | Harmonia 现状                                      | agent-kit 对应                                          | 兼容性       |
| ------------ | -------------------------------------------------- | ------------------------------------------------------- | ------------ |
| 标记格式     | `<!-- harmonia:start/end -->`                      | `createKit('harmonia')` → `<!-- harmonia:start/end -->` | 完全兼容     |
| 环境变量     | `HARMONIA_DATA_DIR`                                | 默认 `{NAME}_DATA_DIR` = `HARMONIA_DATA_DIR`            | 完全兼容     |
| 数据目录路径 | macOS: `~/Library/Application Support/harmonia` 等 | 相同逻辑                                                | 完全兼容     |
| Agent 检测   | 只检测 `.claude/settings.json`，默认 opencode      | 按 opencode→claude-code→openclaw→codex 顺序检测         | 兼容，更完善 |

## 计划内容

### Step 1: 安装依赖

```bash
npm install @s_s/agent-kit
```

### Step 2: 改造 `src/core/types.ts` — 统一 AgentType

**变更**：删除本地 `AgentType` 定义，改为 re-export agent-kit 的类型。

```typescript
// 删除:
// export type AgentType = 'opencode' | 'openclaw' | 'claude-code' | 'codex';

// 新增:
export type { AgentType } from '@s_s/agent-kit';
```

其他模块（dispatch.ts, overrides.ts, tools/）已通过 types.ts 引用 AgentType，re-export 后无需修改。

### Step 3: 改造 `src/core/registry.ts` — 替换 getGlobalDir()

**变更**：删除自实现的平台检测逻辑，改用 `kit.getDataDir()`。

```typescript
import { createKit } from '@s_s/agent-kit';

const kit = createKit('harmonia');

export function getGlobalDir(): string {
  return kit.getDataDir(); // 自动处理环境变量 + 跨平台路径
}
```

删除：`import { homedir, platform } from 'node:os'` 及整个 switch 逻辑（~15 行）。
`getProjectDataDir()` 和其他函数保持不变（它们依赖 `getGlobalDir()` 的返回值）。

### Step 4: 重写 `src/setup/inject.ts` — 用 agent-kit 替代

**变更**：

1. `detectHostAgent()` → 改用 `detectAgent()` from agent-kit
   - 删除 `HostAgentType` 类型，统一使用 `AgentType`
   - agent-kit 的检测更完善（支持 4 种 agent），但需要注意 scope：agent-kit 的 detectAgent 是按 cwd + home 检测，不是按 projectDir

2. `injectPrompt()` → 内部改用 `kit.injectPrompt(agent, promptContent, { scope: 'project', projectRoot: projectDir })`
   - agent-kit 自动管理 `<!-- harmonia:start/end -->` 标记
   - agent-kit 自动处理文件创建、幂等替换、追加
   - 返回值简化（agent-kit 的 injectPrompt 无返回值），需要自己判断 created/replaced

3. `removePrompt()` → 删除（死代码，无调用方）

改造后代码约 40 行（从 137 行精简）。

### Step 5: 精简 `src/setup/templates.ts`

**变更**：

- 删除 `HARMONIA_MARKER_START` 和 `HARMONIA_MARKER_END` 常量导出
- `generateOpenCodePrompt()` 不再包裹标记（标记由 agent-kit 自动管理）
- 函数返回纯 prompt 内容（无 `<!-- harmonia:start/end -->`）

### Step 6: 适配 `src/tools/setup-project.ts`

**变更**：

- `detectHostAgent` → `detectAgent` from agent-kit
- `HostAgentType` → `AgentType`
- `injectPrompt()` 调用签名适配

### Step 7: 适配 `tests/setup.test.ts`

**变更**：

- 移除 `removePrompt` 相关测试（3 个）
- `detectHostAgent` → `detectAgent`（agent-kit 的检测逻辑不同，测试需适配）
- `injectPrompt` 测试适配新签名和返回值
- `HARMONIA_MARKER_START/END` 改为内联字符串
- `generateOpenCodePrompt` 测试验证不再包含标记

### Step 8: 构建 + 全量测试

```bash
npm run build && npm test
```

确保 86 个测试全部通过（减去 3 个 removePrompt 测试 = 83+，可能新增少量 agent-kit 集成测试）。

## 文件变更清单

| 文件                         | 操作                               | 行数变化   |
| ---------------------------- | ---------------------------------- | ---------- |
| `package.json`               | 新增 `@s_s/agent-kit` 依赖         | +1         |
| `src/core/types.ts`          | AgentType 改为 re-export           | -1 +1      |
| `src/core/registry.ts`       | getGlobalDir() 改用 kit            | -15 +3     |
| `src/setup/inject.ts`        | 重写，用 agent-kit 替代            | -137 +~40  |
| `src/setup/templates.ts`     | 删除标记常量，prompt 不含标记      | -5         |
| `src/tools/setup-project.ts` | 适配新 API                         | ~5 行改动  |
| `tests/setup.test.ts`        | 适配新 API，删除 removePrompt 测试 | ~30 行改动 |

净减少约 100 行自维护代码。

## 不变更的模块

- `src/core/state.ts` — 不涉及
- `src/core/workflow.ts` — 不涉及
- `src/core/docs.ts` — 不涉及
- `src/core/reviews.ts` — 不涉及
- `src/core/dispatch.ts` — 不涉及（AgentType 通过 types.ts re-export 自动生效）
- `src/core/overrides.ts` — 不涉及
- `src/tools/` 下除 `setup-project.ts` 外全部不涉及
- `workflows/` — 不涉及
- `src/index.ts` — 不涉及

## 后续可选项（本次不实施）

- 引入 agent-kit 的 hook 能力（`defineHooks` + `installHooks`），在 agent 上安装 Harmonia 提醒 hook
- 使用 `detectAgentFromClient()` 在 MCP 连接时自动识别宿主 agent
