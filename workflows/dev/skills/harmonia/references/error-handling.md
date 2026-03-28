# Error Handling

Complete error handling and degradation strategies for Harmonia workflows.

## Contents

- [Error Classification](#error-classification)
- [Degradation Strategies](#degration-strategies)
- [Recovery Procedures](#recovery-procedures)
- [Common Error Patterns](#common-error-patterns)
- [Troubleshooting](#troubleshooting)

---

## Error Classification

### HTTP Errors

| Status Code | Type          | Description                                           |
| ----------- | ------------- | ----------------------------------------------------- |
| 400         | Bad Request   | Invalid parameters or malformed request               |
| 404         | Not Found     | Project or resource not found                         |
| 409         | Conflict      | Workflow selection required, iteration already exists |
| 422         | Unprocessable | Unknown agent type, invalid operation                 |
| 500         | Server Error  | Internal Harmonia error                               |

### Harmonia-Specific Errors

| Error Code                  | Description                                     | User Action                     |
| --------------------------- | ----------------------------------------------- | ------------------------------- |
| `WorkflowSelectionRequired` | Multiple workflows available                    | Specify which workflow to use   |
| `IterationAlreadyActive`    | Current iteration still active                  | Use `force=true` to override    |
| `ArtifactAlreadyApproved`   | Attempting to approve already approved artifact | Cannot change status            |
| `ValidationError`           | Artifact doesn't match schema                   | Fix schema violations           |
| `AgentUnreachable`          | Connected agent not responding                  | Check agent status or reconnect |

---

## Degradation Strategies

### Level 1: Simplify Parameters

**When**: Command or API call fails with complexity-related error.

| Scenario             | Degradation                            | Example                                                                                                       |
| -------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Prompt too complex   | Reduce prompt length, simplify wording | "Generate a poster" vs "Create a marketing poster for social media campaign targeting young professionals..." |
| Too many constraints | Relax non-critical constraints         | Remove optional filters                                                                                       |
| Ambiguous parameters | Use default values                     | Omit optional `context` parameter                                                                             |

### Level 2: Retry with Timeout Extension

**When**: Operation times out or agent unresponsive.

| Scenario             | Degradation                              | Example                           |
| -------------------- | ---------------------------------------- | --------------------------------- |
| Dispatch timeout     | Increase timeout value                   | Extend from default 5min to 10min |
| Agent not responding | Check agent status, optionally reconnect | Verify agent is still running     |
| Operation slow       | Wait longer before timeout               | Extend wait time                  |

### Level 3: Alternative Method

**When**: Primary method fails repeatedly.

| Scenario              | Degradation                       | Example                                  |
| --------------------- | --------------------------------- | ---------------------------------------- |
| Dispatch fails 3x     | Use different agent type          | Try `claude-code` instead of `opencode`  |
| Validation won't pass | Skip validation (if non-blocking) | Proceed without schema check if safe     |
| Artifact write fails  | Write to alternative path         | Use local directory instead of workspace |

### Level 4: Manual Intervention

**When**: Automatic recovery not possible.

| Scenario           | Degradation      | Example                                                                               |
| ------------------ | ---------------- | ------------------------------------------------------------------------------------- |
| All retries failed | Escalate to user | "Harmonia is unable to complete this task automatically. Please check server status." |
| Critical error     | Stop and report  | "Fatal error occurred. Please check Harmonia server logs."                            |

---

## Recovery Procedures

### Project Not Found (404)

**Symptom**: `curl` returns 404 when accessing project.

**Recovery**:

1. Verify project name spelling
2. Check if project is registered: `GET /projects`
3. If missing, register first: `POST /projects`
4. Retry operation

### Agent Not Connected

**Symptom**: `connectedAgents` is empty in status response.

**Recovery**:

1. Connect agent: `POST /projects/:name/agents/connect`
2. Verify connection in status response
3. Retry dispatch if needed

### Artifact Validation Failed

**Symptom**: `ValidationError` in status response.

**Recovery**:

1. Read error details carefully
2. Understand which schema sections are missing/wrong
3. Fix according to requirements
4. Rewrite artifact
5. Resubmit: `nextAction.type = write_artifact`

### Task Dispatch Failed

**Symptom**: Agent returns error or doesn't complete.

**Recovery**:

1. Check agent status: `GET /projects/{project_name}/status`
2. Identify failure cause from error message
3. Retry dispatch or adjust approach
4. If persistent, try different agent

### Iteration Already Active (409)

**Symptom**: Attempting to start new iteration while current one is still active.

**Recovery**:

1. Check current iteration status
2. Use `force=true` if intentional override is desired
3. Complete current iteration first if necessary

---

## Error Operation Steps

Concrete commands and steps for each error scenario.

### 404: Project Not Found

**Operation Steps:**

```bash
# Step 1: List all registered projects
curl http://127.0.0.1:4600/projects

# Step 2: If project not found, register it
curl -X POST http://127.0.0.1:4600/projects \
  -H "Content-Type: application/json" \
  -d '{
    "projectName": "{projectName}",
    "projectDir": "/absolute/path/to/project"
  }'

# Step 3: Verify registration
curl http://127.0.0.1:4600/projects/{project_name}/status

# Step 4: Retry original operation
```

### 409: Iteration Already Active

**Operation Steps:**

```bash
# Step 1: Check current iteration status
curl http://127.0.0.1:4600/projects/{project_name}/status

# Step 2: If force restart is acceptable
curl -X POST http://127.0.0.1:4600/projects/{project_name}/iterations \
  -H "Content-Type: application/json" \
  -d '{"force": true}'

# Step 3: Verify new iteration started
curl http://127.0.0.1:4600/projects/{project_name}/status
```

### ValidationError: Schema Violation

**Operation Steps:**

```bash
# Step 1: Read validation error details
curl http://127.0.0.1:4600/projects/{project_name}/status

# Step 2: Get schema for the artifact
curl http://127.0.0.1:4600/projects/{project_name}/artifacts/{artifact_id}/schema

# Step 3: Fix artifact according to schema
# (Edit the artifact file directly)

# Step 4: Re-submit artifact
curl -X POST http://127.0.0.1:4600/projects/{project_name}/artifacts/{artifact_id} \
  -H "Content-Type: application/json" \
  -d '{
    "content": "$(cat /path/to/artifact.md)"
  }'

# Step 5: Check status for new nextAction
curl http://127.0.0.1:4600/projects/{project_name}/status
```

### AgentUnreachable: Agent Not Responding

**Operation Steps:**

```bash
# Step 1: Check connected agents
curl http://127.0.0.1:4600/projects/{project_name}/status
# Look at connectedAgents section

# Step 2: Disconnect stuck agent
curl -X DELETE "http://127.0.0.1:4600/projects/{projectName}/agents/{key}"

# Step 3: Reconnect agent
curl -X POST http://127.0.0.1:4600/projects/{projectName}/agents/connect \
  -H "Content-Type: application/json" \
  -d '{
    "agentType": "{agent_type}",
    "role": "{role_name}"
  }'

# Step 4: Verify connection
curl http://127.0.0.1:4600/projects/{project_name}/status
```

### 422: Unknown Agent Type

**Operation Steps:**

```bash
# Step 1: List available agent types
curl http://127.0.0.1:4600/agents

# Step 2: Use valid agent type in connection
curl -X POST http://127.0.0.1:4600/projects/{projectName}/agents/connect \
  -H "Content-Type: application/json" \
  -d '{
    "agentType": "claude-code",
    "role": "{role_name}"
  }'
```

### Workflow Stuck at evaluate_gate

**Operation Steps:**

```bash
# Step 1: Check gate status
curl http://127.0.0.1:4600/projects/{project_name}/status

# Step 2: Identify which artifact is blocking
# Look for error messages in the response

# Step 3: Check if blocking artifact exists
curl http://127.0.0.1:4600/projects/{project_name}/artifacts/{blocking_artifact_id}

# Step 4: If missing, create artifact according to schema
curl http://127.0.0.1:4600/projects/{project_name}/artifacts/{artifact_id}/schema

# Step 5: Write the artifact file
# (Follow artifact-writing.md protocol)

# Step 6: Verify gate passed
curl http://127.0.0.1:4600/projects/{project_name}/status
# nextAction should no longer be evaluate_gate
```

---

---

## Common Error Patterns

### Pattern 1: Artifact Path Confusion

**Symptom**: Agent tries to construct paths or uses wrong directories.

**Prevention**:

- Always use paths from dispatch prompt's `## Output Paths` section
- Don't guess directory structure

**Recovery**:

- Re-read dispatch prompt
- Use exact paths provided

### Pattern 2: Schema Violation Loop

**Symptom**: Same validation error occurs repeatedly.

**Prevention**:

- Carefully read schema before writing
- Validate content against schema requirements
- Check for all required sections

**Recovery**:

- Review error details comprehensively
- Fix all violations at once
- Consider changing approach if patterns persist

### Pattern 3: Gate Blocking

**Symptom**: Workflow stuck at `nextAction = evaluate_gate`.

**Prevention**:

- Ensure blocking artifact is written first
- Verify artifact meets gate conditions
- Check status for gate evaluation details

**Recovery**:

- Review gate conditions in [workflow-states.md](workflow-states.md)
- Fix blocking artifact
- Or propose bypass if gate is not critical

### Pattern 4: Agent Unresponsiveness

**Symptom**: Task dispatched but agent not responding.

**Prevention**:

- Ensure agent is connected before dispatch
- Check agent status before critical tasks

**Recovery**:

1. Check agent connection status
2. Reconnect if needed: `DELETE /projects/:name/agents/:key` then `POST /projects/:name/agents/connect`
3. Retry dispatch
4. Consider different agent type if issue persists

---

## Troubleshooting

### Diagnostic Steps

When encountering unexpected errors:

1. **Check status**:
   ```bash
   curl http://127.0.0.1:4600/projects/{project_name}/status
   ```
2. **Analyze nextAction**: What does Harmonia expect?
3. **Review workflow state**: Which nodes are failed/pending?
4. **Check error messages**: What went wrong?
5. **Review recent changes**: Did anything break recently?

### Log Collection

For persistent issues, collect:

- Error timestamps
- Full error messages
- Steps taken to resolve
- Current status after each attempt

### Escalation Criteria

Escalate to manual intervention when:

- All automated retries (L1-L4) have failed
- Error occurs 3+ times in succession
- Critical workflow stage is blocked
- Agent connectivity cannot be restored

---

## Quality Checklist

Before considering error resolved:

- [ ] Root cause identified
- [ ] Degradation strategy applied
- [ ] Recovery action completed
- [ ] Workflow state verified
- [ ] Next clear action determined

---

## Reference Links

- [Workflow States](workflow-states.md) — State machine documentation
- [Output Formats](output-formats.md) — Schema definitions
- [Artifact Writing](artifact-writing.md) — Writing protocol
- [Iteration Cycle](iteration-cycle.md) — Feedback and refinement
