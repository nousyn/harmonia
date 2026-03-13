# 006 — P4 计划：Session 管理 + 流程进度追踪

**日期**: 2026-03-13
**类型**: 执行计划

## 目标

为 Harmonia 添加 Session 管理和 Dispatch 追踪能力，实现：

1. PM 中断恢复后能完整了解项目进度（谁被派了什么任务、进度如何）
2. Session 复用（persistent 角色可恢复会话继续工作）
3. 完成情况从 dispatch 状态 + 文档存在性自动推导，无需额外通知机制

## 设计原则

- **PM 操作极简**：PM 只需 dispatch_role + report_dispatch + get_project_status
- **Session 管理内化**：dispatch_role 自动查找可复用 session 并给出指引，PM 不需要手动调 find_session
- **项目隔离**：session 和 dispatch 记录存在项目级目录下（与 state.json 同级）
- **纯数据层**：Harmonia 不拉起/监听 agent，只记录和推导

## 计划内容

### Step 1: 新增类型定义

文件：`src/core/types.ts`

```typescript
// Session 状态
type SessionStatus = 'active' | 'idle' | 'closed' | 'lost';

// Session 记录 — 一个 agent 实例的会话
interface SessionRecord {
  id: string; // harmonia 生成，如 "ses-001"
  role: string; // "architect", "developer", "tester"
  agentSessionId?: string; // 宿主 agent 返回的实际 session ID
  agentType?: AgentType; // "opencode", "openclaw" 等
  status: SessionStatus;
  label?: string; // PM 自定义标签，如 "dev-auth-module"
  createdAt: string;
  lastActiveAt: string;
}

// Dispatch 状态
type DispatchStatus = 'dispatched' | 'running' | 'completed' | 'failed' | 'cancelled';

// Dispatch 记录 — 一次任务派发
interface DispatchRecord {
  id: string; // 自增，如 "dispatch-001"
  role: string;
  sessionId?: string; // 关联的 session ID
  taskBrief: string;
  status: DispatchStatus;
  expectedOutputs: string[]; // 预期产出 doc_id
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  note?: string; // 失败原因或备注
}
```

### Step 2: 新增核心模块 — dispatch 状态管理

文件：`src/core/dispatch.ts`

职责：管理 `<data_dir>/<project>/sessions.json` 和 `<data_dir>/<project>/dispatches.json`

核心函数：

- `createSession(projectName, role, agentType?, label?)` → SessionRecord
- `updateSession(projectName, sessionId, updates)` → SessionRecord
- `findIdleSession(projectName, role)` → SessionRecord | null
- `listSessions(projectName)` → SessionRecord[]
- `createDispatch(projectName, role, taskBrief, expectedOutputs, sessionId?)` → DispatchRecord
- `updateDispatch(projectName, dispatchId, updates)` → DispatchRecord
- `listDispatches(projectName)` → DispatchRecord[]

ID 生成规则：读取已有记录数量，自增编号（ses-001, dispatch-001）。

### Step 3: 改造 dispatch_role — 自动创建 dispatch + session 复用指引

文件：`src/tools/dispatch-role.ts`

改造点：

1. 调用时自动创建一条 dispatch 记录（status: dispatched）
2. 自动查找该 role 是否有 idle session（调用 findIdleSession）
3. 返回的数据包中新增 dispatch 信息段：
   - 如有可复用 session → 明确输出 agent_session_id 和恢复命令
   - 如无可复用 session → 明确输出"拉起新 agent"的指引
4. 返回 dispatch_id，供 report_dispatch 使用

### Step 4: 新增工具 — report_dispatch

文件：`src/tools/report-dispatch.ts`

PM 在两个时机调用：

1. **拉起后**：回报 agent_session_id → Harmonia 创建/更新 session，关联 dispatch，标记 running
2. **完成后**：回报 status: completed/failed → Harmonia 更新 dispatch，session 转 idle/closed

参数：

