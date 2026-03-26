# Starting a New Iteration

Use this when the project is already registered and the current iteration's workflow is complete (or you want to force-start a new one).

## 1. Start the iteration

```bash
curl -X POST http://127.0.0.1:4600/api/projects/{project}/iterations \
  -H "Content-Type: application/json" -d '{}'
```

| Param   | Type    | Required | Description                                             |
| ------- | ------- | -------- | ------------------------------------------------------- |
| `force` | boolean | no       | Force start even if the current iteration is incomplete |

If the current iteration has unfinished nodes, the request fails unless `force: true` is set.

## 2. Connect (if not already connected)

```bash
curl -X POST http://127.0.0.1:4600/api/connect \
  -H "Content-Type: application/json" \
  -d '{"project_name": "{project}", "agent": "{agent_type}", "role": "{role}"}'
```

| Param          | Type   | Required | Description                                                             |
| -------------- | ------ | -------- | ----------------------------------------------------------------------- |
| `project_name` | string | yes      | Project to connect to                                                   |
| `agent`        | string | yes      | Agent type: `opencode`, `claude-code`, `openclaw`, `codex`              |
| `role`         | string | no       | Workflow role (e.g. `coordinator`, `developer`). Defaults to agent type |

Skip this step if your session is already connected from the previous iteration.

## 3. Check status

```bash
curl http://127.0.0.1:4600/api/projects/{project}/status
```

The `nextAction` field tells you what the new iteration's workflow expects next.
