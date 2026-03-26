# New Project Setup

Complete these steps in order. Each step depends on the previous one.

## 1. Register the project

```bash
curl -X POST http://127.0.0.1:4600/api/projects \
  -H "Content-Type: application/json" \
  -d '{"project_name": "{project}", "project_dir": "/path/to/project"}'
```

| Param          | Type   | Required | Description                                    |
| -------------- | ------ | -------- | ---------------------------------------------- |
| `project_name` | string | yes      | Project name                                   |
| `project_dir`  | string | yes      | Absolute path to project directory             |
| `workflow`     | string | no       | Workflow name (required if multiple available) |

**Status codes:** `201` created, `200` already registered, `409` multiple workflows — specify `workflow`.

## 2. Start the first iteration

```bash
curl -X POST http://127.0.0.1:4600/api/projects/{project}/iterations \
  -H "Content-Type: application/json" -d '{}'
```

Initializes workflow state and activates the first node.

## 3. Connect

```bash
curl -X POST http://127.0.0.1:4600/api/connect \
  -H "Content-Type: application/json" \
  -d '{"project_name": "{project}", "agent": "{agent_type}", "role": "{role}"}'
```

| Param          | Type   | Required | Description                                                             |
| -------------- | ------ | -------- | ----------------------------------------------------------------------- |
| `project_name` | string | yes      | Project to connect to                                                   |
| `agent`        | string | yes      | Agent type: `opencode`, `claude-code`, `openclaw`, `codex`              |
| `sessionId`    | string | no       | Agent-side session ID                                                   |
| `role`         | string | no       | Workflow role (e.g. `coordinator`, `developer`). Defaults to agent type |

Connecting enables notifications — it does **not** start any task.

## 4. Check status

```bash
curl http://127.0.0.1:4600/api/projects/{project}/status
```

The `nextAction` field tells you what the workflow expects next.
