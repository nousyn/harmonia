---
name: harmonia
description: >
  Interact with Harmonia orchestrator during software development workflows.
  Routes to scene-specific reference documents for detailed workflows.
metadata:
  author: cc_cat
  version: '1.0.0'
---

# Harmonia Workflow Operations

Harmonia is a standalone multi-agent orchestrator. You interact with it exclusively through HTTP API calls. Harmonia coordinates workflow; you execute work.

Base URL: `http://127.0.0.1:4600`

## Purpose

This is the root routing skill. It directs you to scene-specific reference documents based on your current task context.

**Core principle: Check status first, then follow the routed workflow.** The `nextAction` field tells you exactly what Harmonia expects next.

## Scene Routing Rules

Use these trigger keywords to determine which reference document to read:

| Trigger Keywords                                                        | Scene    | Reference Document                             |
| ----------------------------------------------------------------------- | -------- | ---------------------------------------------- |
| "新建项目"、"启动项目"、"从零开始"、"init project"、"start new project" | 新项目   | See `{baseDir}/references/new-project.md`      |
| "新迭代"、"下一轮"、"继续开发"、"start iteration"、"next iteration"     | 新迭代   | See `{baseDir}/references/new-iteration.md`    |
| "热修复"、"修复 bug"、"紧急修复"、"hotfix"、"fix bug"                   | 热修复   | See `{baseDir}/references/new-patch.md`        |
| "进度"、"状态"、"检查"、"check progress"、"status"                      | 查询状态 | See `{baseDir}/references/workflow-states.md`  |
| "写产出"、"保存"、"提交"、"write artifact"、"save artifact"             | 产出写入 | See `{baseDir}/references/artifact-writing.md` |
| "审批"、"批准"、"拒绝"、"approve"、"reject"                             | 审批     | See `{baseDir}/references/review-flow.md`      |

**Ambiguity handling:**

When trigger keywords are insufficient or context is unclear:

1. Ask one short clarification question: "是新项目、新迭代、热修复，还是查询进度？"
2. If no reply is provided, default to checking status.

### Scene Transition Matrix

After initial scene selection, use workflow state and user intent to determine the next scene:

| Current Scene | Workflow State (nextAction) | User Intent | Next Scene       |
| ------------- | --------------------------- | ----------- | ---------------- |
| new-project   | `completed`                 | "继续"      | new-iteration    |
| new-project   | `failed`                    | "修复"      | error-handling   |
| new-iteration | `completed`                 | "下一轮"    | new-iteration    |
| new-iteration | `completed`                 | "修复 bug"  | new-patch        |
| new-iteration | `write_artifact`            | "写产出"    | artifact-writing |
| new-iteration | `approve_artifact`          | "审批"      | review-flow      |
| new-patch     | `completed`                 | "继续"      | new-iteration    |
| new-patch     | `failed`                    | "重试"      | new-patch        |
| Any scene     | `failed`                    | "查看错误"  | error-handling   |
| Any scene     | User: "进度"                | —           | workflow-states  |

**Transition rules:**

1. **Status-first routing**: Always check `nextAction` before deciding on scene transition
2. **User intent overrides**: If user explicitly states intent, follow their direction
3. **State-driven defaults**: When intent unclear, use workflow state to determine logical next step
4. **Error priority**: If `nextAction = failed`, always route to error-handling first

## Quick Reference

### nextAction State Machine

For quick lookup, see `{baseDir}/references/workflow-states.md` for detailed state machine documentation.

```
nextAction.type    What it means         Your action
───────────────────────────────────────────────────────────────
dispatch          Task ready to assign   Wait for Harmonia to dispatch
write_artifact    Artifact needed         Write it (see artifact-writing.md)
approve_artifact  Artifact awaits review   Prompt user for approval decision
evaluate_gate     Gate check in progress   No action needed, automatic
wait              Task executing          Wait for completion
completed         Workflow finished         Done
failed            Workflow failed         Diagnose via status response
```

### Common API Calls

| Need to...                 | API call                                          |
| -------------------------- | ------------------------------------------------- |
| Register a new project     | `POST /projects`                                  |
| Check workflow progress    | `GET /projects/{project}/status`                  |
| Read an artifact           | `GET /projects/{project}/artifacts/{id}`          |
| List all artifacts         | `GET /projects/{project}/artifacts`               |
| Get writing guidance       | `GET /projects/{project}/artifacts/{id}/schema`   |
| Approve/reject an artifact | `POST /projects/{project}/artifacts/{id}/approve` |
| See pending reviews        | `GET /projects/{project}/reviews`                 |

**API Reference**: See `{baseDir}/references/api-reference.md` for full request/response details.
| Create an issue | `POST /projects/{project}/issues` |
| List/filter issues | `GET /projects/{project}/issues` |
| Update an issue | `PATCH /projects/{project}/issues/{id}` |
| Start a new iteration | `POST /projects/{project}/iterations` |
| Start a hotfix patch | `POST /projects/{project}/patches` |
| Register agent connection | `POST /connect` |
| Disconnect agent | `DELETE /connect/{key}?project_name={project}` |

See `{baseDir}/references/api-reference.md` for full request/response details when you need exact parameter names, body formats, or status codes.

## Output Format Schema

For artifact writing, always follow the schema returned by:

```bash
curl http://127.0.0.1:4600/projects/{project}/artifacts/{id}/schema
```

See `{baseDir}/references/output-formats.md` for complete schema definitions for each artifact type (PRD, tech-design, task-breakdown, etc.).

## Key Principles

1. **Status is source of truth** — Always check status before acting. `nextAction` tells you exactly what to do.
2. **Paths are provided** — The dispatch prompt's `## Output Paths` section gives you exact absolute paths. Use them directly.
3. **Schema is contract** — Follow the schema structure. Validation failures will be reported by Harmonia.
4. **Approval blocks are real** — A `review: true` artifact blocks workflow progress. Don't wait silently.
5. **Refine cycle exists** — See `{baseDir}/references/iteration-cycle.md` for feedback loop handling.

## Error Handling

When Harmonia returns an error, follow the degradation strategy:

- L1: Retry with simplified parameters
- L2: Retry with minimal parameters
- L3: Report to user with actionable guidance

See `{baseDir}/references/error-handling.md` for detailed error handling procedures.

## Do NOT Trigger

- When task is unrelated to software development workflows
- When user explicitly asks to skip Harmonia (e.g. "just do it directly", "skip workflow")
- When task can be completed without Harmonia coordination