- `project_name`: string
- `dispatch_id`: string
- `status?`: 'running' | 'completed' | 'failed' | 'cancelled'
- `agent_session_id?`: string（首次回报时提供）
- `agent_type?`: AgentType
- `note?`: string

内部逻辑：

- 如果提供了 agent_session_id 且 dispatch 没有关联 session：
  - 查找是否有相同 role + agent_session_id 的已有 session → 复用
  - 否则创建新 session
  - 关联到 dispatch，session 标记 active
- 如果 status = completed → dispatch 完成，session 转 idle
- 如果 status = failed → dispatch 失败，session 标记 lost（可配置）

### Step 5: 改造 get_project_status — 展示 session/dispatch 全景

文件：`src/tools/get-project-status.ts`

新增输出段：

- **活跃会话**：列出所有非 closed 的 session（role, status, agent_session_id, label）
- **调度记录**：列出所有 dispatch（role, task, status, session 关联）

改造 deriveNextSteps：

- 如有 dispatched 但未 running 的 dispatch → 建议拉起
- 如有 running 的 dispatch → 建议等待完成
- 如所有 dispatch completed + 文档齐全 + review 通过 → 建议推进阶段
- 如有 failed 的 dispatch → 建议重新 dispatch 或排查原因

### Step 6: 改造 PM 引导模板

文件：`src/setup/templates.ts`

新增/更新内容：

- 工具表新增 `report_dispatch` 工具说明
- Dispatch 后的操作流程更新为：dispatch_role → 拉起 agent → report_dispatch(agent_session_id) → 等完成 → report_dispatch(completed) → get_project_status
- 中断恢复指引：重启后先调 get_project_status 查看全景
- 删除旧的手动拉起指引，替换为新流程

### Step 7: 注册新工具

文件：`src/index.ts`

- 导入并注册 `registerReportDispatch`
- 更新 dispatch_role 注册参数（如需要）

### Step 8: 测试

新增测试文件：`tests/dispatch.test.ts`

覆盖：

- createSession / updateSession / findIdleSession
- createDispatch / updateDispatch / listDispatches
- dispatch_role 自动创建 dispatch 记录
- dispatch_role 发现可复用 session 时的返回内容
- report_dispatch 首次回报（创建 session + 关联）
- report_dispatch 完成回报（dispatch completed + session idle）
- get_project_status 包含 dispatch/session 信息
- deriveNextSteps 的 dispatch 感知逻辑
- 项目隔离：不同项目的 session/dispatch 互不影响

### Step 9: 更新工具数 + 构建验证

- setup-project.ts 中的工具数从 14 更新（+1 report_dispatch = 15）
- TypeScript 编译通过
- 全部测试通过

## 数据文件结构

```
<data_dir>/<project_name>/
├── state.json         # 已有
├── reviews.json       # 已有
├── overrides.json     # 已有
├── sessions.json      # 新增：SessionRecord[]
├── dispatches.json    # 新增：DispatchRecord[]
└── docs/              # 已有
```

## PM 操作流程（改造后）

```
派任务：dispatch_role(project, role, task)
  → 自动创建 dispatch，返回数据包 + session 复用指引

回报拉起：report_dispatch(project, dispatch_id, agent_session_id: "xxx")
  → 自动创建/复用 session，dispatch 标记 running

回报完成：report_dispatch(project, dispatch_id, status: "completed")
  → dispatch 完成，session 转 idle

检查进度：get_project_status(project)
  → 包含 session/dispatch 全景 + 智能 next steps
```

## 新增工具数

| 变更 | 说明                                                     |
| ---- | -------------------------------------------------------- |
| 新增 | `report_dispatch`                                        |
| 改造 | `dispatch_role`（自动创建 dispatch + session 复用）      |
| 改造 | `get_project_status`（展示 dispatch/session + 增强推导） |
| 改造 | `templates.ts`（PM 引导模板更新）                        |

总工具数：14 → 15
