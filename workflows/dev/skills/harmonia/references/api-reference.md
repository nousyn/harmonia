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
  -d '{"projectName": "my-app", "projectDir": "/path/to/project"}'
```

| Param         | Type   | Required | Description                                    |
| ------------- | ------ | -------- | ---------------------------------------------- |
| `projectName` | string | yes      | Project name                                   |
| `projectDir`  | string | yes      | Absolute path to project directory             |
| `workflow`    | string | no       | Workflow name (required if multiple available) |

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
- `stepGuidance` — guidance for the active stepped artifact (if applicable):
  - `artifactId`, `artifactName` — which artifact
  - `completedSteps[]` — steps already done (with paths)
  - `nextStep` — next step to complete (`id`, `name`, `format`, `description`, `outputPath`)
  - `progressText` — human-readable progress (e.g. `[✓] Requirements → [→] Completeness Check → [ ] Draft`)
  - `finalPath` — path to the final artifact file
  - `finalized` — whether all steps are done
- `stepGuidances[]` — all in-progress stepped artifacts (same structure as `stepGuidance`)

---

## Artifacts

### GET /projects/:name/artifacts

List project artifacts.

| Query param | Type   | Description              |
| ----------- | ------ | ------------------------ |
| `context`   | string | Iteration context filter |

### GET /projects/:name/artifacts/:id

Read artifact content, or a specific step of a stepped artifact.

```bash
# Read main artifact
curl http://127.0.0.1:4600/projects/my-app/artifacts/prd

# Read a specific step (for stepped artifacts)
curl http://127.0.0.1:4600/projects/my-app/artifacts/prd?step=requirements
```

| Query param | Type   | Description                             |
| ----------- | ------ | --------------------------------------- |
| `step`      | string | Step ID to read (for stepped artifacts) |
| `context`   | string | Iteration context (e.g. `iter-1`)       |

**Response (main):** `{"artifactId": "prd", "content": "..."}`

**Response (step):**

```json
{
  "artifactId": "prd",
  "stepId": "requirements",
  "format": "json",
  "content": "...",
  "path": "/absolute/path/to/prd.requirements.json"
}
```

### POST /projects/:name/artifacts/:id/steps/:stepId/complete

Mark a step as completed. After writing a step file, call this to notify Harmonia.

> **Parameter discovery:** Call `GET /projects/:name/status` first. The response's `stepGuidance.nextStep.id` provides the `stepId`, and `stepGuidance.artifactId` provides the `:id`.

```bash
curl -X POST http://127.0.0.1:4600/projects/my-app/artifacts/prd/steps/requirements/complete \
  -H "Content-Type: application/json" \
  -d '{}'
```

| Param  | Type   | Required | Description                               |
| ------ | ------ | -------- | ----------------------------------------- |
| `path` | string | no       | Step file path (auto-inferred if omitted) |

**Response:**

```json
{
  "success": true,
  "artifactId": "prd",
  "stepId": "requirements",
  "completedAt": "2026-03-28T12:00:00Z",
  "progress": {
    "completedSteps": ["requirements"],
    "totalSteps": 3,
    "nextStep": { "id": "completeness-check", "name": "Completeness Check", "format": "json" }
  }
}
```

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

**Response:** `{"reviews": [{"artifactId": "...", "name": "...", ...}]}`

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
  -d '{"status": "resolved", "resolvedByType": "commit", "resolvedByNumber": "a1b2c3d"}'
```

| Param              | Type   | Required | Description                       |
| ------------------ | ------ | -------- | --------------------------------- |
| `status`           | string | no       | `open` or `resolved`              |
| `resolvedByType`   | string | no       | Resolution type (e.g. `commit`)   |
| `resolvedByNumber` | string | no       | Resolution ref (e.g. commit hash) |

> **Note:** `resolvedByType` and `resolvedByNumber` must be provided together. Do not send a plain `resolvedBy` string — it will be ignored.

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

### POST /projects/:name/agents/connect

Register an agent connection.

```bash
curl -X POST http://127.0.0.1:4600/projects/:name/agents/connect \
  -H "Content-Type: application/json" \
  -d '{"agentType": "openclaw", "role": "developer"}'
```

| Param       | Type   | Required | Description                                                |
| ----------- | ------ | -------- | ---------------------------------------------------------- |
| `agentType` | string | yes      | Agent type: `opencode`, `claude-code`, `openclaw`, `codex` |
| `sessionId` | string | no       | Agent-side session ID                                      |
| `role`      | string | no       | Workflow role override                                     |

**Status codes:** `200` connected, `422` unknown agent type, `501` orchestration not available.

### DELETE /projects/:name/agents/:key

Disconnect an agent.

| Query param | Type | Required | Description |
| ----------- | ---- | -------- | ----------- |

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
