/**
 * Artifact Operations — read, list, approve, schema query.
 *
 * Extracted from the monolithic operations.ts during the 008 split.
 */

import { getProject, resolveContextDir } from '../registry.js';
import { readState } from '../state.js';
import { loadWorkflow } from '../plugin.js';
import { readArtifact, listArtifacts, readStepArtifact, resolveArtifactDir } from '../artifacts.js';
import type { ArtifactIOContext } from '../artifacts.js';
import { loadArtifactSchema, formatSchemaGuidance, validateArtifact } from '../schema.js';
import type { StepSchemaEntry } from '../schema.js';
import { resolveReview, getPendingReviews } from '../reviews.js';
import { resolveActive, processWorkflowEvent, loadWorkflowForContext, formatNextAction } from '../engine-helpers.js';
import {
    getArtifactStepState,
    getCompletedStepIds,
    recordStepCompletion,
    buildStepGuidanceFromState,
} from '../steps.js';
import type { CompletedStepInfo, NextStepInfo, StepGuidance } from '../types.js';
import type { ApproveArtifactResult, PendingReviewItem, ArtifactSchemaResult } from './types.js';
import { ValidationError } from './types.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ─── readArtifactOrchestrated / listArtifactsOrchestrated ───

/**
 * Read a project artifact with cross-context support.
 *
 * Extracted from: src/tools/artifact-tools.ts (artifact_read)
 */
export async function readArtifactOrchestrated(
    workflowsDir: string,
    projectName: string,
    artifactId: string,
    context?: string,
): Promise<string> {
    let contextNumber: number;
    let contextDir: string;
    let projectDir: string;

    if (context) {
        const entry = await getProject(projectName);
        if (!entry) {
            throw new Error(`项目 "${projectName}" 未注册。`);
        }
        const resolved = resolveContextDir(projectName, context);
        if (!resolved) {
            throw new ValidationError(`无法解析上下文 "${context}"。格式示例: iter-1, patch-2`);
        }
        contextNumber = resolved.number;
        contextDir = resolved.dir;
        projectDir = entry.dir;
    } else {
        const ctx = await resolveActive(projectName);
        contextNumber = ctx.number;
        contextDir = ctx.dir;
        projectDir = ctx.entry.dir;
    }

    const state = await readState(projectName, contextNumber, contextDir);
    const wf = await loadWorkflow(workflowsDir, state.workflow);
    const artifactDef = wf.artifactDefinitions[artifactId];
    const ioCtx: ArtifactIOContext = { contextDir, projectDir, contextLabel: context ?? '' };

    return readArtifact(artifactId, ioCtx, artifactDef);
}

/**
 * List all artifacts with cross-context support.
 *
 * Extracted from: src/tools/artifact-tools.ts (artifact_list)
 */
export async function listArtifactsOrchestrated(
    workflowsDir: string,
    projectName: string,
    context?: string,
): Promise<{ contextLabel: string; artifacts: string[] }> {
    let contextNumber: number;
    let contextDir: string;
    let contextLabel: string;
    let projectDir: string;

    if (context) {
        const entry = await getProject(projectName);
        if (!entry) {
            throw new Error(`项目 "${projectName}" 未注册。`);
        }
        const resolved = resolveContextDir(projectName, context);
        if (!resolved) {
            throw new ValidationError(`无法解析上下文 "${context}"。格式示例: iter-1, patch-2`);
        }
        contextNumber = resolved.number;
        contextDir = resolved.dir;
        contextLabel = context;
        projectDir = entry.dir;
    } else {
        const ctx = await resolveActive(projectName);
        contextNumber = ctx.number;
        contextDir = ctx.dir;
        contextLabel = ctx.activeContext;
        projectDir = ctx.entry.dir;
    }

    const state = await readState(projectName, contextNumber, contextDir);
    const wf = await loadWorkflow(workflowsDir, state.workflow);
    const ioCtx: ArtifactIOContext = { contextDir, projectDir, contextLabel };

    const artifacts = await listArtifacts(ioCtx, wf.artifactDefinitions);
    return { contextLabel, artifacts };
}

// ─── approveArtifactOrchestrated / listPendingReviewsOrchestrated ───

/**
 * Approve or reject an artifact pending review.
 *
 * Extracted from: src/tools/artifact-approve.ts
 */
export async function approveArtifactOrchestrated(
    workflowsDir: string,
    projectName: string,
    artifactId: string,
    approved: boolean,
    comment?: string,
): Promise<ApproveArtifactResult> {
    const ctx = await resolveActive(projectName);

    const status = approved ? 'approved' : 'rejected';
    await resolveReview(projectName, ctx.number, artifactId, status, comment, ctx.dir);

    let nextAction = '';
    if (approved) {
        const engineResult = await processWorkflowEvent(workflowsDir, projectName, ctx, {
            type: 'artifact_approved',
            artifactId,
        });
        nextAction = formatNextAction(engineResult.nextAction);
    }

    return {
        artifactId,
        approved,
        comment,
        nextAction,
    };
}

