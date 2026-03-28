# Review Flow

Complete protocol for artifact approval and rejection in Harmonia workflows.

## Contents

- [When to Use](#when-to-use)
- [Step 1: Check Pending Reviews](#step-1-check-pending-reviews)
- [Step 2: Present Artifact](#step-2-present-artifact)
- [Step 3: Collect Decision](#step-3-collect-decision)
- [Step 4: Submit Decision](#step-4-submit-decision)
- [Approval Gates](#approval-gates)
- [Rejection Handling](#rejection-handling)
- [Review Quality](#review-quality)

---

## When to Use

Use this protocol when `nextAction.type = "approve_artifact"`.

This means an artifact is awaiting user approval before workflow can proceed.

---

## Step 1: Check Pending Reviews

Query which artifacts are awaiting review.

```bash
curl http://127.0.0.1:4600/projects/{project_name}/reviews
```

### Response

```json
{
  "projectName": "{project_name}",
  "reviews": [
    {
      "artifactId": "prd",
      "artifactName": "Product Requirements Document",
      "submittedAt": "2026-03-27T10:00:00Z"
    },
    {
      "artifactId": "tech-design",
      "artifactName": "Technical Design Document",
      "submittedAt": "2026-03-27T11:00:00Z"
    }
  ]
}
```

### Understanding the Response

- `pending` array: All artifacts awaiting your approval
- Each entry has `artifactId`, `artifactName`, and `submittedAt`
- Multiple artifacts may be pending simultaneously

### Next Step

Proceed to Step 2.

---

## Step 2: Present Artifact

Read the artifact content and present it for user review.

### Read Artifact

```bash
curl http://127.0.0.1:4600/projects/{project_name}/artifacts/{artifact_id}
```

### Response

```json
{
  "artifactId": "prd",
  "artifactName": "Product Requirements Document",
  "content": "# 项目概述\n\n{full markdown content...}",
  "submittedAt": "2026-03-27T10:00:00Z",
  "approved": false
}
```

### Presenting to User

When presenting artifact for review:

1. **Show artifact ID** — Which artifact is being reviewed
2. **Show artifact name** — Human-readable title
3. **Display content** — Full artifact content for review
4. **Highlight key sections** — Call out important parts
5. **Ask for decision** — Clear prompt: "Approve or reject?"

### Presentation Format

```markdown
# Artifact Review: PRD

**Artifact ID**: prd
**Submitted**: 2026-03-27 10:00 UTC

---

## 项目概述

{content...}

## 功能需求

{content...}

---

**Review these sections:**

- Are requirements clear and complete?
- Is scope appropriate?
- Any concerns or questions?

---

**Decision Required**:

1. "Approve" — Artifact is good, proceed to next stage
2. "Reject" — Needs revisions, author should fix and resubmit
```

### Next Step

Wait for user decision.

---

## Step 3: Collect Decision

Understand user's approval or rejection decision.

### Decision Types

| User Response                     | Decision    | Meaning                               |
| --------------------------------- | ----------- | ------------------------------------- |
| "Approve", "好的", "通过", "LGTM" | Approve     | Artifact accepted, workflow continues |
| "Reject", "不行", "重做", "拒绝"  | Reject      | Artifact rejected, author revises     |
| "Needs changes"                   | Conditional | Approve with requested modifications  |

### Confirm Decision

If decision is ambiguous, clarify:

> "Do you mean to approve this artifact (proceed), or reject it (requiring revisions)?"

### Next Step

Once decision is clear, proceed to Step 4.

---

## Step 4: Submit Decision

Submit the approval decision to Harmonia.

### Approve (Accepted)

```bash
curl -X POST http://127.0.0.1:4600/projects/{project_name}/artifacts/{artifact_id}/approve \
  -H "Content-Type: application/json" \
  -d '{
    "approved": true,
    "comment": "Artifact reviewed and approved."
  }'
```

### Reject (Requires Revision)

```bash
curl -X POST http://127.0.0.1:4600/projects/{project_name}/artifacts/{artifact_id}/approve \
  -H "Content-Type: application/json" \
  -d '{
    "approved": false,
    "comment": "{specific feedback about what needs to be fixed}"
  }'
```

### Request Parameters

| Parameter  | Type    | Required | Description                            |
| ---------- | ------- | -------- | -------------------------------------- |
| `approved` | boolean | yes      | `true` for approve, `false` for reject |
| `comment`  | string  | yes      | Feedback explaining the decision       |

### Response

**Success**:

```json
{
  "artifactId": "prd",
  "approved": true,
  "reviewedAt": "2026-03-27T12:00:00Z",
  "comment": "Artifact reviewed and approved."
}
```

**Artifact already approved**:

```json
{
  "error": "ArtifactAlreadyApproved",
  "message": "Artifact is already approved. Cannot change approval status."
}
```

### Next Action After Submit

After submitting decision, **check status**:

```bash
curl http://127.0.0.1:4600/projects/{project_name}/status
```

- If approved → `nextAction` should show next stage
- If rejected → `nextAction` should show `write_artifact` (author revises)

---

## Approval Gates

The workflow has approval gates at critical stages:

### Gate Points

| Gate                  | Before Artifact           | After Approval         |
| --------------------- | ------------------------- | ---------------------- |
| PRD review            | No artifact               | `prd` approved         |
| Tech design review    | `prd` approved            | `tech-design` approved |
| API design review     | `tech-design` approved    | `api-design` approved  |
| Data model review     | `api-design` approved     | `data-model` approved  |
| Task breakdown review | `task-breakdown` approved | Coding can begin       |
| Test approval         | `test-report` approved    | Delivery stage ready   |

### Gate Behavior

When an artifact is approved:

1. **Gate passes** — Workflow advances to next stage
2. **Next task activates** — The subsequent task becomes active
3. **Artifacts become immutable** — Approved artifacts cannot be modified without new iteration

---

## Rejection Handling

### When Artifact is Rejected

1. **Feedback received** — User provides specific feedback
2. **Author notified** — Harmonia records rejection in reviews
3. **Workflow pauses** — No new tasks until artifact is resubmitted
4. **Revision required** — Next `nextAction` will be `write_artifact` for same artifact ID

### Rejection Feedback Types

| Feedback Type    | Example                     | Author Action                   |
| ---------------- | --------------------------- | ------------------------------- |
| Content issues   | "Missing some requirements" | Add missing sections            |
| Structure issues | "Reorganize the document"   | Restructure according to schema |
| Scope issues     | "This is out of scope"      | Clarify scope, revise           |
| Quality issues   | "Needs more detail"         | Expand with more information    |

### Multiple Rejections

If an artifact is rejected multiple times (3+ times):

1. **Stop and clarify** — Something fundamental is wrong
2. **Ask direction change** — "Should we reconsider the approach?"
3. **Consider gate bypass** — If blocking critical path, discuss with user

---

## Review Quality

### Quality Review Checklist

Before making an approval decision, verify:

- [ ] Artifact follows schema structure (all required sections present)
- [ ] Content meets minimum length requirements
- [ ] Content is coherent and well-organized
- [ ] No obvious errors or omissions
- [ ] Guidance from schema is followed
- [ ] Artifact is ready for next stage

### Common Review Issues

| Issue             | Symptom                | Guidance                            |
| ----------------- | ---------------------- | ----------------------------------- |
| Missing sections  | "Section X not found"  | Re-read schema, add missing content |
| Too brief         | "Content is too short" | Expand with more detail             |
| Schema violations | "Format doesn't match" | Fix structure issues                |
| Unclear content   | "Hard to understand"   | Ask author for clarification        |

---

## Workflow Impact

### Approval Impact

When an artifact is approved:

- **Workflow continues** — Next stage tasks activate
- **Progress tracked** — Stage advancement recorded
- **Artifacts locked** — Approved versions become immutable

### Rejection Impact

When an artifact is rejected:

- **Workflow pauses** — Gate blocks progress
- **Revision needed** — Author must resubmit
- **No tasks active** — Until resubmission is reviewed

---

## Reference Links

- [Workflow States](workflow-states.md) — State machine documentation
- [Output Formats](output-formats.md) — Schema definitions
- [Artifact Writing](artifact-writing.md) — Writing protocol
- [Iteration Cycle](iteration-cycle.md) — Feedback and refinement
