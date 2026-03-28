# 014 — P2 Agent Hook 完成

> 日期: 2026-03-16
> 状态: 完成
> 关联: [011-optimization-proposal](011-optimization-proposal.md) P2

## 概述

实现了 Agent Hook 系统——在宿主 agent 层面（而非仅靠 MCP prompt）对 PM 行为施加约束。
三个 agent 平台各有一套 hook 生成器，通过 agent-kit 的 `defineHooks` + `installHooks` API 安装。

## 架构

```
src/hooks/
├── content.ts      # 共享常量：BLOCKED_TOOLS, BLOCKED_COMMANDS, CODE_EXTENSIONS, 超时阈值, HookParams
├── claude-code.ts  # Claude Code/Codex: PreToolUse (硬拦截) + UserPromptSubmit (提醒注入)
├── opencode.ts     # OpenCode: tool.execute.before (软拦截) + messages.transform (提醒注入)
├── openclaw.ts     # OpenClaw: before_tool_call (硬拦截) + message_received (每轮提醒注入)
└── install.ts      # 统一入口：installHooks / uninstallHooks / hasHooksInstalled
```

## 功能细节

### P2.1 边界守卫 (Boundary Guard)

阻止 PM agent 直接操作代码：

| 规则                     | Claude Code         | OpenCode                  | OpenClaw               |
| ------------------------ | ------------------- | ------------------------- | ---------------------- |
| Write/Edit 代码文件      | exit 0 + JSON block | 替换 args 为警告内容      | return { block: true } |
| Write/Edit 越界路径      | exit 0 + JSON block | 替换 args 为警告内容      | return { block: true } |
| Bash 开发命令            | exit 0 + JSON block | 替换 command 为 echo 警告 | return { block: true } |
| Harmonia data dir        | 放行                | 放行                      | 放行                   |
| 非代码文件 (AGENTS.md等) | 放行                | 放行                      | 放行                   |

### P2.2 主动提醒 (Proactive Reminders)

读取 Harmonia 数据文件注入状态提醒：

- **dispatches.json** — dispatch 运行超过 30 分钟告警
- **reviews.json** — 文档审核待处理超过 10 分钟告警
- **state.json** — 阶段空闲超过 15 分钟告警

输出格式统一为 `<harmonia-reminder>` 标签。

### P2.3 参数嵌入

所有常量（路径、超时阈值、规则列表）在安装时 bake 进 hook 内容：

- `HARMONIA_DATA_DIR` — 全局数据目录
- `PROJECT_NAME` — 项目名称
- `PROJECT_DIR` — 项目源码目录

### P2.4 平台适配策略

| 平台                | 阻断能力                               | 策略                                             |
| ------------------- | -------------------------------------- | ------------------------------------------------ |
| Claude Code / Codex | PreToolUse 可硬阻断 (exit code / JSON) | 硬拦截 + stdout 注入提醒                         |
| OpenCode            | tool.execute.before 只能改 args        | 软拦截 (替换 args) + messages.transform 注入提醒 |
| OpenClaw            | before_tool_call 可硬阻断              | 硬拦截 + message_received 每轮注入提醒           |

## 集成

`setup_project` 工具在 prompt injection 之后自动安装 hooks：

```
setup_project
  → injectPrompt (AGENTS.md / CLAUDE.md)
  → installHooks (agent-kit → 写入 hook 文件 + 配置)
```

agent_type 参数扩展：新增 `openclaw` 选项。

## 文件变更

### 新增

- `src/hooks/content.ts` — 130 行，共享常量和 HookParams 接口
- `src/hooks/claude-code.ts` — 253 行，Claude Code shell 脚本生成器
- `src/hooks/opencode.ts` — 175 行，OpenCode TypeScript 插件生成器
- `src/hooks/openclaw.ts` — 190 行，OpenClaw handler 生成器
- `src/hooks/install.ts` — 70 行，统一安装/卸载入口
- `tests/hooks.test.ts` — 61 个测试

### 修改

- `src/tools/setup-project.ts` — 集成 hook 安装，新增 openclaw agent_type

## 测试

- 61 个新测试覆盖：
  - 共享常量完整性 (7)
  - Claude Code hook 内容生成 (20)
  - OpenCode plugin 内容生成 (17)
  - OpenClaw handler 内容生成 (14)
  - Agent 路由 (6: claude-code, codex, opencode, openclaw, unknown, params 传递)
- 全套 210 个测试通过 (149 原有 + 61 新增)
- 构建通过

## 设计决策

1. **单插件文件 vs 多文件**：OpenCode 和 OpenClaw 各用单个定义文件包含所有 hook 逻辑，避免跨文件依赖
2. **codex 复用 claude-code**：Codex 共享 Claude Code 的 hook 协议，`createHooksForAgent` 路由到同一生成器
3. **软拦截 vs 硬拦截**：OpenCode 无法真正阻断，采用 args 替换策略——虽非 100% 防护，但有效干扰 + 提醒组合可覆盖大部分场景
4. **不测试 agent-kit**：测试只验证 Harmonia 自己的逻辑（内容生成、参数嵌入、路由），不测试 defineHooks/installHooks
