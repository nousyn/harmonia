# Harmonia API Reference

> 版本：1.0.0

---

## 设计约定

### 术语

| 外部术语（API） | 含义                       | 内部术语（引擎）         |
| --------------- | -------------------------- | ------------------------ |
| **task**        | 分配给角色的工作单元       | `TaskNode`               |
| **iteration**   | 一轮完整的工作流执行       | `ContextType: iteration` |
| **patch**       | 针对已发布版本的修复周期   | `ContextType: patch`     |
| **artifact**    | 工作产出物（文档、代码等） | —                        |
| **review**      | 用户对 artifact 的审批     | `ReviewState`            |
| **issue**       | 跟踪的缺陷或反馈           | `Issue`                  |

**原则**：外部 API 只暴露消费者需要操作的概念。`gate`、`sequence`、`parallel`、`loop` 是引擎内部控制结构，不暴露。

### 命名规范

| 维度      | 规范                 | 示例                            |
| --------- | -------------------- | ------------------------------- |
| URL 路径  | kebab-case，复数名词 | `/projects/:name/artifacts/:id` |
| JSON 字段 | camelCase            | `{ "artifactId": "prd" }`       |
| 查询参数  | camelCase            | `?iteration=1`                  |
| 枚举值    | lowercase            | `"status": "pending"`           |

### 通用响应格式

**成功响应**：HTTP 2xx，JSON body

**错误响应**：HTTP 4xx/5xx

```json
{
  "error": "描述信息"
}
```

**列表响应**：资源名作 key

```json
{
  "projects": [...]
}
```

---

## 资源模型

```
projects/
  ├── iterations/          (完整工作流执行)
  │     └── tasks/         (工作单元)
  ├── patches/             (修复周期)
  │     └── tasks/
  ├── artifacts/           (产出物)
  │     └── steps/         (分步产出)
  ├── reviews/             (审批)
  └── issues/              (缺陷跟踪)

agents/                    (Agent 连接管理)
```

---

## 1. 项目管理

### 1.1 创建项目

```
POST /projects
```

**请求体**

```json
{
  "projectName": "my-app", // required
  "projectDir": "/path/to/src", // required
  "workflow": "dev" // optional, 多工作流时必填
}
```

**响应 `200`**（已存在） / **`201`**（新建）

```json
{
  "projectName": "my-app",
  "projectDir": "/path/to/src",
  "workflow": "dev",
  "workflowDescription": "软件开发流程",
  "availableRoles": ["coordinator", "architect", "developer", "tester"],
  "hookMessage": "请在 Claude Code 中安装 harmonia hooks...",
  "alreadyRegistered": false
}
```

### 1.2 列出项目

```
GET /projects
```

**响应 `200`**

```json
{
  "projects": [
    {
      "name": "my-app",
      "projectDir": "/path/to/src",
      "workflow": "dev",
      "activeTask": "clarify",
      "activeContext": "iter-1",
      "updatedAt": "2026-03-28"
    }
  ]
}
```

### 1.3 获取项目状态

```
GET /projects/:name/status
```

**响应 `200`**

```json
{
  "projectName": "my-app",
  "projectDir": "/path/to/src",
  "workflow": "dev",
  "activeContext": "iter-1",
  "contextType": "iteration",
  "contextNumber": 1,
  "currentIteration": 1,
  "totalIterations": 1,
  "currentPatch": 0,
  "totalPatches": 0,
  "activeTaskId": "clarify",
  "createdAt": "2026-03-28T10:00:00.000Z",
  "updatedAt": "2026-03-28T10:30:00.000Z",
  "treeLines": ["▸ main (sequence)", "  ● clarify (task, coordinator) — active", "..."],
  "artifacts": {
    "prd": { "name": "需求文档", "review": true, "exists": false }
  },
  "reviews": {
    "prd": { "status": "pending", "submittedAt": "..." }
  },
  "stepsData": {},
  "dispatches": [],
  "sessions": [],
  "issues": [],
  "nextAction": "Dispatch role \"coordinator\" for task \"clarify\"",
  "stepGuidance": null,
  "stepGuidances": []
}
```

---

## 2. 迭代与补丁

### 2.1 开始新迭代

```
POST /projects/:name/iterations
```

**请求体**

```json
{
  "force": false // optional, 强制在已有活跃迭代时创建新迭代
}
```

**响应 `201`**

```json
{
  "iteration": 1,
  "projectName": "my-app",
  "projectDir": "/path/to/src",
  "workflowName": "dev",
  "availableRoles": ["coordinator", "architect", "developer", "tester"],
  "nextAction": "..."
}
```

### 2.2 开始补丁

```
POST /projects/:name/patches
```

**请求体**

