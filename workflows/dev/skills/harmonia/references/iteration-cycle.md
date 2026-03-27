# Iteration Cycle

Complete feedback and refinement loop for Harmonia workflows.

## Contents

- [Purpose](#purpose)
- [Refine Process](#refine-process)
- [Feedback Types](#feedback-types)
- [Adjustment Paths](#adjustment-paths)
- [Iteration Strategy](#iteration-strategy)
- [Exit Conditions](#exit-conditions)

---

## Purpose

The refine cycle provides structured feedback handling between artifact submission and final acceptance.

**Core principle: Maximum 3 refinement iterations per artifact.** If quality not achieved after 3 rounds, escalate to alternative strategies.

---

## Refine Process

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Agent writes artifact (Initial version)                         │
│            ↓                                                      │
│ 2. Harmonia validates (Schema check)                               │
│            ↓                                                      │
│ 3. Agent receives validation result                                     │
│            ↓                                                      │
│ 4. Refine Loop (max 3 rounds):                                    │
│    ┌──────────────────────────────────────┐                              │
│    │ 4a. Present artifact + feedback │                                   │
│    │         ↓                     │                                    │
│    │    4b. User provides feedback │                                     │
│    │         ↓                     │                                    │
│    │ 4c. Agent adjusts artifact   │                                     │
│    │         ↓                     │                                    │
│    │    4d. Back to 4a (next round)│                                   │
│    └───────────────────────────────┘                              │
│            ↓                                                      │
│ 5. User approves (Exit cycle)                                        │
│            ↓                                                      │
│ 6. Workflow continues to next stage                                    │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## Feedback Types

### Schema Errors

**When**: Harmonia returns validation errors.

**Agent Action**:

1. Read error details carefully
2. Understand which sections are missing/wrong
3. Fix according to schema requirements
4. Rewrite artifact
5. Continue refine loop (counts as iteration)

**Example Error**:

```json
{
  "error": "ValidationError",
  "artifactId": "prd",
  "message": "Missing required section: ## 功能需求",
  "details": {
    "missing_sections": ["功能需求"]
  }
}
```

**Fix Action**:

```bash
# Add missing section
echo "## 功能需求

{requirements content}
" >> /path/to/prd.md
```

### Content Issues

**When**: User says content issues but not specific errors.

**Examples**: "太简短"、"不够详细"、"逻辑有问题"

**Agent Action**:

1. Ask clarifying question
2. Understand specific missing content
3. Expand artifact accordingly

---

## Adjustment Paths

### Path 1: Schema Compliance

**Trigger**: Schema validation error

| Feedback        | Example            | Adjustment              |
| --------------- | ------------------ | ----------------------- |
| Missing section | "缺少 ## 功能需求" | Add the missing section |
| Below minLength | "内容太少"         | Expand with more detail |
| Invalid format  | "格式不对"         | Fix structure issues    |

### Path 2: Content Expansion

**Trigger**: User wants more detail without schema error.

| Feedback        | Example      | Adjustment                 |
| --------------- | ------------ | -------------------------- |
| "Add more"      | "功能不够全" | Expand requirements list   |
| "Explain more"  | "太简略"     | Add explanatory paragraphs |
| "Give examples" | "需要例子"   | Add concrete examples      |

### Path 3: Structural Reorganization

**Trigger**: User says structure is wrong.

| Feedback       | Example    | Adjustment                       |
| -------------- | ---------- | -------------------------------- |
| "Reorganize"   | "逻辑混乱" | Restructure document logic       |
| "Change order" | "顺序不对" | Reorder sections for better flow |

### Path 4: Direction Change

**Trigger**: User says current approach is wrong.

| Feedback              | Example        | Adjustment                     |
| --------------------- | -------------- | ------------------------------ |
| "Different approach"  | "这个方向不对" | Completely rethink and rewrite |
| "Use different style" | "风格不适合"   | Change tone, style, or format  |

### Path 5: Approval Bypass

**Trigger**: Multiple rejections blocking progress.

| Scenario      | Adjustment |
| ------------- | ---------- | ---------------------------------------------- |
| 3+ rejections | "一直被拒" | Ask user: "Should we reconsider the approach?" |
| Stuck         | "卡住了"   | Propose alternatives or split task             |

---

## Iteration Strategy

### Iteration Counting

Each refine round is counted:

```
Round 1: Initial submission
Round 2: First refinement (after user feedback)
Round 3: Second refinement (after user feedback)
Round 4: Escalation (if needed)
```

### Refinement Count Tracking

**How to check current refinement count:**

1. **Via status response** — Check artifact-specific iteration count:

   ```bash
   curl http://127.0.0.1:4600/projects/{project}/status
   ```

   Look for `workflowState.artifacts.{artifactId}.refinementCount`:

   ```json
   {
     "workflowState": {
       "artifacts": {
         "prd": {
           "refinementCount": 2,
           "submittedAt": 1234567890,
           "lastRefinedAt": 1234567950
         }
       }
     }
   }
   ```

2. **Via artifact schema query** — Schema includes count constraints:

   ```bash
   curl http://127.0.0.1:4600/projects/{project}/artifacts/{id}/schema
   ```

   Schema response shows:

   ```json
   {
     "maxRefinements": 3,
     "currentRefinementCount": 1
   }
   ```

**Tracking rules:**

| Event                   | Count Action                 | New Count     |
| ----------------------- | ---------------------------- | ------------- |
| Initial submission      | Initialize to 0              | 0             |
| User rejects            | Increment by 1               | 0 → 1 → 2 → 3 |
| User approves           | Reset to 0 (artifact locked) | 0             |
| Schema validation error | No increment (same count)    | Unchanged     |
| Escalation triggered    | Cap at 3, stop               | 3             |

**Agent responsibility for tracking:**

- Always display current round number when presenting artifact for review
- Example: "Round 2 of 3: Artifact for review"
- Before Round 3 submission: "Final refinement round (3/3)"
- After Round 3 rejection: "Maximum refinement rounds reached. Escalating."

**Automatic count enforcement:**

Harmonia will reject any 4th refinement attempt automatically with:

```json
{
  "error": "MaxRefinementsExceeded",
  "artifactId": "prd",
  "message": "Maximum 3 refinement rounds reached. Please escalate to alternative strategies."
}
```

### Round Decision Points

After each user feedback, decide:

| Feedback        | Decision | Action                                  |
| --------------- | -------- | --------------------------------------- |
| "好", "通过"    | Approve  | Exit refine cycle, continue workflow    |
| Content issue   | Refine   | Adjust artifact, start next round       |
| Direction wrong | Refine   | Reconsider approach, rewrite artifact   |
| "不行", "拒绝"  | Reject   | If review required, resubmit for review |

### Maximum 3 Rounds

**Why 3 rounds?**

- Prevents endless refinement loops
- Forces quality alignment
- Provides clear exit condition
- Allows escalation when needed

### Escalation After 3 Rounds

If after 3 refinement rounds, artifact is still not approved:

1. **Stop refinement** — Don't attempt 4th round
2. **Propose alternatives**:
   - Split the task into smaller parts
   - Change the approach entirely
   - Request human intervention
3. **Document blocker** — Explain why current approach isn't working

---

## Exit Conditions

### Success Exit

**Condition**: User approves artifact (`approved: true`).

**Actions**:

1. Submit approval to Harmonia:
   ```bash
   curl -X POST /projects/{project}/artifacts/{id}/approve \
     -d '{"approved": true, "comment": "Approved."}'
   ```
2. Check status for new `nextAction`
3. Proceed to next workflow stage

### Reject Exit

**Condition**: User rejects artifact (`approved: false`).

**Actions**:

1. Submit rejection to Harmonia:
   ```bash
   curl -X POST /projects/{project}/artifacts/{id}/approve \
     -d '{"approved": false, "comment": "Needs revisions."}'
   ```
2. Next `nextAction` will be `write_artifact` for same artifact
3. Re-enter refine cycle (increment round count)

---

## Refine Best Practices

### For Agent

1. **Present clearly** — Show artifact content prominently
2. **Explain feedback** — Why changes are needed
3. **Track rounds** — Be aware of current refinement number (1, 2, or 3)
4. **Know when to stop** — Don't exceed 3 rounds without escalation

### For User

1. **Be specific** — Clear feedback helps accurate adjustments
2. **Prioritize issues** — Focus on critical problems first
3. **Consider context** — Understand scope and constraints
4. **Approve when satisfied** — Don't delay unnecessarily

### Common Patterns

| Pattern                | When to Use                   | Example                                                   |
| ---------------------- | ----------------------------- | --------------------------------------------------------- |
| Progressive refinement | Each round builds on previous | Round 1 adds details, Round 2 clarifies, Round 3 polishes |
| Direction pivot        | User changes approach         | User: "这个方法不对，换个思路"                            |
| Scope adjustment       | User narrows/broadens         | User: "只做核心功能，其他以后再说"                        |

---

## Quality Checklist

Before exiting refine cycle with approval:

- [ ] All schema errors resolved
- [ ] All user feedback incorporated
- [ ] Artifact meets all schema requirements
- [ ] Artifact is coherent and complete
- [ ] User expresses satisfaction

---

## Reference Links

- [Workflow States](workflow-states.md) — State machine documentation
- [Output Formats](output-formats.md) — Schema definitions
- [Artifact Writing](artifact-writing.md) — Writing protocol
- [Review Flow](review-flow.md) — Approval and rejection handling
