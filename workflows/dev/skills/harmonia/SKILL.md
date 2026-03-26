---
name: harmonia
description: >
  Interact with the Harmonia orchestrator during software development workflows.
  TRIGGER when: initializing a new project into Harmonia, checking what the
  next development phase is (requirements, design, coding, testing), reading
  or writing workflow artifacts (PRD, tech-design, task-breakdown, test-plan,
  etc.), submitting artifacts for review, handling approvals, reporting or
  tracking issues, starting new iterations or hotfix patches — even if the
  user simply says "start a new project", "what's next", "check progress",
  or "submit for review" without mentioning Harmonia.
  DO NOT TRIGGER when: the task is unrelated to software development workflows,
  or the user explicitly asks to skip Harmonia (e.g. "just do it directly",
  "skip the workflow").
metadata:
  author: cc_cat
  version: '2.0.0'
---

# Harmonia Workflow Operations

Harmonia is a standalone multi-agent orchestrator. You interact with it exclusively through HTTP API calls (`curl` with JSON). Harmonia coordinates the workflow; you execute the work.

Base URL: `http://127.0.0.1:4600`

## Getting started

- **New project?** → `{baseDir}/references/new-project.md`
- **Existing project, new iteration?** → `{baseDir}/references/new-iteration.md`
- **Existing project, hotfix?** → `{baseDir}/references/new-patch.md`

## Check status

Check the project status to understand what the workflow expects next:

```bash
curl http://127.0.0.1:4600/projects/{project}/status
```

The `nextAction` field in the response tells you exactly what to do:

```
nextAction.type ──► What it means ──► Your action
─────────────────────────────────────────────────
dispatch         → Task ready to assign   → Wait for Harmonia to dispatch
write_artifact   → Artifact needed        → Write it (see "Writing artifacts" below)
approve_artifact → Artifact awaits review → Prompt user for approval decision
evaluate_gate    → Gate check in progress → No action needed, automatic
wait             → Task executing         → Wait for completion
completed        → Workflow finished      → Done
failed           → Workflow failed        → Diagnose via status response
```

If you're unsure what to do at any point, check status again — `nextAction` is always the source of truth.

## Quick task reference

| I need to...               | API call                                          |
| -------------------------- | ------------------------------------------------- |
| Register a new project     | `POST /projects`                                  |
| Check workflow progress    | `GET /projects/{project}/status`                  |
| Read an artifact           | `GET /projects/{project}/artifacts/{id}`          |
| List all artifacts         | `GET /projects/{project}/artifacts`               |
| Get writing guidance       | `GET /projects/{project}/artifacts/{id}/schema`   |
| Approve/reject an artifact | `POST /projects/{project}/artifacts/{id}/approve` |
| See pending reviews        | `GET /projects/{project}/reviews`                 |
| Create an issue            | `POST /projects/{project}/issues`                 |
| List/filter issues         | `GET /projects/{project}/issues`                  |
| Update an issue            | `PATCH /projects/{project}/issues/{id}`           |
| Start a new iteration      | `POST /projects/{project}/iterations`             |
| Start a hotfix patch       | `POST /projects/{project}/patches`                |
| Register agent connection  | `POST /connect`                                   |
| Disconnect agent           | `DELETE /connect/{key}?project_name={project}`    |

See `{baseDir}/references/api-reference.md` for full request/response details when you need exact parameter names, body formats, or status codes.

## Writing artifacts

Artifacts are written directly to the filesystem by you, not uploaded via API. Harmonia validates them after the fact.

### Workflow

1. **Get schema first** — `GET /projects/{project}/artifacts/{id}/schema` returns `guidance` (writing instructions), plus `sections` (for Markdown) or `jsonFields` (for JSON) defining the required structure.
2. **Write the file** to the path provided in your dispatch prompt (the `## Output Paths` section lists the full absolute path for each artifact you need to produce). Do not try to construct paths yourself.
3. **Harmonia validates automatically** — if validation fails, you'll receive an error describing what's wrong. Fix and rewrite.

### Stepped artifacts

Some artifacts have `steps` — you write intermediate files for each step before producing the final artifact. The dispatch prompt provides paths for both step files and the final file.

## Approvals

Artifacts marked with `review: true` block the workflow until approved. The approval flow:

1. Check pending reviews: `GET /projects/{project}/reviews`
2. Submit decision: `POST /projects/{project}/artifacts/{id}/approve` with `{"approved": true/false, "comment": "..."}`

A rejected artifact means the author needs to revise and rewrite it.

## Gotchas

- **Always check status before acting.** Don't guess what the workflow needs — `nextAction` tells you. Skipping this step leads to wasted work on the wrong task.
- **Don't construct artifact paths yourself.** The dispatch prompt's `## Output Paths` section gives you the exact absolute path for each artifact. Use those paths directly — the underlying directory structure (`dataDir`, iteration directories) is internal to Harmonia and not exposed via API.
- **Artifacts are filesystem-first.** You write files; Harmonia reads them. There is no upload API. If you try to POST artifact content to Harmonia, it won't work.
- **Schema is your writing contract.** If you skip the schema query and write an artifact without following the required structure, validation will fail and you'll have to redo the work.
- **Approval blocks are real.** A `review: true` artifact that isn't approved will prevent the entire workflow from advancing past its gate. Don't wait silently — prompt the user.
- **Issue `resolvedBy` format matters.** When updating an issue to resolved status, provide `resolved_by_type` and `resolved_by_number` (not `resolvedBy` as a plain string). See `{baseDir}/references/api-reference.md` for the exact format.
- **Connect ≠ dispatch.** Registering an agent via `/connect` makes it available for notifications but does not start a task. Tasks are dispatched separately by Harmonia.