```json
{
  "description": "修复登录超时问题", // optional
  "issueId": "issue-3" // optional, 关联的 issue
}
```

**响应 `201`**

```json
{
  "patchNumber": 1,
  "projectName": "my-app",
  "projectDir": "/path/to/src",
  "workflowName": "dev",
  "description": "修复登录超时问题",
  "issueId": "issue-3",
  "nextAction": "..."
}
```

---

## 3. 任务

> Agent 被分发 task，完成后通过 complete 端点通知引擎推进工作流。

### 3.1 完成任务

```
POST /projects/:name/tasks/:taskId/complete
```

**语义**：Agent 声明当前 task 已完成（产出物已写入、用户确认已完成）。引擎收到后推进到下一个节点。

**请求体**（可选）

```json
{
  "result": {} // optional, 任务产出摘要（透传给引擎）
}
```

**响应 `200`**

```json
{
  "taskId": "clarify",
  "status": "completed",
  "nextAction": {
    "type": "wait",
    "instructions": "Waiting for prd-gate evaluation..."
  }
}
```

**错误情况**

| HTTP  | 场景                                 |
| ----- | ------------------------------------ |
| `404` | taskId 不存在                        |
| `409` | task 非 active 状态（已完成/未开始） |
| `400` | taskId 对应的不是 task 类型节点      |

### 3.2 报告任务失败

```
POST /projects/:name/tasks/:taskId/fail
```

**请求体**

```json
{
  "error": "无法连接数据库，需求分析中断"
}
```

**响应 `200`**

```json
{
  "taskId": "clarify",
  "status": "failed",
  "nextAction": {
    "type": "dispatch",
    "taskId": "clarify",
    "role": "coordinator",
    "instructions": "Retrying clarify..."
  }
}
```

### 3.3 结束循环

```
POST /projects/:name/tasks/:taskId/loop-done
```

当 task 在 loop 节点内执行时，agent 调用此端点声明循环可以结束。

**请求体**：无

**响应 `200`**

```json
{
  "taskId": "develop-batch",
  "loopDone": true,
  "message": "Loop marked for termination. Current iteration will complete."
}
```

---

## 4. 产出物

### 4.1 列出产出物

```
GET /projects/:name/artifacts
```

**查询参数**

| 参数        | 类型   | 说明                              |
| ----------- | ------ | --------------------------------- |
| `iteration` | number | 指定迭代编号，默认当前活跃        |
| `patch`     | number | 指定补丁编号（与 iteration 互斥） |

**响应 `200`**

```json
{
  "context": "iter-1",
  "artifacts": [
    {
      "artifactId": "prd",
      "name": "需求文档",
      "format": "md",
      "review": true,
      "exists": true,
      "reviewStatus": "approved"
    }
  ]
}
```

### 4.2 读取产出物

```
GET /projects/:name/artifacts/:artifactId
```

**查询参数**

| 参数        | 类型   | 说明                             |
| ----------- | ------ | -------------------------------- |
| `iteration` | number | 指定迭代编号                     |
| `patch`     | number | 指定补丁编号                     |
| `step`      | string | 读取特定步骤的产出（分步产出物） |

**响应 `200`**

```json
{
  "artifactId": "prd",
  "content": "# PRD\n\n..."
}
```

分步读取时：

```json
{
  "artifactId": "prd",
  "stepId": "requirements",
  "format": "json",
  "content": { ... },
  "path": "/path/to/step/file"
}
```

### 4.3 审批产出物

```
POST /projects/:name/artifacts/:artifactId/approve
```

**请求体**

```json
{
  "approved": true, // required
  "comment": "LGTM" // optional
}
```

**响应 `200`**

```json
{
  "artifactId": "prd",
  "approved": true,
  "comment": "LGTM",
  "nextAction": "Gate \"prd-gate\" passed. Activating task \"prototype\"."
}
```

### 4.4 获取产出物 Schema

```
GET /projects/:name/artifacts/:artifactId/schema
```

**查询参数**

| 参数   | 类型   | 说明                  |
| ------ | ------ | --------------------- |
| `step` | string | 获取特定步骤的 schema |

**响应 `200`**

```json
{
  "artifactId": "prd",
  "schema": "## Schema Guidance\n\nPRD 必须包含以下章节：..."
}
```

### 4.5 完成分步产出物的步骤

```
POST /projects/:name/artifacts/:artifactId/steps/:stepId/complete
```

**请求体**

```json
{
  "path": "/path/to/step/output" // optional, 自动推断可省略
}
```

**响应 `200`**

