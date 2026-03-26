# Getting Started with Harmonia

## Determine project state

Check whether the project already exists:

```bash
curl http://127.0.0.1:4600/projects/{project}/status
```

- **Got a response with `nextAction`?** → Project is live. Go to [Connect](#connect).
- **Got 404 or "not registered"?** → Go to [First-time setup](#first-time-setup).

---

## First-time setup

Only needed once per project. These two steps must run **in this order**:

### 1. Register the project

```bash
curl -X POST http://127.0.0.1:4600/projects \
  -H "Content-Type: application/json" \
  -d '{"project_name": "{project}", "project_dir": "/path/to/project"}'
```

| Param          | Type   | Required | Description                                    |
| -------------- | ------ | -------- | ---------------------------------------------- |
| `project_name` | string | yes      | Project name                                   |
| `project_dir`  | string | yes      | Absolute path to project directory             |
| `workflow`     | string | no       | Workflow name (required if multiple available) |

**Status codes:** `201` created, `200` already registered, `409` multiple workflows — specify `workflow`.

### 2. Start the first iteration

```bash
curl -X POST http://127.0.0.1:4600/projects/{project}/iterations \
  -H "Content-Type: application/json" -d '{}'
```

This initializes the workflow state and activates the first node.

Then proceed to [Connect](#connect).

---

## Connect

Every agent session must register with Harmonia. This is the only step needed on every session start.

```bash
curl -X POST http://127.0.0.1:4600/connect \
  -H "Content-Type: application/json" \
  -d '{"project_name": "{project}", "agent": "{agent_type}", "role": "{role}"}'
```

| Param          | Type   | Required | Description                                                             |
| -------------- | ------ | -------- | ----------------------------------------------------------------------- |
| `project_name` | string | yes      | Project to connect to                                                   |
| `agent`        | string | yes      | Agent type: `opencode`, `claude-code`, `openclaw`, `codex`              |
| `sessionId`    | string | no       | Agent-side session ID                                                   |
| `role`         | string | no       | Workflow role (e.g. `coordinator`, `developer`). Defaults to agent type |

Key points:

- Connecting enables Harmonia to send you notifications (e.g. artifact needs review, task failed). It does **not** start any task — tasks are dispatched separately.
- Disconnect when done: `DELETE /connect/{key}?project_name={project}`

After connecting, check status (`GET /projects/{project}/status`) to see what the workflow expects next.
