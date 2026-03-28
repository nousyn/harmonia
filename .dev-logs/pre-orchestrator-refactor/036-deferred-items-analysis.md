# 036 — 延后项详细分析

> 第二轮修复（035）完成后，对 9 个延后项逐一分析其现状、计划要求、变更动机与不做的实际影响。

---

## 概述

第二轮审查（033）发现 20 个问题（F1-F20），其中 10 个已修复（035），剩余 9 个因工作量/影响面/实际价值考量延后。这些项目均非 bug，而是"原始架构设计文档要求但实现中未完成"的差距项。

---

## 逐项分析

### F1 — Hooks 未外置到 Plugin

**现状**: 所有 hook 生成逻辑（约 900 行）硬编码在 `src/hooks/` 目录内：

- `claude-code.ts` (228行) — Claude Code hook 生成
- `opencode.ts` (236行) — OpenCode hook 生成
- `openclaw.ts` (229行) — OpenClaw hook 生成
- `content.ts` (127行) — 共享常量
- `install.ts` (71行) — 安装编排器

`workflows/dev/hooks.js` 只是 `require('../../build/hooks/install.js')` 的薄桥接，并未真正将 hook 内容外置。

**计划要求（027 §17）**: "Hook 完全外置: Plugin 提供 hook 内容, Core 只负责传递和安装。"

**变更动机**: 当前设计意味着 Harmonia 只能给 `dev` workflow 生成 hooks。如果将来有人写了第二个 workflow（比如 `ops`），他们无法自定义自己的 hooks，必须修改 Harmonia 核心代码。外置后，每个 workflow plugin 自带 hooks 定义，core 只做安装编排。

**不做的影响**: 目前只有一个 `dev` workflow，功能完全正常。但违反了插件化原则，限制了多 workflow 扩展能力。

**风险**: 低 | **工作量**: 大（约 1-2 天）| **建议优先级**: P2

---

### F2 — `workflows/dev/tools.ts` 缺失

**现状**: 文件不存在。`ActionRegistry` 类已实现（可以注册自定义 actions），但没有任何 plugin 实际注册过 actions。

**计划要求（028 §1.5）**: dev plugin 应有 `tools.ts` 用于注册 dev 特有的 MCP tool actions。

**变更动机**: `ActionRegistry` 是一个可扩展入口——plugin 可以注册自己的 actions，让 agent 使用 plugin 专属的工具。没有 `tools.ts`，这个扩展机制就是空架子。

**不做的影响**: 零。当前所有功能不依赖此机制，工具注册走的是全局路径。

**风险**: 零 | **工作量**: 小 | **建议优先级**: P3

---

### F3 — Override 系统仍为 3 层

**现状**: `getMergedOverrides()` 读取三层配置：

1. `~/.config/harmonia/overrides.json`（全局）
2. 项目级 overrides
3. workflow defaults

**计划要求（027 §20）**: "全局 overrides.json 移除。两层合并: 项目级 > 工作流默认值。"

**变更动机**: 全局 overrides 文件是旧设计遗留。计划认为它增加了配置来源的复杂度，且没有实际用户使用。简化为两层可以让行为更可预测。

**不做的影响**: 几乎为零。全局文件通常不存在，读取时会静默跳过。但代码中保留了读取逻辑。

**风险**: 零 | **工作量**: 小 | **建议优先级**: P3

---

### F4 — `docs.ts` 未重命名为 `artifacts.ts`

**现状**: 核心模块文件名 `docs.ts`，函数名 `writeDoc`/`readDoc`/`listDocs`，磁盘目录 `docs/`。

**计划要求（028 §3.4）**: 术语映射 doc → artifact，"所有位置"。

**变更动机**: 重构引入了 "artifact" 概念来统一描述工作流产出物。但重命名涉及：

- 文件名：`docs.ts` → `artifacts.ts`
- 函数名：`writeDoc`/`readDoc`/`listDocs` → `writeArtifact`/`readArtifact`/`listArtifacts`
- 磁盘目录：`docs/` → `artifacts/`（需迁移策略——已存在的项目数据怎么办）
- 所有调用方更新
- workflow.json 中的引用

**不做的影响**: 纯术语不一致。代码中 `doc` 和 `artifact` 混用，新人可能困惑，但不影响功能。

**风险**: 中（涉及磁盘目录迁移策略）| **工作量**: 中 | **建议优先级**: P3

---

### F5 — `getInputArtifacts` 是空桩

**现状**: `engine-helpers.ts:109-113` 始终返回 `[]`，注释写着 `// TODO`。

**计划要求（027 §13）**: `NextAction.inputArtifacts` 应填充节点所需的输入 artifacts，让 agent 调度时自动获取上下文。

