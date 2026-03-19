# 045 — Dispatch 返回可执行 CLI 命令

> 将 `role_dispatch` 从返回文本指引改为返回可执行 CLI 命令，让 Coordinator 直接执行而非解读文本。

---

## 目标

1. **Agent 适配器层** — 新建 `src/core/agent-adapters.ts`，映射 agent 类型 → CLI 命令模板
2. **Prompt 文件写入** — Role Prompt 写入 `{contextDir}/.tmp/dispatch-{id}.md`，CLI 命令通过 `-f` 引用
3. **替换 Session Guidance** — dispatch 输出中 `## Session Guidance` 替换为 `## Launch Command`
4. **Fallback 机制** — 未指定 agent 时回退到现有文本指引
5. **清理** — `dispatch_report` 在终态时清理临时 prompt 文件
6. **测试 + 文档**

## 设计

### Agent CLI 格式映射

| Agent       | 新建命令                                                | 复用会话                | Model             | Prompt 文件                           |
| ----------- | ------------------------------------------------------- | ----------------------- | ----------------- | ------------------------------------- |
| opencode    | `opencode run [brief] -m <model> -f <file> --dir <dir>` | `-s <session-id>`       | `-m <model>`      | `-f <file>`                           |
| claude-code | `claude --print -p [brief] --model <model>`             | `--resume <session-id>` | `--model <model>` | 拼接到 prompt 文本（用 cat 读取文件） |
| codex       | `codex exec [brief]`                                    | N/A (无 session 复用)   | 无独立 model 参数 | 拼接到 prompt                         |
| openclaw    | `openclaw run [brief] -m <model> -f <file>`             | `-c <session-id>`       | `-m <model>`      | `-f <file>`                           |

### 适配器接口

```typescript
interface LaunchCommandParams {
  agent: string; // agent 类型
  model?: string; // 模型名
  promptFilePath: string; // 临时 prompt 文件路径
  projectDir: string; // 项目源码目录
  taskBrief: string; // 简短任务描述
  // 会话相关
  sessionAction: 'new' | 'resume';
  agentSessionId?: string; // 复用时的 agent session ID
}

interface LaunchCommandResult {
  command: string; // 完整 shell 命令字符串
  description: string; // 简短说明（如 "启动新 opencode 会话"）
}
```

### 临时文件路径

- 格式: `{contextDir}/.tmp/dispatch-{dispatchId}.md`
- 内容: 完整 Role Prompt（含 overrides + hook injections）
- 写入时机: `role_dispatch` 创建 dispatch 记录后
- 清理时机: `dispatch_report` 接收到终态（completed/failed/cancelled）时

### Dispatch 输出变更

Before:

```
## Session Guidance
**Model**: 用 `claude-sonnet-4` 拉起这个角色 (agent: opencode)
**No reusable session found** for this role.
**Action**: Launch a new agent for this role.
```

After (有 agent):

````
## Launch Command
```bash
opencode run "实现用户认证模块" -m claude-sonnet-4 -f /path/to/.tmp/dispatch-abc123.md --dir /path/to/project
````

> 启动新 opencode 会话

```

After (无 agent — fallback):
```

## Session Guidance

（保持原有文本格式）

```

## 变更计划

### Phase A: 新建 agent-adapters.ts

| 编号 | 内容 | 文件 |
|------|------|------|
| A1 | 定义 `LaunchCommandParams` 和 `LaunchCommandResult` 接口 | src/core/agent-adapters.ts |
| A2 | 实现 `buildLaunchCommand()` — 按 agent 类型分派构建 | src/core/agent-adapters.ts |
| A3 | 实现各 agent 的命令构建函数（opencode, claude-code, codex, openclaw） | src/core/agent-adapters.ts |
| A4 | 导出 `SUPPORTED_AGENTS` 常量列表 | src/core/agent-adapters.ts |

### Phase B: 改造 dispatch-role.ts

| 编号 | 内容 | 文件 |
|------|------|------|
| B1 | 新增 `writePromptFile()` — 写入临时 prompt 文件到 `{contextDir}/.tmp/` | src/tools/dispatch-role.ts |
| B2 | 新增 `buildLaunchSection()` — 调用适配器生成命令，构建 `## Launch Command` | src/tools/dispatch-role.ts |
| B3 | 修改输出组装 — agent 存在时用 `## Launch Command` 替代 `## Session Guidance` | src/tools/dispatch-role.ts |
| B4 | 保留 `buildSessionGuidance()` 作为 fallback（无 agent 时使用） | src/tools/dispatch-role.ts |
| B5 | `## Role Prompt` 区块 — 有 agent 且已写入文件时,简化为文件路径引用 | src/tools/dispatch-role.ts |

### Phase C: dispatch_report 清理

| 编号 | 内容 | 文件 |
|------|------|------|
| C1 | 终态时删除 `{contextDir}/.tmp/dispatch-{id}.md` | src/tools/report-dispatch.ts |

### Phase D: 类型更新

| 编号 | 内容 | 文件 |
|------|------|------|
| D1 | 将 `AgentType` 从 `dispatch_report` 的 zod enum 提取到 types.ts（如果还没有） | src/core/types.ts |

### Phase E: 测试

| 编号 | 内容 | 文件 |
|------|------|------|
| E1 | agent-adapters 单元测试 — 各 agent 命令格式验证 | tests/agent-adapters.test.ts |
| E2 | dispatch 集成测试更新 — 验证 prompt 文件写入和 Launch Command 输出 | tests/dispatch.test.ts |
| E3 | 运行全量测试确认无回归 | — |

### Phase F: 文档同步

| 编号 | 内容 | 文件 |
|------|------|------|
| F1 | workflow-guide.md — 新增 Launch Command 行为说明 | docs/workflow-guide.md |
| F2 | workflow-guide.md — agent 字段说明更新 | docs/workflow-guide.md |

## 执行顺序

Phase D → A → B → C → E → F

先确保类型就位，再建适配器，然后改造核心 dispatch 逻辑，最后测试和文档。
```
