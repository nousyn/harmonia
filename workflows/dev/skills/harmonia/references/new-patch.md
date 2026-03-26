# Starting a Hotfix Patch

Use this when the project is already registered and has at least one completed iteration. A patch targets a specific bug or issue for quick resolution.

## 1. Start the patch

```bash
curl -X POST http://127.0.0.1:4600/api/projects/{project}/patches \
  -H "Content-Type: application/json" \
  -d '{"description": "Fix login timeout", "issue_id": "abc123"}'
```

| Param         | Type   | Required | Description                       |
| ------------- | ------ | -------- | --------------------------------- |
| `description` | string | yes      | What this patch fixes             |
| `issue_id`    | string | no       | Associated issue ID from Harmonia |

**Prerequisite:** The project must have at least one iteration. If not, start an iteration first (see `{baseDir}/references/new-iteration.md`).

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

Skip this step if your session is already connected.

## 3. Check status

```bash
curl http://127.0.0.1:4600/api/projects/{project}/status
```

The `nextAction` field tells you what the patch workflow expects next.
