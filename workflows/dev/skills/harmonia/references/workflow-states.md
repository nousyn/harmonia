# Workflow States

Complete state machine documentation for Harmonia workflow.

## Contents

- [State Machine Overview](#state-machine-overview)
- [State Definitions](#state-definitions)
- [State Transitions](#state-transitions)
- [Action Flow](#action-flow)

---

## State Machine Overview

Harmonia workflow is a state machine driven by `nextAction` field. The current state tells you exactly what to do next.

```
                              +------------------+
                              |  pending (项目   |
                              |   未初始化)       |
                              +---------+----------+
                                        |
                                        | 初始化项目
                                        v
                              +---------+----------+
                              |  active (激活中) |
                              |                 |
                              +-----------------+
                                        |
                     +-------------+-------------+-------------+
                     |             |             |             |
            nextAction    |             |             |
            = dispatch   v             v             v
        +------------------+    +------------------+    +------------------+
        | write_artifact  |    | approve_artifact |    | evaluate_gate   |
        |                 |    |                 |    |                |
        |                 |    |                 |    |                |
        v                 v    v                 v    v                v
   +----------+    +----------+    +----------+    +----------+
   | completed |    | failed    |    | wait     |    |         |
   |           |    |           |    |          |    |         |
   +-----------+    +-----------+    +----------+    +---------+
```

---

## State Definitions

### pending (项目未初始化)

**Description**: Project registered but no iteration started.

**When you see**: No `nextAction` or workflow not yet started.

**Your action**: Follow `{baseDir}/references/new-project.md` to initialize first iteration.

---

### active (激活中)

**Description**: Workflow is running, tasks are being executed.

**Possible nextActions**:

| nextAction         | Meaning                | Your Action                                            |
| ------------------ | ---------------------- | ------------------------------------------------------ |
| `dispatch`         | Task ready to assign   | Wait for Harmonia to dispatch; agent will receive task |
| `write_artifact`   | Artifact needed        | Write the artifact (see `artifact-writing.md`)         |
| `approve_artifact` | Artifact awaits review | Prompt user for approval decision                      |
| `evaluate_gate`    | Gate check in progress | No action needed, automatic                            |
| `wait`             | Task executing         | Wait for completion, check status periodically         |

---

### completed (已完成)

**Description**: All workflow tasks finished successfully.

**When you see**: `nextAction.type = "completed"`

**Your action**:

1. Celebrate success!
2. If user wants to continue: "Start a new iteration" → follow `{baseDir}/references/new-iteration.md`
3. If user wants changes: "Start a hotfix" → follow `{baseDir}/references/new-patch.md`

---

### failed (失败)

**Description**: Workflow encountered an error that prevented completion.

**When you see**: `nextAction.type = "failed"`

**Your action**:

1. Check status response for error details
2. Diagnose root cause
3. Propose recovery path:
   - "Retry the failed task"
   - "Start a hotfix" → follow `{baseDir}/references/new-patch.md`
   - "Modify and resubmit the problematic artifact"

---

## State Transitions

### Transition Rules

| From State  | Trigger              | To State    | Condition                                   |
| ----------- | -------------------- | ----------- | ------------------------------------------- |
| `pending`   | Initialize iteration | `active`    | User says "start project" / "new iteration" |
| `active`    | Task completes       | `active`    | Check status for nextAction                 |
| `active`    | All tasks done       | `completed` | No more pending tasks                       |
| `active`    | Critical error       | `failed`    | Unrecoverable error                         |
| `completed` | Start iteration      | `active`    | User requests new iteration                 |
| `completed` | Start patch          | `active`    | User requests hotfix                        |
| `failed`    | Retry/fix            | `active`    | User initiates recovery                     |

### Gate Evaluation

`evaluate_gate` is an intermediate state where Harmonia checks conditions:

**Gate types**:

- `artifact_exists`: Check if required artifact exists
- `artifact_approved`: Check if artifact has user approval
- `artifact_field`: Check specific field value in artifact

**Your action during gate**:

- Wait for automatic evaluation
- Gate passes: workflow continues to next task
- Gate fails: workflow follows fail path or waits

---

## Action Flow

### dispatch Action Flow

```
1. Agent checks status → nextAction = "dispatch"
2. Harmonia dispatches task to agent
3. Agent receives task with full prompt
4. Agent executes task
5. Agent writes artifacts (if required)
6. Agent reports completion
7. Harmonia validates artifacts
8. Status updates with new nextAction
```

### write_artifact Action Flow

```
1. Agent checks status → nextAction = "write_artifact"
2. Agent queries artifact schema:
   curl /projects/{project}/artifacts/{id}/schema
3. Agent writes artifact to provided path
4. Harmonia validates automatically
5. Status updates with new nextAction
```

### approve_artifact Action Flow

```
1. Agent checks status → nextAction = "approve_artifact"
2. Agent checks pending reviews:
   curl /projects/{project}/reviews
3. Agent prompts user for decision
4. User decides (approve/reject)
5. Agent submits decision:
   curl -X POST /projects/{project}/artifacts/{id}/approve \
     -d '{"approved": true, "comment": "..."}'
6. Status updates with new nextAction
```

### wait Action Flow

```
1. Agent checks status → nextAction = "wait"
2. Task is executing (by another agent)
3. Agent waits and monitors
4. Periodically check status until change
5. When status changes, follow new nextAction
```

---

## Common Patterns

### Always Check Status First

Before any action, always verify current status:

```bash
curl http://127.0.0.1:4600/projects/{project}/status
```

The `nextAction` field is the **source of truth**.

### Context Parameter Rules

Harmonia supports context parameters for filtering workflow scope:

| Parameter | Meaning          | Usage                                                        |
| --------- | ---------------- | ------------------------------------------------------------ |
| `iter-N`  | Iteration filter | Filter to specific iteration (e.g., `iter-1`, `iter-2`)      |
| `patch-N` | Patch filter     | Filter to specific hotfix patch (e.g., `patch-1`, `patch-2`) |

**When to use context parameters:**

1. **Querying artifacts within iteration**: Include context to get iteration-specific artifacts

   ```bash
   curl /projects/{project}/artifacts?context=iter-1
   ```

2. **Checking iteration-specific status**: Focus on one iteration's progress

   ```bash
   curl /projects/{project}/status?context=iter-1
   ```

3. **Hotfix isolation**: Work on specific patch without affecting main iteration
   ```bash
   curl /projects/{project}/status?context=patch-1
   ```

**Behavior without context**: Returns the current active iteration or most recent patch.

**Note**: Context parameters do NOT change workflow state—only filter visibility.

### Parallel Task Handling

When `nextAction.parallelDispatch` is present, multiple tasks execute simultaneously:

**Identifying parallel dispatch:**

```json
{
  "nextAction": {
    "type": "parallelDispatch",
    "tasks": [
      {
        "nodeId": "api-design",
        "role": "architect",
        "status": "pending"
      },
      {
        "nodeId": "data-model",
        "role": "developer",
        "status": "pending"
      }
    ]
  }
}
```

**Parallel task flow:**

```
1. Agent checks status → nextAction = "parallelDispatch"
2. Harmonia dispatches all parallel tasks simultaneously
3. Each agent receives its respective task with full prompt
4. All agents execute tasks independently
5. Each agent reports completion independently
6. Harmonia tracks completion across all parallel tasks
7. When ALL tasks complete → status updates with nextAction
```

**Tracking parallel progress:**

```bash
curl http://127.0.0.1:4600/projects/{project}/status
```

Look for `parallelTasks` section:

```json
{
  "parallelTasks": {
    "api-design": {
      "nodeId": "api-design",
      "role": "architect",
      "status": "completed",
      "completedAt": 1234567890
    },
    "data-model": {
      "nodeId": "data-model",
      "role": "developer",
      "status": "active",
      "startedAt": 1234567890
    }
  }
}
```

**Handling partial completion:**

| Situation                           | Your Action                                              |
| ----------------------------------- | -------------------------------------------------------- |
| Some tasks complete, others running | Wait, do NOT proceed until ALL complete                  |
| One task fails                      | Check if task is critical (blocks others) or independent |
| All tasks complete                  | Check status for next nextAction                         |
| Task timeout                        | Verify agent status, consider retry or escalation        |

**Parallel task completion rules:**

- **AND logic**: All parallel tasks must complete before workflow advances
- **Independent tracking**: Each task's status is tracked separately
- **No interference**: Tasks do not share artifacts unless explicitly designed to
- **Failure handling**: Failed tasks may be retried independently

**Parallel task failure scenarios:**

| Failure Type          | Recovery Strategy                                            |
| --------------------- | ------------------------------------------------------------ |
| Single task failed    | Retry that specific task; other completed tasks remain valid |
| Multiple tasks failed | Review root cause (common dependency?), retry all            |
| All tasks failed      | Full parallel batch restart or workflow rollback             |

### Gate Wait Behavior

When encountering `evaluate_gate`:

- Do NOT attempt to bypass or skip gates
- Gates are workflow controls ensuring correct sequence
- If gate is stuck, check status for diagnostic information

---

## Error States

### Common Error Scenarios

| Scenario                   | nextAction         | Recovery                                   |
| -------------------------- | ------------------ | ------------------------------------------ |
| Agent not connected        | `wait`             | Ensure agent is connected: `POST /connect` |
| Artifact validation failed | `write_artifact`   | Fix schema violations and rewrite          |
| Approval timeout           | `approve_artifact` | Prompt user again for decision             |
| Dispatch failed            | `dispatch`         | Check agent status, retry or escalate      |

---

## Debugging

When workflow seems stuck:

1. Check status: `GET /projects/{project}/status`
2. Look at `activeNodeId`: Which task is stuck?
3. Look at `nodes`: Which nodes are failed/pending?
4. Check `error` fields: Error messages explain why
5. Propose next step based on actual state

---

## Reference Links

- [Output Formats](output-formats.md) — Artifact schema definitions
- [Artifact Writing](artifact-writing.md) — Detailed writing protocol
- [Iteration Cycle](iteration-cycle.md) — Feedback and refinement loop
- [Error Handling](error-handling.md) — Degradation strategies
