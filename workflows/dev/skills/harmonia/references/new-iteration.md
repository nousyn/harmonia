# New Iteration

Complete workflow for starting a new iteration in an existing project.

## Contents

- [Prerequisites](#prerequisites)
- [Step 1: Start Iteration](#step-1-start-iteration)
- [Step 2: Check Status](#step-2-check-status)
- [Step 3: Execute Active Task](#step-3-execute-active-task)
- [Iteration Lifecycle](#iteration-lifecycle)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before starting a new iteration:

1. **Project exists**: Project must be registered with Harmonia
2. **Agents connected**: Required agents should be connected (coordinator at minimum)
3. **Previous iteration complete**: If previous iteration is still active, consider forcing or completing it first

**Check agents connected**:

```bash
curl http://127.0.0.1:4600/projects/{project_name}/status
```

Look at `connectedAgents` in response to verify.

---

## Step 1: Start Iteration

Initialize a new iteration for the project.

```bash
curl -X POST http://127.0.0.1:4600/projects/{project_name}/iterations \
  -H "Content-Type: application/json" \
  -d '{
    "force": false
  }'
```

### Optional Parameters

| Parameter | Type    | Default | Description                                                   |
| --------- | ------- | ------- | ------------------------------------------------------------- |
| `force`   | boolean | false   | Force start new iteration even if current iteration is active |

### Response

**Success (201)**:

```json
{
  "iteration": 2,
  "projectName": "{project_name}",
  "projectDir": "/path/to/project",
  "workflowName": "dev",
  "availableRoles": ["coordinator", "architect", "developer", "reviewer"],
  "nextAction": "Workflow started. Active node: collect-requirements (task, coordinator)"
}
```

**Iteration already active (without force)**:

```json
{
  "error": "迭代 1 仍在进行中。使用 force=true 强制开始新迭代。"
}
```

### What This Does

This step:

1. Creates new iteration directory: `iter-{N}/`
2. Initializes `state.json` with fresh node states (all pending)
3. Resets iteration-specific state (reviews, dispatches, sessions)
4. Activates the first workflow node
5. Returns initial `nextAction` indicating first task

### Next Step

Proceed to Step 2.

---

## Step 2: Check Status

Check the current workflow status to understand what to do next.

```bash
curl http://127.0.0.1:4600/projects/{project_name}/status
```

### Response Structure

```json
{
  "projectName": "my-app",
  "projectDir": "/path/to/project",
  "workflow": "dev",
  "activeContext": "iter-2",
  "contextType": "iteration",
  "contextNumber": 2,
  "currentIteration": 2,
  "totalIterations": 2,
  "currentPatch": 0,
  "totalPatches": 0,
  "activeNodeId": "collect-requirements",
  "createdAt": "2026-03-27T12:00:00Z",
  "updatedAt": "2026-03-28T08:30:00Z",
  "treeLines": ["● collect-requirements (task, coordinator) — active", "  ○ write-prd (task, coordinator) — pending"],
  "artifactIds": [],
  "artifactDefs": { "prd": { "name": "PRD", "format": "md", "review": true } },
  "reviews": {},
  "stepsData": {},
  "dispatches": [],
  "sessions": [],
  "issues": [],
  "nextAction": "Active: collect-requirements (task, coordinator). Next: dispatch to coordinator role.",
  "stepGuidance": {
    "artifactId": "prd",
    "artifactName": "PRD",
    "completedSteps": [],
    "totalSteps": 3,
    "nextStep": {
      "id": "requirements",
      "name": "Requirements",
      "format": "json",
      "description": "将需求整理为结构化 JSON",
      "outputPath": "/path/to/prd.requirements.json"
    },
    "progressText": "[ ] Requirements → [ ] Completeness Check → [ ] Draft",
    "finalPath": "/path/to/prd.md",
    "finalized": false
  },
  "stepGuidances": [{ "artifactId": "prd", "completedSteps": [], "totalSteps": 3, "nextStep": { "...": "..." } }]
}
```

### Interpreting stepGuidance

When `stepGuidance` is present, the agent should follow the stepped artifact workflow:

1. **`nextStep`** — the step to write next (null if all done)
2. **`progressText`** — quick status summary (e.g. `[✓] Analysis → [→] Research → [ ] Draft`)
3. **`completedSteps[]`** — previously done steps with file paths (agent can read these for context)
4. **`stepGuidances[]`** — when multiple stepped artifacts are in progress (e.g., parallel node)

See [artifact-writing.md](artifact-writing.md#stepped-artifacts) for the full stepped artifact workflow.

### Interpreting nextAction

Follow the guidance in [workflow-states.md](workflow-states.md):

| nextAction.type    | Meaning          | Action                                                 |
| ------------------ | ---------------- | ------------------------------------------------------ |
| `dispatch`         | Task ready       | Wait for Harmonia to dispatch; agent will receive task |
| `write_artifact`   | Artifact needed  | Query schema and write artifact                        |
| `approve_artifact` | Awaiting review  | Prompt user for approval                               |
| `wait`             | Task in progress | Wait and periodically check status                     |
| `completed`        | Iteration done   | Celebrate; user may request new iteration              |
| `failed`           | Error occurred   | Check error details and propose recovery               |

### Next Step

Based on `nextAction`, proceed to Step 3.

---

## Step 3: Execute Active Task

Follow the workflow by executing the active task.

### When nextAction = dispatch

1. **Wait for Harmonia dispatch** — Harmonia sends task to the connected agent
2. **Receive task** — Agent receives the `rolePrompt` with full context
3. **Execute task** — Follow prompt instructions:
   - Read input artifacts (if any)
   - Perform the work
   - Write output artifacts (if any)
4. **Complete task** — Report completion or error

### When nextAction = write_artifact

1. **Query schema first**:
   ```bash
   curl http://127.0.0.1:4600/projects/{project_name}/artifacts/{artifact_id}/schema
   ```
2. **Follow output format** — See [output-formats.md](output-formats.md) for schema details
3. **Write to provided path** — Use the exact path from the dispatch prompt
4. **Await validation** — Harmonia will validate automatically

**Stepped Artifacts**: Some artifacts (like `prd`, `tech-design`) have intermediate steps. The status response's `stepGuidance` field tells the agent which step to do next:

1. **Check `stepGuidance`** in the status response:
   - `nextStep.id` → which step to write
   - `nextStep.outputPath` → where to write it
   - `progressText` → current progress summary
2. **Query schema for the step**:
   ```bash
   curl http://127.0.0.1:4600/projects/{project_name}/artifacts/{artifact_id}/schema?step={step_id}
   ```
3. **Write the step file** to the path from `stepGuidance.nextStep.outputPath`
4. **Notify completion**:
   ```bash
   curl -X POST http://127.0.0.1:4600/projects/{project_name}/artifacts/{artifact_id}/steps/{step_id}/complete \
     -H "Content-Type: application/json" \
     -d '{}'
   ```
5. **Repeat** for each step until all done, then write the final artifact

> **Recovery**: If the agent disconnects, Harmonia auto-detects completed step files on reconnect. Just call `GET /status` and follow the updated `stepGuidance`.

See [artifact-writing.md](artifact-writing.md) for detailed writing protocol.

### When nextAction = approve_artifact

1. **Check pending reviews**:
   ```bash
   curl http://127.0.0.1:4600/projects/{project_name}/reviews
   ```
2. **Prompt user for decision** — Present the artifact and ask: "Approve or reject?"
3. **Submit decision**:
   ```bash
   curl -X POST http://127.0.0.1:4600/projects/{project_name}/artifacts/{artifact_id}/approve \
     -H "Content-Type: application/json" \
     -d '{
       "approved": true,
       "comment": "Looks good, proceed."
     }'
   ```
4. **Continue workflow** — After approval, check status for next `nextAction`

### When nextAction = wait

1. **Task is in progress** — Another agent is working
2. **Wait and monitor** — Check status periodically (every 1-2 minutes)
3. **When status changes** — Follow the new `nextAction`

### When nextAction = evaluate_gate

1. **Automatic check** — Gate conditions are evaluated by Harmonia
2. **No action needed** — Wait for gate result
3. **Check status again** — After brief wait, status will show new `nextAction`

---

## Iteration Lifecycle

A complete iteration follows this progression:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ collect-requirements → write-prd → review-prd → approve-prd     │
│                      ↓                                           │
│ tech-design → write-tech-design → review-tech-design → approve-tech-design
│                      ↓                                           │
│ api-design → write-api-design → review-api-design → approve-api-design
│                      ↓                                           │
│ data-model → write-data-model → review-data-model → approve-data-model
│                      ↓                                           │
│ task-breakdown → coding → testing → test-report → delivery      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Stage Types

| Stage Type   | Description                 | Example Artifacts                         |
| ------------ | --------------------------- | ----------------------------------------- |
| Requirements | Understanding user needs    | `prd`                                     |
| Design       | Planning technical approach | `tech-design`, `api-design`, `data-model` |
| Planning     | Breaking down tasks         | `task-breakdown`, `test-plan`             |
| Execution    | Coding and testing          | Code files, `test-report`                 |
| Review       | Quality checks              | Review comments                           |

### Gate Points

The workflow has approval gates at critical points:

- **PRD review** — `review-prd` → `approve-prd` gate
- **Tech design review** — `review-tech-design` → `approve-tech-design` gate
- **API design review** — `review-api-design` → `approve-api-design` gate
- **Test approval** — `test-report` → `delivery` gate

When `nextAction = approve_artifact`, an artifact is awaiting user decision:

- **Approve** → Workflow continues to next stage
- **Reject** → Author revises and resubmits artifact

See [review-flow.md](review-flow.md) for detailed approval process.

---

## Troubleshooting

### Common Iteration Issues

| Issue                        | Symptom                               | Solution                                               |
| ---------------------------- | ------------------------------------- | ------------------------------------------------------ |
| Agents not connected         | `connectedAgents` empty               | Connect agents first: `POST /connect`                  |
| Task stuck in dispatch       | `nextAction = dispatch` for long time | Check agent status, ensure agent is running            |
| Artifact rejected repeatedly | Multiple rejects                      | Gather user feedback, revise approach                  |
| Gate won't pass              | `evaluate_gate` persists              | Check what condition is failing, fix blocking artifact |

### Status Check Pattern

Whenever unsure, check status:

```bash
curl http://127.0.0.1:4600/projects/{project_name}/status
```

### Iteration Recovery

If iteration is stuck or corrupted:

1. **Force new iteration**:
   ```bash
   curl -X POST http://127.0.0.1:4600/projects/{project_name}/iterations \
     -H "Content-Type: application/json" \
     -d '{"force": true}'
   ```
2. **Start hotfix** if urgent bug fix needed — See [new-patch.md](new-patch.md)

---

## Quality Checklist

Before considering iteration complete:

- [ ] All stages executed (requirements → design → planning → execution)
- [ ] All artifacts written and validated
- [ ] All approval gates passed
- [ ] Testing completed (if in scope)
- [ ] Ready for delivery

---

## After Iteration Complete

Once iteration reaches `nextAction = completed`:

1. **Celebrate success** — Iteration delivered successfully!
2. **Continue development** — User may request:
   - "New iteration" → Follow this guide again
   - "Hotfix" → See [new-patch.md](new-patch.md)
3. **Archive if desired** — Mark iteration as complete in project records

---

## Reference Links

- [Workflow States](workflow-states.md) — Complete state machine
- [Output Formats](output-formats.md) — Artifact schema definitions
- [Artifact Writing](artifact-writing.md) — Detailed writing protocol
- [Review Flow](review-flow.md) — Approval and rejection handling
- [Error Handling](error-handling.md) — Degradation strategies
