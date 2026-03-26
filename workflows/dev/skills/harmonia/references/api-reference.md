# Harmonia HTTP API Reference

Base URL: `http://127.0.0.1:4600`

All request bodies use `Content-Type: application/json`. All responses are JSON.

---

## Projects

### GET /projects

List all registered projects.

### POST /projects

Initialize a new project.

```bash
curl -X POST http://127.0.0.1:4600/projects \
  -H "Content-Type: application/json" \
  -d '{"project_name": "my-app", "project_dir": "/path/to/project"}'
```

| Param          | Type   | Required | Description                                    |
| -------------- | ------ | -------- | ---------------------------------------------- |
| `project_name` | string | yes      | Project name                                   |
| `project_dir`  | string | yes      | Absolute path to project directory             |
| `workflow`     | string | no       | Workflow name (required if multiple available) |

**Status codes:** `201` created, `200` already registered, `409` multiple workflows available but `workflow` not specified.

### GET /projects/:name/status

Get project workflow status. The most important endpoint — always start here.

**Response includes:**

- `iteration` — current iteration info
- `nodes` — workflow node tree with states
- `nextAction` — what should happen next:
  - `type`: `dispatch` | `write_artifact` | `approve_artifact` | `evaluate_gate` | `wait` | `completed` | `failed` | `none`
  - `nodeId`: related workflow node
  - `instructions`: human-readable guidance

---

## Artifacts

### GET /projects/:name/artifacts

List project artifacts.

| Query param | Type   | Description              |
| ----------- | ------ | ------------------------ |
| `context`   | string | Iteration context filter |

### GET /projects/:name/artifacts/:id

Read artifact content.

```bash
curl http://127.0.0.1:4600/projects/my-app/artifacts/prd
```

**Response:** `{"artifactId": "prd", "content": "..."}`

### GET /projects/:name/artifacts/:id/schema

Get artifact schema and writing guidance. Query this before writing any artifact.

| Query param | Type   | Description                     |
| ----------- | ------ | ------------------------------- |
| `step`      | string | Step ID (for stepped artifacts) |

**Response:**

- `guidance` — writing instructions (string)
- `sections` — required Markdown sections (for `.md` artifacts)
- `jsonFields` — required JSON fields (for `.json` artifacts)

### POST /projects/:name/artifacts/:id/approve

Approve or reject an artifact.

```bash
# Approve
curl -X POST http://127.0.0.1:4600/projects/my-app/artifacts/prd/approve \
  -H "Content-Type: application/json" \
  -d '{"approved": true, "comment": "Looks good"}'

# Reject
curl -X POST http://127.0.0.1:4600/projects/my-app/artifacts/prd/approve \
  -H "Content-Type: application/json" \
  -d '{"approved": false, "comment": "Missing acceptance criteria"}'
```

| Param      | Type    | Required | Description                        |
| ---------- | ------- | -------- | ---------------------------------- |
| `approved` | boolean | yes      | `true` = approve, `false` = reject |
| `comment`  | string  | no       | Review comment                     |

### GET /projects/:name/reviews

List artifacts pending review.

**Response:** `{"pending": [{"artifactId": "...", "name": "...", ...}]}`

---

## Issues

### GET /projects/:name/issues

List issues with optional filters.

| Query param | Type   | Description                |
| ----------- | ------ | -------------------------- |
| `status`    | string | `open` or `closed`         |
| `source`    | string | `test` or `user-feedback`  |
| `iteration` | number | Filter by iteration number |

### POST /projects/:name/issues

Create an issue.

```bash
curl -X POST http://127.0.0.1:4600/projects/my-app/issues \
  -H "Content-Type: application/json" \
  -d '{"title": "Login fails on empty password", "description": "Steps to reproduce...", "source": "test", "iteration": 1}'
```

| Param         | Type   | Required | Description                      |
| ------------- | ------ | -------- | -------------------------------- |
| `title`       | string | yes      | Issue title                      |
| `description` | string | yes      | Detailed description             |
| `source`      | string | yes      | `test` or `user-feedback`        |
| `iteration`   | number | yes      | Iteration number this belongs to |

### PATCH /projects/:name/issues/:id

Update an issue.

```bash
curl -X PATCH http://127.0.0.1:4600/projects/my-app/issues/abc123 \
  -H "Content-Type: application/json" \
  -d '{"status": "resolved", "resolved_by_type": "commit", "resolved_by_number": "a1b2c3d"}'
```

| Param                | Type   | Required | Description                       |
| -------------------- | ------ | -------- | --------------------------------- |
| `status`             | string | no       | `open` or `resolved`              |
| `resolved_by_type`   | string | no       | Resolution type (e.g. `commit`)   |
| `resolved_by_number` | string | no       | Resolution ref (e.g. commit hash) |

> **Note:** `resolved_by_type` and `resolved_by_number` must be provided together. Do not send a plain `resolvedBy` string — it will be ignored.

---

## Iterations

### POST /projects/:name/iterations

Start a new iteration.

```bash
curl -X POST http://127.0.0.1:4600/projects/my-app/iterations \
  -H "Content-Type: application/json" \
  -d '{}'
```

| Param   | Type    | Required | Description                            |
| ------- | ------- | -------- | -------------------------------------- |
| `force` | boolean | no       | Force start even if current incomplete |

### POST /projects/:name/patches

Start a hotfix patch.

```bash
curl -X POST http://127.0.0.1:4600/projects/my-app/patches \
  -H "Content-Type: application/json" \
  -d '{"description": "Fix login timeout"}'
```

| Param         | Type   | Required | Description         |
| ------------- | ------ | -------- | ------------------- |
| `description` | string | yes      | Patch description   |
| `issue_id`    | string | no       | Associated issue ID |

---

## Agent Connection

### POST /connect

Register an agent connection.

```bash
curl -X POST http://127.0.0.1:4600/connect \
  -H "Content-Type: application/json" \
  -d '{"project_name": "my-app", "agent": "openclaw", "role": "developer"}'
```

| Param          | Type   | Required | Description                                                |
| -------------- | ------ | -------- | ---------------------------------------------------------- |
| `project_name` | string | yes      | Project to connect to                                      |
| `agent`        | string | yes      | Agent type: `opencode`, `claude-code`, `openclaw`, `codex` |
| `sessionId`    | string | no       | Agent-side session ID                                      |
| `role`         | string | no       | Workflow role override                                     |

**Status codes:** `200` connected, `422` unknown agent type, `501` orchestration not available.

### DELETE /connect/:key

Disconnect an agent.

| Query param    | Type   | Required | Description  |
| -------------- | ------ | -------- | ------------ |
| `project_name` | string | yes      | Project name |

---

## Error Responses

All errors follow this format:

```json
{ "error": "Error description" }
```

| Status | Meaning                                         |
| ------ | ----------------------------------------------- |
| `400`  | Invalid parameters or step prerequisite not met |
| `404`  | Project or resource not found                   |
| `409`  | Workflow selection required                     |
| `422`  | Unknown agent type                              |
| `500`  | Internal server error                           |
| `501`  | Orchestration not available                     |