**变更动机**: 理想流程是引擎告诉角色"你需要处理 X artifact，这里是当前内容"。没有这个，agent 必须自己通过工具调用获取上下文，多一轮交互。

**不做的影响**: 中等。agent 功能正常，只是效率略低——需要自己调用 `read_artifact` 获取上下文而非引擎自动提供。

**风险**: 低 | **工作量**: 大（需设计 artifact 依赖解析逻辑）| **建议优先级**: P2

---

### F6 — `workflow.ts` 兼容层仍在用

**现状**: `workflow.ts` 标记了 `@deprecated`，但以下调用方仍在主动 import：

- `schema.ts` — 通过 `resolveWorkflowDir` 解析路径
- `engine-helpers.ts` — 通过 `loadWorkflow` 加载工作流

**计划要求（028 Phase 6）**: 删除旧兼容层。

**变更动机**: 兼容层的存在意味着有两条路径加载 workflow（plugin 系统 vs 旧的直接加载）。清理后代码更简洁，plugin 成为唯一入口。

**不做的影响**: 低。功能完全正确，只是依赖链不干净。

**风险**: 低 | **工作量**: 中（需将 resolveWorkflowDir/loadWorkflow 的调用方迁移到 plugin 路径）| **建议优先级**: P3

---

### F8 — `PHASE_IDLE_TIMEOUT_MINUTES` 常量名

**现状**: 常量名还用 `PHASE_` 前缀（应为 `WORKFLOW_`），嵌入在 3 个 hook 生成器的模板字符串中：

- `src/hooks/claude-code.ts`
- `src/hooks/opencode.ts`
- `src/hooks/openclaw.ts`

**计划要求**: 术语迁移 phase → workflow。

**变更动机**: 纯命名一致性。改名会影响生成的 bash/JS 脚本中的变量名。

**不做的影响**: 零功能影响。延期到 F1 hooks 外置时一并处理更合理。

**风险**: 零 | **工作量**: 极小（但影响生成脚本）| **建议优先级**: P3（随 F1 处理）

---

### F11 — `resolveReview` 缺少 dir 参数

**现状**: `approve-artifact.ts:30` 调用 `resolveReview()` 未传 `ctx.dir`。

**实际分析**: `contextDir` 参数是可选的。当前所有调用路径是自洽的——`resolveReview` 内部在 `contextDir` 为 undefined 时使用 `process.cwd()`，而在 approve 场景下这正好是正确的值。

**不做的影响**: 零（除非将来有非 cwd 场景需要显式传递 dir）。

**结论**: 不是 bug，无需处理。

**风险**: 零 | **工作量**: 无 | **建议优先级**: 无需处理

---

### F18 — `isRequired()` 类型签名不匹配

**现状**: `schema.ts` 中 `isRequired()` 运行时代码处理 `Record<string, boolean>` 格式（旧 scale-based 系统的向后兼容），但 TypeScript 类型签名只声明 `boolean`。

**变更动机**: 类型签名应准确反映运行时行为。

**不做的影响**: 低。旧格式已不再使用，兼容代码是防御性的。如果删除兼容代码，类型签名和实现就会一致。

**风险**: 零 | **工作量**: 极小 | **建议优先级**: P3

---

## 总结矩阵

| 类别           | 项目                     | 风险 | 工作量 | 功能影响             |
| -------------- | ------------------------ | ---- | ------ | -------------------- |
| **有实际价值** | F1 Hooks 外置            | 低   | 大     | 限制多 workflow 扩展 |
| **有实际价值** | F5 inputArtifacts        | 低   | 大     | agent 上下文效率     |
| **清理型**     | F4 docs→artifacts 重命名 | 中   | 中     | 术语不一致           |
| **清理型**     | F6 删兼容层              | 低   | 中     | 依赖链不干净         |
| **空架子**     | F2 tools.ts              | 零   | 小     | 无                   |
| **空架子**     | F3 Override 简化         | 零   | 小     | 无                   |
| **纯命名**     | F8 常量名                | 零   | 极小   | 无                   |
| **纯命名**     | F18 类型签名             | 零   | 极小   | 无                   |
| **无需处理**   | F11 resolveReview        | 零   | 无     | 不是 bug             |

## 建议路径

1. **如需支持多 workflow**: 优先做 F1（hooks 外置）+ F8（随 F1 处理）
2. **如需提升 agent 效率**: 做 F5（inputArtifacts 填充）
3. **如需代码整洁**: 做 F4 + F6（术语统一 + 删兼容层），但 F4 需要磁盘迁移策略
4. **低优先级**: F2, F3, F18 可在任意维护窗口随手处理
5. **忽略**: F11 已确认不是问题
