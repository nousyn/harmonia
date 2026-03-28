# 016 — P3 Sequential Mode Complete

**Date**: 2026-03-16
**Status**: COMPLETED
**Branch**: develop

## Summary

Implemented sequential mode for `write_doc` — critical documents (PRD, tech-design, task-breakdown) at medium/large scale must now be written step-by-step with per-step schema validation and hard prerequisite enforcement.

## Changes

### New files

- `src/core/steps.ts` — Step state management (readSteps, recordStepCompletion, markFinalized, etc.)
- `tests/steps.test.ts` — 15 unit tests for step state management
- `tests/sequential.test.ts` — 18 integration tests (8 JSON validation + 10 MCP tool orchestration)
- `workflows/dev/schemas/prd.requirements.json` — PRD step 1 JSON schema
- `workflows/dev/schemas/prd.completeness-check.json` — PRD step 2 JSON schema
- `workflows/dev/schemas/prd.draft.json` — PRD step 3 markdown schema
- `workflows/dev/schemas/prd.final.json` — PRD step 4 markdown schema
- `workflows/dev/schemas/tech-design.analysis.json` — TD step 1
- `workflows/dev/schemas/tech-design.api-contract.json` — TD step 2
- `workflows/dev/schemas/tech-design.draft.json` — TD step 3
- `workflows/dev/schemas/tech-design.final.json` — TD step 4
- `workflows/dev/schemas/task-breakdown.coarse.json` — TB step 1
- `workflows/dev/schemas/task-breakdown.dependencies.json` — TB step 2
- `workflows/dev/schemas/task-breakdown.detailed.json` — TB step 3
- `workflows/dev/schemas/task-breakdown.final.json` — TB step 4

### Modified files

- `src/core/types.ts` — Added DocStepDefinition, DocStepRecord, DocStepState, DocSchemaJsonField types; extended DocDefinition + DocSchema
- `src/core/docs.ts` — Added writeStepArtifact(), readStepArtifact()
- `src/core/schema.ts` — Extended validateDoc with isJson parameter + JSON field validation (missing_json_field, invalid_json, wrong_json_type, json_array_too_short)
- `src/tools/doc-tools.ts` — Rewritten with sequential mode: isSequentialActive(), handleSequentialWrite(), handleFinalStep()
- `workflows/dev/workflow.json` — Added steps arrays to prd, tech-design, task-breakdown

## Design Decisions

1. **Activation**: Sequential mode activates when doc has `steps` AND project scale >= medium
2. **Tool interface**: Reused `write_doc` with optional `step` parameter (no new tool)
3. **Step format**: Mixed — JSON for structured steps, md for document steps
4. **Ordering**: Hard enforcement — step N prerequisites must be completed before step N+1
5. **Rollback**: Overwriting step N clears all subsequent step records (disk artifacts preserved)
6. **Final merge**: Last step auto-writes formal doc + triggers review flow
7. **Small scale**: Bypasses sequential mode entirely (normal write_doc behavior)

## Test Coverage

- **Before**: 210 tests across 10 files
- **After**: 243 tests across 12 files (+33)
  - `steps.test.ts`: 15 tests (step state CRUD, rollback, finalization, multi-doc independence)
  - `sequential.test.ts`: 18 tests (JSON validation: 8, MCP tool orchestration: 10)

### Sequential orchestration tests cover:

- Missing step parameter error
- Unknown step ID error
- Prerequisite enforcement (can't skip ahead)
- Valid first step → progress message
- Step artifact written to disk
- Invalid JSON schema rejection
- Full 4-step completion → formal doc + review
- Step overwrite → rollback of subsequent steps
- Small scale bypass (no sequential mode)
- Final step schema validation failure

## Architecture

```
write_doc(step="requirements")
  → isSequentialActive() check
  → handleSequentialWrite()
    → validate step ID
    → check prerequisites (getCompletedStepIds)
    → validate against step schema (prd.requirements.json)
    → writeStepArtifact() → docs/prd.requirements.json
    → recordStepCompletion() → steps.json
    → if last step → handleFinalStep()
      → validate against final doc schema (prd.json)
      → writeDoc() → docs/prd.md
      → markFinalized()
      → submitForReview() if needed
```

## Step Definitions (PRD example)

| Step | ID                 | Format | Schema                                       |
| ---- | ------------------ | ------ | -------------------------------------------- |
| 1    | requirements       | json   | features[], constraints[], scope, priorities |
| 2    | completeness-check | json   | coverage{}, missing[], conflicts[], verdict  |
| 3    | draft              | md     | ## 项目概述, ## 功能需求, minLength 150      |
| 4    | final              | md     | Full PRD schema (same as prd.json)           |