/**
 * List all artifacts pending user review.
 *
 * Extracted from: src/tools/artifact-approve.ts (review_list)
 */
export async function listPendingReviewsOrchestrated(projectName: string): Promise<PendingReviewItem[]> {
    const ctx = await resolveActive(projectName);
    const pending = await getPendingReviews(projectName, ctx.number, ctx.dir);
    return pending.map((r) => ({ artifactId: r.artifactId, submittedAt: r.submittedAt }));
}

// ─── getArtifactSchemaInfo ───

/**
 * Query artifact structure requirements and writing guidance.
 *
 * Extracted from: src/tools/artifact-schema.ts
 */
export async function getArtifactSchemaInfo(
    workflowsDir: string,
    projectName: string,
    artifactId: string,
    step?: string,
): Promise<ArtifactSchemaResult> {
    const ctx = await resolveActive(projectName);
    const { wf, state } = await loadWorkflowForContext(workflowsDir, projectName, ctx);

    // Validate artifact_id exists in workflow
    const artifactDef = wf.artifactDefinitions[artifactId];
    if (!artifactDef) {
        const available = Object.keys(wf.artifactDefinitions).join(', ');
        throw new ValidationError(`Artifact "${artifactId}" not found in workflow. Available: ${available}`);
    }

    // If a specific step is requested
    if (step) {
        if (!artifactDef.steps || !artifactDef.steps.find((s) => s.id === step)) {
            const availableSteps = artifactDef.steps?.map((s) => s.id).join(', ') ?? '(无分步)';
            throw new ValidationError(
                `Step "${step}" not found for artifact "${artifactId}". Available steps: ${availableSteps}`,
            );
        }

        const stepSchema = await loadArtifactSchema(workflowsDir, state.workflow, `${artifactId}.${step}`);
        const stepDefFound = artifactDef.steps!.find((s) => s.id === step)!;

        const lines: string[] = [];
        lines.push(`## Step 要求: ${artifactId}.${step}（${stepDefFound.name}）`);
        lines.push('');
        lines.push(`格式: ${stepDefFound.format === 'json' ? 'JSON' : 'Markdown'}`);
        lines.push(`描述: ${stepDefFound.description}`);

        if (stepSchema) {
            if (stepSchema.guidance) {
                lines.push(`内容指引: ${stepSchema.guidance}`);
            }
            if (stepSchema.minLength) {
                lines.push(`最小长度: ${stepSchema.minLength} 字符`);
            }
            if (stepSchema.jsonFields) {
                const reqFields = stepSchema.jsonFields.filter((f) => f.required);
                if (reqFields.length > 0) {
                    lines.push('');
                    lines.push('### 必需 JSON 字段');
                    for (const field of reqFields) {
                        let desc = `- ${field.field}`;
                        if (field.type) desc += ` (${field.type})`;
                        if (field.minItems) desc += `, ≥${field.minItems} 项`;
                        lines.push(desc);
                    }
                }
            }
            if (stepSchema.sections) {
                const reqSections = stepSchema.sections.filter((s) => s.required);
                if (reqSections.length > 0) {
                    lines.push('');
                    lines.push('### 必需章节');
                    for (const section of reqSections) {
                        const heading = section.heading.replace(/^#+\s*/, '');
                        lines.push(`- ${heading}`);
                    }
                }
            }
        } else {
            lines.push('');
            lines.push('（此 step 无 schema 约束）');
        }

        return { text: lines.join('\n') };
    }

    // Full artifact schema
    const schema = await loadArtifactSchema(workflowsDir, state.workflow, artifactId);

    // Load step schemas if artifact has steps
    let stepSchemas: StepSchemaEntry[] | undefined;
    if (artifactDef.steps && artifactDef.steps.length > 0) {
        stepSchemas = [];
        for (const s of artifactDef.steps) {
            const stepSchema = await loadArtifactSchema(workflowsDir, state.workflow, `${artifactId}.${s.id}`);
            stepSchemas.push({ step: s, schema: stepSchema });
        }
    }

    if (!schema && (!stepSchemas || stepSchemas.every((s) => !s.schema))) {
        return { text: `Artifact "${artifactId}" 无 schema 定义。` };
    }

    const guidance = formatSchemaGuidance(artifactId, artifactDef, schema, stepSchemas);
    return { text: guidance };
}

// ─── Step Reading & Completion ───

/**
 * Read a specific step artifact.
 *
 * @param workflowsDir - Workflows directory
 * @param projectName - Project name
 * @param artifactId - Artifact ID
 * @param stepId - Step ID
 * @param context - Optional context (iter-1, patch-2)
 */
export async function readArtifactStepOrchestrated(
    workflowsDir: string,
    projectName: string,
    artifactId: string,
    stepId: string,
    context?: string,
): Promise<{ content: string; format: 'json' | 'md'; path: string }> {
    const ctx = await resolveActive(projectName);
    const { wf } = await loadWorkflowForContext(workflowsDir, projectName, ctx);

    const artifactDef = wf.artifactDefinitions[artifactId];
    if (!artifactDef) {
        throw new ValidationError(`Artifact "${artifactId}" not found in workflow`);
    }

    const stepDef = artifactDef.steps?.find((s) => s.id === stepId);
    if (!stepDef) {
        const availableSteps = artifactDef.steps?.map((s) => s.id).join(', ') ?? '(无分步)';
        throw new ValidationError(
            `Step "${stepId}" not found in artifact "${artifactId}". Available: ${availableSteps}`,
        );
    }

    const ioCtx: ArtifactIOContext = {
        contextDir: ctx.dir,
        projectDir: ctx.entry.dir,
        contextLabel: ctx.activeContext,
    };

    const content = await readStepArtifact(artifactId, stepId, ioCtx, artifactDef);
    const dir = resolveArtifactDir(artifactDef.output, ioCtx);
    const ext = stepDef.format === 'json' ? '.json' : '.md';
    const path = `${dir}/${artifactId}.${stepId}${ext}`;

    return {
        content,
        format: stepDef.format,
        path,
    };
}

/**
 * Mark a step as completed.
 *
 * @param workflowsDir - Workflows directory
 * @param projectName - Project name
 * @param artifactId - Artifact ID
 * @param stepId - Step ID that was completed
 * @param artifactPath - Path to the step artifact file
 */
export async function completeArtifactStep(
    workflowsDir: string,
    projectName: string,
    artifactId: string,
    stepId: string,
    artifactPath?: string,
): Promise<{
    success: true;
    artifactId: string;
    stepId: string;
    completedAt: string;
    progress: {
        completedSteps: string[];
        totalSteps: number;
        nextStep: { id: string; name: string; format: string } | null;
    };
}> {
    const ctx = await resolveActive(projectName);
    const { wf } = await loadWorkflowForContext(workflowsDir, projectName, ctx);

    const artifactDef = wf.artifactDefinitions[artifactId];
    if (!artifactDef?.steps) {
        throw new ValidationError(`Artifact "${artifactId}" has no steps`);
    }

    const stepDef = artifactDef.steps.find((s) => s.id === stepId);
    if (!stepDef) {
        throw new ValidationError(`Step "${stepId}" not found in artifact "${artifactId}"`);
    }

    // Get all step IDs
    const allStepIds = artifactDef.steps.map((s) => s.id);

    // Auto-infer artifact path if not provided
    const ioCtx: ArtifactIOContext = {
        contextDir: ctx.dir,
        projectDir: ctx.entry.dir,
        contextLabel: ctx.activeContext,
    };
    if (!artifactPath) {
        const dir = resolveArtifactDir(artifactDef.output, ioCtx);
        const ext = stepDef.format === 'json' ? '.json' : '.md';
        artifactPath = `${dir}/${artifactId}.${stepId}${ext}`;
    }

    // Record completion
    const stepState = await recordStepCompletion(
        projectName,
        ctx.number,
        artifactId,
        stepId,
        artifactPath,
        allStepIds,
        ctx.dir,
    );

    // Calculate next step
    const completedIds = getCompletedStepIds(stepState);
    let nextStep: { id: string; name: string; format: string } | null = null;
    for (const step of artifactDef.steps) {
        if (!completedIds.has(step.id)) {
            nextStep = { id: step.id, name: step.name, format: step.format };
            break;
        }
    }

    return {
        success: true,
        artifactId,
        stepId,
        completedAt: new Date().toISOString(),
        progress: {
            completedSteps: Array.from(completedIds),
            totalSteps: artifactDef.steps.length,
            nextStep,
        },
    };
}

/**
 * Build step guidance for a stepped artifact.
 *
 * @param artifactId - Artifact ID
 * @param projectName - Project name
 * @param iteration - Iteration/context number
 * @param wf - Workflow plugin
 * @param ioCtx - Artifact I/O context
 * @param contextDir - Context directory
 */
export async function buildStepGuidance(
    artifactId: string,
    projectName: string,
    iteration: number,
    wf: {
        artifactDefinitions: Record<
            string,
            {
                name: string;
                steps?: { id: string; name: string; format: 'json' | 'md'; description: string }[];
                format?: 'md' | 'html' | 'json';
                output?: string;
            }
        >;
    },
    ioCtx: ArtifactIOContext,
    contextDir: string,
): Promise<StepGuidance | null> {
    const artifactDef = wf.artifactDefinitions[artifactId];
    if (!artifactDef?.steps?.length) return null;

    const stepState = await getArtifactStepState(projectName, iteration, artifactId, contextDir);

    return buildStepGuidanceFromState(
        artifactId,
        artifactDef as import('../types.js').ArtifactDefinition,
        stepState,
        ioCtx,
    );
}
