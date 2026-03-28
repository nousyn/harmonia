# 041 — Hook 外置化计划

## 目标

将 hook 生成逻辑从 `src/hooks/` 完全迁移到 `workflows/dev/`，实现 027 架构设计的"Hook 完全外置"原则：**Plugin 提供 hook 内容，Core 只负责传递和安装**。

## 背景

当前状态：

- `src/hooks/` 包含 4 个 TypeScript 文件（~820 行），编译到 `build/hooks/`
- `workflows/dev/hooks.js` 是薄桥接层，通过 `../../build/hooks/*.js` 相对路径 import
- 三个 agent hook 生成器的实际 TS 逻辑不到 25 行，其余全是模板字符串（shell 脚本、TS 插件源码、handler 源码）
- TypeScript 类型检查对模板字符串内容无能为力，`.ts` vs `.js` 无实质差异

设计决策：

- 方案选择：**全内联到 workflow 目录（纯 .js）**
- 理由：hook 内容本质是"提示词 + 脚本模板的容器"，核心框架不应包含工作流特定的 hook 内容
- `defineHooks` 由 Core 通过 context 传入，workflow 不需要直接依赖 `@s_s/agent-kit`

## 当前架构

```
调用链：
project-init.ts
  → wf.hooks(agentType, context)        // context = { defineHooks, dataDir, projectName }
  → workflows/dev/hooks.js              // createHooks(agentType, context)
    → ../../build/hooks/claude-code.js   // ← 跨目录相对路径！
    → ../../build/hooks/opencode.js
    → ../../build/hooks/openclaw.js
      → build/hooks/content.js           // 共享常量
      → @s_s/agent-kit defineHooks()     // 直接 import
```

## 目标架构

```
调用链：
project-init.ts
  → wf.hooks(agentType, context)        // context = { defineHooks, dataDir, projectName }
  → workflows/dev/hooks.js              // createHooks(agentType, context)
    → ./hooks-content.js                // 同目录，自包含
    → ./hooks-claude.js                 // 同目录
    → ./hooks-opencode.js               // 同目录
    → ./hooks-openclaw.js               // 同目录
      → context.defineHooks()           // 从 context 获取，不直接 import
```

## 变更清单

### 阶段 1：迁移 hook 内容到 workflow 目录

| ID  | 文件                              | 操作 | 说明                                                                                                                                                                       |
| --- | --------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `workflows/dev/hooks-content.js`  | 新建 | 从 `src/hooks/content.ts` 转换，导出所有共享常量。去掉 TypeScript 类型声明（`HookParams` 接口、`as const`），纯 JS 常量导出                                                |
| A2  | `workflows/dev/hooks-claude.js`   | 新建 | 从 `src/hooks/claude-code.ts` 转换。`generatePreToolUseScript()` + `generateUserPromptSubmitScript()` + `createClaudeCodeHooks()`。`defineHooks` 从函数参数接收而非 import |
| A3  | `workflows/dev/hooks-opencode.js` | 新建 | 从 `src/hooks/opencode.ts` 转换。同上模式                                                                                                                                  |
| A4  | `workflows/dev/hooks-openclaw.js` | 新建 | 从 `src/hooks/openclaw.ts` 转换。同上模式                                                                                                                                  |
| A5  | `workflows/dev/hooks.js`          | 重写 | 删除 `../../build/hooks/` import，改为 `./hooks-*.js` 同目录 import。`createHooks(agentType, context)` 将 `context.defineHooks` 透传给各平台生成器                         |

**函数签名变更**：

```js
// 旧：直接 import defineHooks
import { defineHooks } from '@s_s/agent-kit';
export function createClaudeCodeHooks(params) { ... defineHooks(...) }

// 新：从参数接收 defineHooks
export function createClaudeCodeHooks(defineHooks, params) { ... defineHooks(...) }
```

### 阶段 2：清理 src/hooks/ 和更新引用

| ID  | 文件                       | 操作 | 说明                                           |
| --- | -------------------------- | ---- | ---------------------------------------------- |
| B1  | `src/hooks/content.ts`     | 删除 | 内容已迁移到 `workflows/dev/hooks-content.js`  |
| B2  | `src/hooks/claude-code.ts` | 删除 | 内容已迁移到 `workflows/dev/hooks-claude.js`   |
| B3  | `src/hooks/opencode.ts`    | 删除 | 内容已迁移到 `workflows/dev/hooks-opencode.js` |
| B4  | `src/hooks/openclaw.ts`    | 删除 | 内容已迁移到 `workflows/dev/hooks-openclaw.js` |
| B5  | `src/hooks/` 目录          | 删除 | 整个目录清除                                   |

### 阶段 3：删除 workflow 测试 + 类型检查

| ID  | 文件                            | 操作 | 说明                                                                                   |
| --- | ------------------------------- | ---- | -------------------------------------------------------------------------------------- |
| C1  | `tests/hooks.test.ts`           | 删除 | 测试 dev workflow 的 hook 脚本模板内容，属于外挂插件自测                               |
| C2  | `tests/workflow.test.ts`        | 删除 | 测试 dev workflow 的加载结果（name/version/角色列表/artifact 定义），属于外挂插件自测  |
| C3  | `tests/artifact-schema.test.ts` | 删除 | 测试 dev workflow 的具体 schema 输出（prd 的字段、tech-design 内容），属于外挂插件自测 |
| C4  | `src/core/types.ts`             | 检查 | `HookCreatorContext.defineHooks` 当前类型是 `unknown`，确认是否需要调整                |
| C5  | `src/tools/project-init.ts`     | 检查 | 确认 context 构建逻辑无需修改（当前已正确传入 `defineHooks`）                          |

**删除测试的理由**：Harmonia Core 的职责是提供工作流控制和协作框架，工作流本身是外挂可插拔的。Core 测试应验证框架能力（加载插件、验证结构、状态管理等），而非特定 workflow 的具体内容。上述 3 个测试文件纯粹验证 dev workflow 的内容细节，不属于 Core 职责。

## 执行顺序

1. 阶段 1（A1-A5）：创建新文件
2. 阶段 2（B1-B5）：删除 `src/hooks/`
3. 阶段 3（C1-C5）：删除 workflow 测试 + 类型检查 → `tsc --noEmit` + `npm test` 全部通过

## 风险点

- `codex` agent 类型复用 `claude-code` hooks 的逻辑需在路由层处理
- 删除 `src/hooks/` 后需确认没有其他 `src/` 模块 import 这些文件