```json
{
  "success": true,
  "artifactId": "prd",
  "stepId": "requirements",
  "completedAt": "2026-03-28T10:30:00.000Z",
  "progress": {
    "completedSteps": [{ "stepId": "requirements", "stepName": "需求结构化" }],
    "totalSteps": 3,
    "nextStep": {
      "id": "completeness-check",
      "name": "完整性校验",
      "format": "json",
      "description": "检查需求覆盖率、遗漏项、冲突项",
      "outputPath": "/path/to/output"
    }
  }
}
```

---

## 5. 审批

### 5.1 列出待审批项

```
GET /projects/:name/reviews
```

**响应 `200`**

```json
{
  "reviews": [
    {
      "artifactId": "prd",
      "status": "pending",
      "submittedAt": "2026-03-28T10:00:00.000Z"
    }
  ]
}
```

---

## 6. 问题跟踪

### 6.1 列出问题

```
GET /projects/:name/issues
```

**查询参数**

| 参数        | 类型                      | 说明       |
| ----------- | ------------------------- | ---------- |
| `status`    | `open` \| `closed`        | 按状态过滤 |
| `source`    | `test` \| `user-feedback` | 按来源过滤 |
| `iteration` | number                    | 按迭代过滤 |

**响应 `200`**

```json
{
  "issues": [
    {
      "id": "issue-1",
      "title": "登录超时",
      "description": "...",
      "source": "user-feedback",
      "iteration": 1,
      "status": "open",
      "createdAt": "2026-03-28T10:00:00.000Z"
    }
  ]
}
```

### 6.2 创建问题

```
POST /projects/:name/issues
```

**请求体**

```json
{
  "title": "登录超时", // required
  "description": "用户反馈...", // required
  "source": "user-feedback", // required: "test" | "user-feedback"
  "iteration": 1 // required
}
```

**响应 `201`**

```json
{
  "id": "issue-1",
  "title": "登录超时",
  "description": "用户反馈...",
  "source": "user-feedback",
  "iteration": 1,
  "status": "open",
  "createdAt": "2026-03-28T10:00:00.000Z"
}
```

### 6.3 更新问题

```
PATCH /projects/:name/issues/:issueId
```

**请求体**

```json
{
  "status": "closed",
  "resolvedByType": "patch",
  "resolvedByNumber": 1
}
```

**响应 `200`**

```json
{
  "id": "issue-1",
  "title": "登录超时",
  "status": "closed",
  "resolvedBy": { "type": "patch", "number": 1 },
  "closedAt": "2026-03-28T11:00:00.000Z"
}
```

---

## 7. Agent 连接

### 7.1 注册 Agent

```
POST /projects/:name/agents/connect
```

**请求体**

```json
{
  "agentType": "claude-code", // required
  "sessionId": "ses-123", // optional
  "role": "coordinator", // optional, 默认用 agentType
  "timeout": 300, // optional
  "cwd": "/path/to/project" // optional
}
```

**响应 `200`**

```json
{
  "connected": true,
  "key": "coordinator",
  "agentType": "claude-code",
  "project": "my-app"
}
```

### 7.2 断开 Agent

```
DELETE /projects/:name/agents/:key
```

**响应 `200`**

```json
{
  "disconnected": true,
  "key": "coordinator",
  "project": "my-app"
}
```

---

## 8. 典型交互流程

以 dev 工作流的 clarify → PRD → prototype 为例：

```
┌────────┐         ┌─────────┐         ┌──────────┐
│ Agent  │         │ Harmonia│         │   User   │
└───┬────┘         └────┬────┘         └────┬─────┘
    │  POST /iterations    │                 │
    │ ──────────────────>  │                 │
    │  201 { nextAction: dispatch clarify }  │
    │ <──────────────────  │                 │
    │                      │                 │
    │  GET /status         │                 │
    │ ──────────────────>  │                 │
    │  { activeTaskId: "clarify",            │
    │    nextAction: "Dispatch coordinator"} │
    │ <──────────────────  │                 │
    │                      │                 │
    │  [Agent 澄清需求，分步写 PRD]          │
    │  POST /artifacts/prd/steps/requirements/complete
    │ ──────────────────>  │                 │
    │  POST /artifacts/prd/steps/completeness-check/complete
    │ ──────────────────>  │                 │
    │  POST /artifacts/prd/steps/draft/complete
    │ ──────────────────>  │                 │
    │                      │                 │
    │  [用户在 Agent 会话中确认 PRD]         │
    │  POST /artifacts/prd/approve           │
    │ ──────────────────>  │                 │
    │                      │                 │
    │  POST /tasks/clarify/complete          │
    │ ──────────────────>  │                 │
    │  { nextAction: "activate prototype" }  │
    │ <──────────────────  │                 │
    │                      │                 │
    │  GET /status         │                 │
    │ ──────────────────>  │                 │
    │  { activeTaskId: "prototype", ... }    │
    │ <──────────────────  │                 │
```
