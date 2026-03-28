# New Project Setup

Complete workflow for initializing a new project into Harmonia.

## Contents

- [Prerequisites](#prerequisites)
- [Step 1: Register Project](#step-1-register-project)
- [Step 2: Start First Iteration](#step-2-start-first-iteration)
- [Step 3: Connect Agents](#step-3-connect-agents)
- [Step 4: Begin Development](#step-4-begin-development)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before starting:

1. **Project directory ready**: Have the absolute path to your project directory
2. **Workflow selected**: Know which workflow to use (default: `dev`)
3. **Harmonia server running**: Ensure Harmonia is accessible at `http://127.0.0.1:4600`

**If workflow selection is ambiguous** and multiple are available, Harmonia will return:

```json
{
  "error": "WorkflowSelectionRequired",
  "available": ["workflow-a", "workflow-b"]
}
```

Prompt user to specify which workflow to use.

---

## Step 1: Register Project

Register the project with Harmonia.

```bash
curl -X POST http://127.0.0.1:4600/projects \
  -H "Content-Type: application/json" \
  -d '{
    "projectName": "{project_name}",
    "projectDir": "/absolute/path/to/project",
    "workflow": "{workflow_name}"
  }'
```

### Parameters

| Parameter      | Type   | Required | Description                                    |
| -------------- | ------ | -------- | ---------------------------------------------- |
| `project_name` | string | yes      | Unique project identifier                      |
| `projectDir`   | string | yes      | Absolute path to project directory             |
| `workflow`     | string | no       | Workflow name (required if multiple available) |

### Response

**Success (201)**:

```json
{
  "projectName": "{project_name}",
  "projectDir": "/absolute/path/to/project",
  "workflow": "dev",
  "created": true
}
```

**Already registered (200)**:

```json
{
  "projectName": "{project_name}",
  "projectDir": "/absolute/path/to/project",
  "workflow": "dev",
  "alreadyRegistered": true
}
```

**Multiple workflows (409)**:

```json
{
  "error": "WorkflowSelectionRequired",
  "available": ["workflow-a", "workflow-b"],
  "message": "Multiple workflows available. Please specify workflow parameter."
}
```

### Next Step

Proceed to Step 2 regardless of response (new or already registered).

---

## Step 2: Start First Iteration

Initialize the first iteration for the project.

```bash
curl -X POST http://127.0.0.1:4600/projects/{project_name}/iterations \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Optional Parameters

| Parameter | Type    | Default | Description                                  |
| --------- | ------- | ------- | -------------------------------------------- |
| `force`   | boolean | false   | Force start new iteration even if one exists |

### Response

**Success (201)**:

```json
{
  "projectName": "{project_name}",
  "iteration": 1,
  "type": "iteration",
  "status": "active",
  "created_at": "2026-03-27T12:00:00Z"
}
```

**Already exists (without force)**:

```json
{
  "error": "IterationAlreadyExists",
  "message": "Iteration 1 already exists. Use force=true to start a new iteration."
}
```

### What This Does

This step:

1. Creates iteration directory: `iter-1/`
2. Initializes `state.json` with pending node states
3. Activates the first workflow node (typically coordinator task)
4. Returns initial `nextAction` indicating what to do next

### Next Step

Proceed to Step 3.

---

## Step 3: Connect Agents

Register agents for Harmonia to dispatch tasks and send notifications.

### Connect Coordinator

The coordinator agent is the central communication bridge:

```bash
curl -X POST http://127.0.0.1:4600/projects/:name/agents/connect \
  -H "Content-Type: application/json" \
  -d '{
    "projectName": "{project_name}",
    "agentType": "{agent_type}",
    "role": "coordinator"
  }'
```

### Connect Team Members

Connect additional agents (developer, architect, tester) as needed:

| Role          | Agent Type                 | When Needed                     |
| ------------- | -------------------------- | ------------------------------- |
| `coordinator` | `opencode` / `claude-code` | Always required                 |
| `architect`   | `opencode` / `claude-code` | When tech-design is in workflow |
| `developer`   | `opencode` / `claude-code` | When coding is in workflow      |
| `tester`      | `opencode` / `claude-code` | When testing is in workflow     |

### Response

**Success (200)**:

```json
{
  "connected": true,
  "key": "coordinator",
  "agentType": "claude-code",
  "project": "{project_name}"
}
```

**Unknown agent type (422)**:

```json
{
  "error": "Unknown agent type",
  "message": "Agent type '{agent_type}' not registered."
}
```

### Important Note

**Connecting an agent does NOT start a task.** It only makes the agent available for:

- Receiving push notifications (approval requests, status updates)
- Being targeted for dispatch when its role's task becomes active

Tasks are dispatched separately by Harmonia based on workflow state.

### Role Connection Checklist

After connecting agents, verify connections are working:

| Checklist Item               | Verification Method                   | Expected Result                            |
| ---------------------------- | ------------------------------------- | ------------------------------------------ |
| Coordinator connected        | `GET /projects/{project_name}/status` | `connectedAgents.coordinator` present      |
| All required roles connected | Check `connectedAgents` object        | All workflow roles have entries            |
| Agent type correct           | Check `agentType` in status           | Expected agent type (opencode/claude-code) |
| Connection timestamp valid   | Check `connectedAt` field             | Recent timestamp (within session)          |
| Agent responsive             | Try dispatch if available             | Agent receives and processes task          |

**Verification command:**

```bash
curl http://127.0.0.1:4600/projects/{project_name}/status
```

Look for `connectedAgents` section:

```json
{
  "connectedAgents": {
    "coordinator": {
      "agentType": "claude-code",
      "sessionId": "...",
      "connectedAt": 1234567890
    },
    "architect": {
      "agentType": "claude-code",
      "sessionId": "...",
      "connectedAt": 1234567895
    }
  }
}
```

**Troubleshooting connections:**

| Issue                       | Symptom                   | Fix                                          |
| --------------------------- | ------------------------- | -------------------------------------------- |
| Role not in connectedAgents | Status missing role entry | Connect the missing agent role               |
| Agent type wrong            | `agentType` doesn't match | Disconnect and reconnect with correct type   |
| Old connection              | `connectedAt` very old    | Reconnect to refresh session                 |
| Agent not responding        | Task dispatch hangs       | Verify agent is running, reconnect if needed |

### Next Step

Proceed to Step 4.

---

## Step 4: Begin Development

Check status to see what Harmonia expects next:

```bash
curl http://127.0.0.1:4600/projects/{project_name}/status
```

### Expected Response

**First iteration start**:

```json
{
  "projectName": "{project_name}",
  "workflow": "dev",
  "iteration": 1,
  "type": "iteration",
  "activeTaskId": "collect-requirements",
  "nextAction": {
    "type": "dispatch",
    "nodeId": "collect-requirements",
    "role": "coordinator",
    "instructions": "Dispatch coordinator to collect requirements",
    "rolePrompt": "[Full assembled prompt for coordinator]"
  }
}
```

### Your Action

1. **Read the rolePrompt** — Contains task description and context
2. **Execute the task** — Follow the prompt instructions
3. **Write artifacts** — If task produces artifacts, write them using the workflow in [artifact-writing.md](artifact-writing.md)
4. **Check status again** — After writing artifacts, check status for new `nextAction`

### Workflow Progression

The workflow will progress through stages:

```
collect-requirements → write-prd →
review-prd → approve-prd →
tech-design → write-tech-design →
review-tech-design → approve-tech-design →
task-breakdown → coding →
testing → test-report → ...
```

At each stage, check status and follow the indicated `nextAction`.

---

## Troubleshooting

### Common Issues

| Issue                     | Symptom                            | Solution                                                           |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| Project not found         | 404 response                       | Check project_name spelling, register project first                |
| Agent not connected       | Push notifications missing         | Verify agent connection with `GET /projects/{project_name}/status` |
| Workflow stuck            | `nextAction = "wait" for long time | Check agent status, verify agent is executing task                 |
| Artifact validation fails | `error` in status                  | Fix schema violations and rewrite artifact                         |

### Status Check Pattern

Whenever unsure, always check status:

```bash
curl http://127.0.0.1:4600/projects/{project_name}/status
```

The `nextAction` field is your guide.

---

## Quality Checklist

Before considering project setup complete:

- [ ] Project registered successfully
- [ ] First iteration started
- [ ] Coordinator agent connected
- [ ] Other team members connected (if applicable)
- [ ] Status shows first active task
- [ ] Ready to begin development

---

## Next Steps

After project setup complete, the workflow will guide you through development iterations. See [new-iteration.md](new-iteration.md) for ongoing iteration workflows.
