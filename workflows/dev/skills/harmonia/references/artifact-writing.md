# Artifact Writing Protocol

Complete protocol for writing artifacts in Harmonia workflows.

## Contents

- [When to Use](#when-to-use)
- [Step 1: Query Schema](#step-1-query-schema)
- [Step 2: Follow Schema](#step-2-follow-schema)
- [Step 3: Write File](#step-3-write-file)
- [Step 4: Await Validation](#step-4-await-validation)
- [Step 5: Handle Validation Result](#step-5-handle-validation-result)
- [Stepped Artifacts](#stepped-artifacts)
- [Troubleshooting](#troubleshooting)

---

## When to Use

Use this protocol when `nextAction.type = "write_artifact"`.

---

## Step 1: Query Schema

First, query the artifact schema to understand the required structure.

```bash
curl http://127.0.0.1:4600/projects/{project_name}/artifacts/{artifact_id}/schema
```

### Request Parameters

| Parameter     | Type   | Description                                               |
| ------------- | ------ | --------------------------------------------------------- |
| `artifact_id` | string | Artifact ID (e.g., `prd`, `tech-design`)                  |
| `context`     | string | Optional: `iter-N` or `patch-N` (default: active context) |
| `step`        | string | Optional: For stepped artifacts, the step ID              |

### Response

```json
{
  "artifactId": "prd",
  "format": "md",
  "guidance": "PRD 描述产品需求（做什么），不涉及技术实现（怎么做）。技术选型、架构设计、代码实现方案属于 tech-design 文档，不应出现在 PRD 中。",
  "sections": [
    {
      "heading": "## 项目概述",
      "required": true,
      "aliases": ["## Project Overview", "## 概述"]
    },
    {
      "heading": "## 功能需求",
      "required": true,
      "aliases": ["## Functional Requirements", "## 需求列表"]
    },
    {
      "heading": "## 非功能需求",
      "required": true,
      "aliases": ["## Non-Functional Requirements", "## 非功能性需求"]
    },
    {
      "heading": "## 验收标准",
      "required": true,
      "aliases": ["## Acceptance Criteria", "## 验收条件"]
    },
    {
      "heading": "## 约束与假设",
      "required": true,
      "aliases": ["## Constraints and Assumptions", "## 约束条件", "## 前提假设"]
    }
  ],
  "minLength": 200
}
```

### JSON Format Artifacts

For JSON artifacts like `data-model.json`, the schema includes `jsonFields`:

```json
{
  "artifactId": "data-model",
  "format": "json",
  "guidance": "定义核心业务实体及其属性。清晰描述实体间关系。",
  "jsonFields": {
    "entities": {
      "type": "array",
      "description": "Array of entity definitions"
    }
  }
}
```

### Next Step

Proceed to Step 2.

---

## Step 2: Follow Schema

Analyze the schema response and follow its structure exactly.

### For Markdown Artifacts

1. **Read all sections** — Schema may have 5-7 required headings
2. **Create structure** — Use exact `heading` values from schema
3. **Add aliases support** — Recognize `aliases` for flexible heading matching
4. **Follow guidance** — Apply `guidance` instructions
5. **Meet minLength** — Ensure content exceeds `minLength` requirement

### For JSON Artifacts

1. **Read jsonFields** — Understand required structure
2. **Create JSON object** — Follow exact field definitions
3. **Follow guidance** — Apply any validation instructions
4. **Validate locally** — Ensure JSON is valid before writing

### Next Step

Proceed to Step 3.

---

## Step 3: Write File

Write the artifact to the filesystem.

**Important: Do NOT construct the path yourself.** The dispatch prompt's `## Output Paths` section provides the exact absolute path.

### Path Resolution

The dispatch prompt contains:

```markdown
## Output Paths

Write artifacts directly to the following paths:

- **prd**: /absolute/path/to/project/data/iter-1/prd.md
- **tech-design**: /absolute/path/to/project/data/iter-1/tech-design.md
- **task-breakdown**: /absolute/path/to/project/data/iter-1/task-breakdown.json
```

**Use these paths exactly**:

```bash
# Example: Write PRD
echo "## 项目概述

{content goes here}
" > /absolute/path/to/project/data/iter-1/prd.md
```

### Directory Creation

If the target directory doesn't exist, create it first:

```bash
mkdir -p /absolute/path/to/project/data/iter-1
```

### File Permissions

Ensure the file is writable:

```bash
# Check permissions
ls -la /absolute/path/to/project/data/

# If not writable, fix:
chmod u+w /absolute/path/to/project/data/
```

### Next Step

Proceed to Step 4.

---

## Step 4: Await Validation

After writing, wait for Harmonia to automatically validate the artifact.

**No API call needed** — Harmonia validates automatically when the file is written.

### Validation Process

Harmonia checks:

1. **Schema compliance** — Required sections/headings present?
2. **Length check** — Content meets `minLength` requirement?
3. **Format validity** — Markdown structure correct? JSON valid?
4. **Content quality** — Basic content quality checks

### Expected Outcomes

| Result            | Meaning           | Action                            |
| ----------------- | ----------------- | --------------------------------- |
| Validation passes | Artifact accepted | Check status for new `nextAction` |
| Validation fails  | Artifact rejected | See Step 5                        |

### Next Step

Proceed to Step 5 (when validation result received).

---

## Step 5: Handle Validation Result

After waiting a moment, check status for validation result.

```bash
curl http://127.0.0.1:4600/projects/{project_name}/status
```

### Check for Errors

If status response contains validation errors:

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

### Fixing Validation Errors

1. **Read the error** — Understand what's wrong
2. **Consult schema** — Re-read the schema response
3. **Fix the issue**:
   - Missing section? → Add the required section
   - Below minLength? → Expand with more detail
   - Invalid format? → Fix structure
4. **Rewrite the artifact** — Write corrected content

### Retry Strategy

After fixing, write the artifact again:

```bash
# Write corrected content
echo "{corrected content}" > /absolute/path/to/artifact.md

# Harmonia will re-validate automatically
```

### Next Action After Fix

After rewriting, check status again:

```bash
curl http://127.0.0.1:4600/projects/{project_name}/status
```

Follow the new `nextAction` (should be `write_artifact` again or proceed).

---

## Stepped Artifacts

Some artifacts (e.g., `prd`, `tech-design`, `task-breakdown`) have multiple sequential steps. Each step must be completed in order before moving to the next.

### How to Know What Step to Do

Call `GET /projects/{project_name}/status`. The response includes:

```json
{
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
  "stepGuidances": [{ "artifactId": "prd", "...": "..." }]
}
```

- **`stepGuidance`** — primary stepped artifact (active node's artifact)
- **`stepGuidances[]`** — all in-progress stepped artifacts (useful when multiple are active in parallel)

Use `stepGuidance.nextStep` to determine which step to write next.

### Step Workflow

For each step:

#### 1. Query schema for the step

```bash
curl http://127.0.0.1:4600/projects/{project_name}/artifacts/{artifact_id}/schema?step={step_id}
```

The `step_id` comes from `stepGuidance.nextStep.id`.

#### 2. Write the step file

Write to the path from `stepGuidance.nextStep.outputPath`:

```bash
# Example: write prd.requirements.json
echo '{"features": [...], "constraints": [...]}' > /path/to/prd.requirements.json
```

#### 3. Notify Harmonia the step is complete

```bash
curl -X POST http://127.0.0.1:4600/projects/{project_name}/artifacts/{artifact_id}/steps/{step_id}/complete \
  -H "Content-Type: application/json" \
  -d '{}'
```

- `artifact_id` = `stepGuidance.artifactId`
- `step_id` = `stepGuidance.nextStep.id`
- `path` is optional (auto-inferred from artifact definition)

**Response** tells you the next step:

```json
{
  "success": true,
  "progress": {
    "completedSteps": ["requirements"],
    "totalSteps": 3,
    "nextStep": { "id": "completeness-check", "name": "Completeness Check", "format": "json" }
  }
}
```

Repeat steps 1-3 for each subsequent step.

#### 4. Write the final artifact

After all steps are completed, write the final artifact file:

```bash
echo "# PRD\n\n## 项目概述\n..." > /path/to/prd.md
```

### Recovery After Disconnect

If the agent disconnects and reconnects:

1. Call `GET /projects/{project_name}/status`
2. Harmonia **automatically detects** completed step files on disk and syncs the state
3. `stepGuidance` reflects the current progress — the agent knows exactly where to continue

No manual recovery needed. The `progressText` shows a clear status like:

```
[✓] Requirements → [✓] Completeness Check → [→] Draft
```

---

## Troubleshooting

### Common Writing Issues

| Issue                   | Symptom                          | Solution                                     |
| ----------------------- | -------------------------------- | -------------------------------------------- |
| Path not writable       | "Permission denied" when writing | Check directory permissions: `chmod u+w`     |
| Directory doesn't exist | "No such file or directory"      | Create directory first: `mkdir -p`           |
| Schema query fails      | 404 or error response            | Check `artifact_id` is correct, check status |
| Validation stuck        | No update for long time          | Check Harmonia server is running             |
| Path mismatch           | Wrong file location              | Use exact path from dispatch prompt          |

### Debug Steps

When writing fails:

1. **Verify path** — Is it the exact path from dispatch prompt?
2. **Check directory** — Does parent directory exist?
3. **Check permissions** — Is directory writable?
4. **Check server** — Is Harmonia accessible at `http://127.0.0.1:4600`?

### Quality Checklist

Before considering writing complete:

- [ ] Schema queried successfully
- [ ] Schema structure followed exactly
- [ ] File written to correct path
- [ ] Directory created (if needed)
- [ ] File is readable and writable
- [ ] Ready for validation

---

## Reference Links

- [Output Formats](output-formats.md) — Complete schema definitions
- [Workflow States](workflow-states.md) — State machine documentation
- [Error Handling](error-handling.md) — Degradation strategies
