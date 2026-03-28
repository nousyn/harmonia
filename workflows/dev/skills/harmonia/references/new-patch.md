# New Patch (Hotfix)

Complete workflow for starting a hotfix iteration in an existing project.

## Contents

- [When to Use](#when-to-use)
- [Step 1: Start Patch](#step-1-start-patch)
- [Step 2: Check Status](#step-2-check-status)
- [Step 3: Execute Hotfix](#step-3-execute-hotfix)
- [Patch vs Iteration](#patch-vs-iteration)
- [Troubleshooting](#troubleshooting)

---

## When to Use

Use hotfix workflow when:

- **Bug fix needed**: "Fix this bug", "Hotfix needed", "Emergency patch"
- **Quick fix**: Small, targeted fix without full iteration
- **Issue-driven**: Fixing a specific reported issue
- **User says**: "做热修复"、"修 bug"、"hotfix"

**Do NOT use for**:

- New feature development → Use [new-iteration.md](new-iteration.md)
- Major refactoring → Use full iteration
- Unclear scope → Clarify scope first

---

## Step 1: Start Patch

Initialize a hotfix iteration for the project.

```bash
curl -X POST http://127.0.0.1:4600/projects/{project_name}/patches \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Fix: {brief description of bug or issue}",
    "issue_id": "{issue_id}"
  }'
```

### Parameters

| Parameter     | Type   | Required | Description                                  |
| ------------- | ------ | -------- | -------------------------------------------- |
| `description` | string | yes      | Brief description of the bug or issue to fix |
| `issue_id`    | string | no       | Link to existing issue (if applicable)       |

### Response

**Success (201)**:

```json
{
  "project_name": "{project_name}",
  "iteration": "patch-1",
  "type": "patch",
  "status": "active",
  "description": "Fix: {description provided}",
  "created_at": "2026-03-27T12:00:00Z",
  "workflow": "dev"
}
```

**Project not found (404)**:

```json
{
  "error": "ProjectNotFound",
  "message": "Project '{project_name}' not registered."
}
```

### What This Does

This step:

1. Creates patch directory: `patch-{N}/`
2. Initializes `state.json` with pending node states
3. Links to `issue_id` (if provided) for tracking
4. Activates hotfix workflow node (typically coding → testing)
5. Returns initial `nextAction` indicating first task

### Next Step

Proceed to Step 2.

---

## Step 2: Check Status

Check current workflow status to understand what to do next.

```bash
curl http://127.0.0.1:4600/projects/{project_name}/status?patch=1
```

**Note**: The `patch=N` query parameter ensures you're looking at the correct patch iteration.

### Response Structure

```json
{
  "project_name": "{project_name}",
  "workflow": "dev",
  "iteration": "patch-1",
  "type": "patch",
  "description": "Fix: {original description}",
  "activeTaskId": "hotfix-coding",
  "nextAction": {
    "type": "dispatch",
    "nodeId": "hotfix-coding",
    "role": "developer",
    "instructions": "Fix the described bug",
    "rolePrompt": "[Full prompt with bug context]"
  },
  "workflowState": {
    "nodes": {
      "hotfix-coding": {
        "id": "hotfix-coding",
        "status": "active",
        "retryCount": 0
      }
    }
  }
}
```

### Interpreting nextAction

| nextAction.type    | Meaning                | Action                               |
| ------------------ | ---------------------- | ------------------------------------ |
| `dispatch`         | Coding task ready      | Wait for Harmonia to dispatch        |
| `write_artifact`   | Fix description needed | Write fix description artifact       |
| `approve_artifact` | Fix awaits review      | Prompt user for approval             |
| `wait`             | Task in progress       | Wait and periodically check status   |
| `completed`        | Patch done             | Celebrate; consider linking to issue |

### Next Step

Based on `nextAction`, proceed to Step 3.

---

## Step 3: Execute Hotfix

Follow the hotfix workflow by executing the active task.

### When nextAction = dispatch (Coding)

1. **Receive task** — Agent receives `rolePrompt` with bug context
2. **Analyze bug** — Understand issue from description and linked issue
3. **Implement fix** — Write code to fix the bug
4. **Write fix artifact** — Document the fix in `hotfix.md` or similar
5. **Complete task** — Report completion

### When nextAction = write_artifact

1. **Query schema**:
   ```bash
   curl http://127.0.0.1:4600/projects/{project_name}/artifacts/{artifact_id}/schema
   ```
2. **Write fix description** — Document the bug and fix approach
3. **Implement fix** — Write code changes
4. **Await validation** — Harmonia validates automatically

### When nextAction = approve_artifact

Hotfix approval process:

1. **Check pending reviews**: `GET /projects/{project_name}/reviews?patch=1`
2. **Prompt user**: Present the fix for review
3. **Submit decision**:
   ```bash
   curl -X POST /projects/{project_name}/artifacts/{artifact_id}/approve \
     -H "Content-Type: application/json" \
     -d '{"approved": true, "comment": "Bug fixed and tested."}'
   ```
4. **Link to issue** (if `issue_id` was provided): Update issue as resolved:
   ```bash
   curl -X PATCH /projects/{project_name}/issues/{issue_id} \
     -H "Content-Type: application/json" \
     -d '{"status": "closed", "resolvedByType": "patch", "resolvedByNumber": 1}'
   ```

---

## Patch vs Iteration

| Aspect            | Hotfix (Patch)                           | Regular Iteration                                 |
| ----------------- | ---------------------------------------- | ------------------------------------------------- |
| **Scope**         | Single bug/issue fix                     | Full feature cycle                                |
| **Duration**      | Short, focused                           | Longer, comprehensive                             |
| **Workflow**      | Direct path to fix                       | Complete requirements → design → coding → testing |
| **Tracking**      | Often linked to `issue_id`               | Independent delivery                              |
| **Entry point**   | `hotfix-coding` or `hotfix-testing` node | `collect-requirements` → ...                      |
| **Context param** | `?context=patch-N`                       | `?context=iter-N`                                 |

---

## Troubleshooting

### Common Patch Issues

| Issue                   | Symptom                        | Solution                                     |
| ----------------------- | ------------------------------ | -------------------------------------------- |
| Patch won't start       | Error from `/patches` endpoint | Check `issue_id` exists if provided          |
| Bug not reproducible    | Fix doesn't solve issue        | Verify bug description, add logging          |
| Fix breaks other things | Regression introduced          | Add testing scope, check other functionality |
| Agent not responding    | Task stuck                     | Check agent connection status                |

### Status Check Pattern

Always verify status with correct context:

```bash
# For patch iteration
curl http://127.0.0.1:4600/projects/{project_name}/status?patch=1

# For specific patch artifacts
curl http://127.0.0.1:4600/projects/{project_name}/artifacts/{id}?patch=1
```

---

## Quality Checklist

Before considering patch complete:

- [ ] Bug is clearly understood and documented
- [ ] Fix is implemented and tested
- [ ] Fix doesn't introduce regressions
- [ ] Fix approved (if review required)
- [ ] Linked issue resolved (if applicable)

---

## After Patch Complete

Once patch reaches `nextAction = completed`:

1. **Verify fix** — Confirm bug is resolved
2. **Update issue** — Mark related issue as closed (if linked)
3. **Continue development** — User may request:
   - "New iteration" → Follow [new-iteration.md](new-iteration.md)
   - "Another hotfix" → Follow this guide again
4. **Archive patch** — Mark as complete in project records

---

## Reference Links

- [Workflow States](workflow-states.md) — Complete state machine
- [Output Formats](output-formats.md) — Artifact schema definitions
- [Artifact Writing](artifact-writing.md) — Detailed writing protocol
- [Review Flow](review-flow.md) — Approval and rejection handling
- [Error Handling](error-handling.md) — Degradation strategies
