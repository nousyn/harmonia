/**
 * Operations — orchestration-layer business functions extracted from src/tools/.
 *
 * These functions chain multiple core atomic operations into complete business
 * actions. They are transport-agnostic (no MCP ToolResult, no HTTP Response)
 * and throw errors on failure instead of returning error objects.
 *
 * Each function returns a plain data result that the transport layer (HTTP API,
 * CLI, etc.) can format as needed.
 */

import { createKit, defineHooks, type HookSet, type HookInstallResult } from '@s_s/agent-kit';
import { detectAgent, type AgentType } from '@s_s/agent-kit';
import { loadWorkflow, listWorkflows } from './plugin.js';
import {
    registerProject,
    getProject,
    getGlobalDir,
    listProjects,
    startIteration,
    startPatch,
    getIterationDir,
    getPatchDir,
    resolveContextDir,
} from './registry.js';
import type { ProjectEntry } from './registry.js';
import { initWorkflowState, readState, persistState } from './state.js';
import { startWorkflow } from './workflow-engine.js';
import type { EngineContext, GateContext } from './workflow-engine.js';
import { writeArtifact, readArtifact, listArtifacts, writeStepArtifact } from './artifacts.js';
import type { ArtifactIOContext } from './artifacts.js';
import { loadArtifactSchema, validateArtifact, formatValidationErrors, formatSchemaGuidance } from './schema.js';
import type { StepSchemaEntry } from './schema.js';
import { getMergedOverrides, resolveArtifactReview } from './overrides.js';
import { submitForReview, resolveReview, getPendingReviews, readReviews } from './reviews.js';
import { getArtifactStepState, getCompletedStepIds, recordStepCompletion, markFinalized, readSteps } from './steps.js';
import { readDispatches, readSessions } from './dispatch.js';
import { readIssues } from './issues.js';
import { resolveActive, processWorkflowEvent, loadWorkflowForContext, formatNextAction } from './engine-helpers.js';
import type { ResolvedContext, EngineResult } from './engine-helpers.js';
import type {
    ArtifactDefinition,
    ArtifactStepDefinition,
    HookCreatorContext,
    WorkflowPlugin,
    WorkflowNode,
    NodeState,
    LoopNodeState,
    DispatchRecord,
    SessionRecord,
    ArtifactStepState,
} from './types.js';

/** Shared kit instance for hook installation */
const kit = createKit('harmonia');

/**
 * Detect the host agent type for a given project directory.
 * Delegates to agent-kit's detectAgent(); falls back to 'opencode'.
 */
async function detectHostAgent(projectDir: string): Promise<AgentType> {
    const detected = await detectAgent(projectDir);
    return detected ?? 'opencode';
}

// ─── Return Types ───

export interface InitProjectResult {
    alreadyRegistered: boolean;
    projectName: string;
    projectDir: string;
    workflow: string;
    workflowDescription: string;
    availableRoles: string[];
    hookMessage: string;
    /** Info for already-registered projects */
    existingInfo?: {
        activeContext: string;
        totalIterations: number;
        totalPatches: number;
    };
}

export interface BeginIterationResult {
    iteration: number;
    projectName: string;
    projectDir: string;
    workflowName: string;
    availableRoles: string[];
    nextAction: string;
}

export interface BeginPatchResult {
    patchNumber: number;
    projectName: string;
    projectDir: string;
    workflowName: string;
    description?: string;
    issueId?: string;
    nextAction: string;
}

export interface WriteArtifactResult {
    artifactId: string;
    filePath: string;
    needsReview: boolean;
    artifactName: string;
    nextAction: string;
    /** Sequential mode progress */
    sequential?: {
        stepId: string;
        stepName: string;
        isLastStep: boolean;
        nextStep?: { id: string; description: string };
    };
}

export interface ApproveArtifactResult {
    artifactId: string;
    approved: boolean;
    comment?: string;
    nextAction: string;
}

export interface PendingReviewItem {
    artifactId: string;
    submittedAt: string;
}

export interface ArtifactSchemaResult {
    text: string;
}

export interface ProjectStatusData {
    projectName: string;
    projectDir: string;
    workflow: string;
    activeContext: string;
    contextType: string;
    contextNumber: number;
    currentIteration: number;
    totalIterations: number;
    currentPatch: number;
    totalPatches: number;
    activeNodeId: string | null;
    createdAt: string;
    updatedAt: string;
    treeLines: string[];
    artifactIds: string[];
    artifactDefs: Record<string, ArtifactDefinition>;
    reviews: Record<string, { status: string; submittedAt: string }>;
    stepsData: Record<string, ArtifactStepState>;
    dispatches: DispatchRecord[];
    sessions: SessionRecord[];
    issues: import('./types.js').Issue[];
    nextAction: string;
}

export interface ProjectListItem {
    name: string;
    dir: string;
    workflow?: string;
    activeNode?: string;
    activeContext?: string;
    updatedAt?: string;
    error?: string;
}

/** Workflow choice info returned when multiple workflows are available */
export interface WorkflowChoice {
    name: string;
    description: string;
}

// ─── Error Types ───

/** Thrown when the user must choose a workflow */
export class WorkflowSelectionRequired extends Error {
    constructor(public readonly available: WorkflowChoice[]) {
        super(`有 ${available.length} 个可用工作流，请指定 workflow 参数。`);
        this.name = 'WorkflowSelectionRequired';
    }
}

/** Thrown when validation fails (schema, guard, etc.) */
export class ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ValidationError';
    }
}

/** Thrown when a sequential step has unmet prerequisites */
export class StepPrerequisiteError extends Error {
    constructor(
        public readonly stepId: string,
        public readonly missingStepId: string,
        public readonly missingStepName: string,
    ) {
        super(`无法写入步骤 "${stepId}"：前置步骤 "${missingStepId}" (${missingStepName}) 尚未完成。请先完成该步骤。`);
        this.name = 'StepPrerequisiteError';
    }
}

// ─── initProject ───

/**
 * Register a new Harmonia project and install workflow hooks.
 *
 * Extracted from: src/tools/project-init.ts
 *
 * Workflow resolution logic:
 * - If workflow is specified, validate it exists
 * - If only one workflow is available, auto-select
 * - If multiple, throw WorkflowSelectionRequired
 */
export async function initProject(
    workflowsDir: string,
    projectName: string,
    projectDir: string,
    workflow?: string,
): Promise<InitProjectResult> {
    // Check if already registered
    const existing = await getProject(projectName);
    if (existing) {
        return {
            alreadyRegistered: true,
            projectName,
            projectDir: existing.dir,
            workflow: existing.workflow,
            workflowDescription: '',
            availableRoles: [],
            hookMessage: '',
            existingInfo: {
                activeContext: existing.activeContext,
                totalIterations: existing.totalIterations,
                totalPatches: existing.totalPatches,
            },
        };
    }

    // Resolve workflow name
    const available = await listWorkflows(workflowsDir);

    if (available.length === 0) {
        throw new Error('没有可用的工作流。请检查 Harmonia 安装是否完整，或在自定义工作流目录中创建工作流。');
    }

    let workflowName: string;

    if (workflow) {
        if (!available.includes(workflow)) {
            throw new ValidationError(`工作流 "${workflow}" 不存在。可用的工作流: ${available.join(', ')}`);
        }
        workflowName = workflow;
    } else if (available.length === 1) {
        workflowName = available[0];
    } else {
        // Multiple workflows — require explicit choice
        const choices: WorkflowChoice[] = [];
        for (const name of available) {
            try {
                const wf = await loadWorkflow(workflowsDir, name);
                choices.push({ name, description: wf.definition.description });
            } catch {
                choices.push({ name, description: '(无法加载描述)' });
            }
        }
        throw new WorkflowSelectionRequired(choices);
    }

    // Load workflow definition (validate it loads correctly)
    const wf = await loadWorkflow(workflowsDir, workflowName);

    // Register project (creates global data dir + project source dir)
    await registerProject(projectName, projectDir, workflowName);

    // Install workflow hooks if the plugin provides a hook creator
    let hookMessage = '';
    if (wf.hooks) {
        try {
            const agentType = await detectHostAgent(projectDir);
            const context: HookCreatorContext = {
                defineHooks,
                dataDir: getGlobalDir(),
                projectName,
            };
            const hookSet = wf.hooks(agentType, context) as HookSet | HookSet[];
            const hookResult: HookInstallResult = await kit.installHooks(agentType, hookSet);
            if (hookResult.success) {
                hookMessage = `Hooks 已安装 (${hookResult.filesWritten.length} 个文件)`;
                if (hookResult.warnings.length > 0) {
                    hookMessage += `\n警告: ${hookResult.warnings.join('; ')}`;
                }
            } else {
                hookMessage = `[warn] Hook 安装失败: ${hookResult.error ?? '未知错误'}`;
            }
        } catch (err) {
            hookMessage = `[warn] Hook 安装出错: ${err instanceof Error ? err.message : String(err)}`;
        }
    }

    return {
        alreadyRegistered: false,
        projectName,
        projectDir,
        workflow: wf.definition.name,
        workflowDescription: wf.definition.description,
        availableRoles: Object.keys(wf.roles),
        hookMessage,
    };
}

// ─── beginIteration ───

/**
 * Start a new iteration for a registered project.
 *
 * Extracted from: src/tools/iteration-start.ts
 *
 * Guards:
 * - Project must be registered
 * - If current iteration exists, workflow must be completed (or force=true)
 */
export async function beginIteration(
    workflowsDir: string,
    projectName: string,
    force?: boolean,
): Promise<BeginIterationResult> {
    const entry = await getProject(projectName);
    if (!entry) {
        throw new Error(`项目 "${projectName}" 未注册。请先注册项目。`);
    }

    // Guard: if there's a current iteration, check if the workflow root is completed
    if (entry.currentIteration > 0 && !force) {
        try {
            const currentIterDir = entry.activeContext
                ? resolveContextDir(projectName, `iter-${entry.currentIteration}`)?.dir
                : undefined;
            const currentState = await readState(projectName, entry.currentIteration, currentIterDir);
            const incompleteNodes = Object.values(currentState.nodes).filter(
                (n) => n.status === 'active' || n.status === 'pending',
            );
            if (incompleteNodes.length > 0) {
                const summary = incompleteNodes
                    .slice(0, 5)
                    .map((n) => `${n.id} (${n.status})`)
                    .join(', ');
                const moreText = incompleteNodes.length > 5 ? ` ...及其他 ${incompleteNodes.length - 5} 个节点` : '';
                throw new ValidationError(
                    `当前迭代 (iter-${entry.currentIteration}) 工作流尚未完成。` +
                        `未完成节点: ${summary}${moreText}。` +
                        `请先完成当前迭代的工作流，或使用 force=true 强制开始新迭代。`,
                );
            }
        } catch (err) {
            // Re-throw ValidationError, swallow state-read errors (corrupted iteration)
            if (err instanceof ValidationError) throw err;
        }
    }

    // Start new iteration
    const newIteration = await startIteration(projectName);

    // Load workflow and initialize state
    const wf = await loadWorkflow(workflowsDir, entry.workflow);
    const newIterDir = getIterationDir(projectName, newIteration);
    const state = await initWorkflowState(projectName, entry.dir, wf, newIteration, 'iteration', newIterDir);

    // Start the workflow engine — activates root node
    const emptyGate: GateContext = {
        artifactExists: () => false,
        artifactApproved: () => false,
        artifactField: () => undefined,
    };
    const engineCtx: EngineContext = {
        gate: emptyGate,
        getRolePrompt: (role: string) => {
            const roleDef = wf.roles[role];
            return roleDef?.prompt ?? `Role "${role}" prompt not found`;
        },
    };

    const result = startWorkflow(wf.definition, state, engineCtx);
    await persistState(projectName, newIteration, result.state, newIterDir);

    return {
        iteration: newIteration,
        projectName,
        projectDir: entry.dir,
        workflowName: wf.definition.name,
        availableRoles: Object.keys(wf.roles),
        nextAction: formatNextAction(result.nextAction),
    };
}

// ─── beginPatch ───

/**
 * Start a new patch for a registered project.
 *
 * Extracted from: src/tools/patch-start.ts
 *
 * Guards:
 * - Project must be registered
 * - At least one iteration must have been started
 */
export async function beginPatch(
    workflowsDir: string,
    projectName: string,
    description?: string,
    issueId?: string,
): Promise<BeginPatchResult> {
    const entry = await getProject(projectName);
    if (!entry) {
        throw new Error(`项目 "${projectName}" 未注册。请先注册项目。`);
    }

    if (entry.totalIterations === 0) {
        throw new ValidationError(`项目 "${projectName}" 尚未有任何迭代。补丁用于修复已有工作，请先开始第一轮迭代。`);
    }

    // Start new patch
    const newPatch = await startPatch(projectName);

    // Load workflow and initialize state in patch mode
    const wf = await loadWorkflow(workflowsDir, entry.workflow);
    const patchDir = getPatchDir(projectName, newPatch);
    const state = await initWorkflowState(projectName, entry.dir, wf, newPatch, 'patch', patchDir);

    // Persist patch metadata
    if (issueId || description) {
        state.meta = {
            ...(description ? { description } : {}),
            ...(issueId ? { issueId } : {}),
        };
        await persistState(projectName, newPatch, state, patchDir);
    }

    // Start the workflow engine
    const emptyGate: GateContext = {
        artifactExists: () => false,
        artifactApproved: () => false,
        artifactField: () => undefined,
    };
    const engineCtx: EngineContext = {
        gate: emptyGate,
        getRolePrompt: (role: string) => {
            const roleDef = wf.roles[role];
            return roleDef?.prompt ?? `Role "${role}" prompt not found`;
        },
    };

    const result = startWorkflow(wf.definition, state, engineCtx);
    await persistState(projectName, newPatch, result.state, patchDir);

    return {
        patchNumber: newPatch,
        projectName,
        projectDir: entry.dir,
        workflowName: wf.definition.name,
        description,
        issueId,
        nextAction: formatNextAction(result.nextAction),
    };
}

// ─── writeArtifactOrchestrated ───

/**
 * Check if sequential mode is active for a given artifact definition.
 */
function isSequentialActive(artifactDef: ArtifactDefinition): boolean {
    return !!artifactDef.steps?.length;
}

/**
 * Write or update a project artifact with full orchestration.
 *
 * Extracted from: src/tools/artifact-tools.ts
 *
 * Handles:
 * - Artifact ID validation against workflow
 * - Schema validation
 * - Sequential mode (step prerequisites, step schema, final merge)
 * - Engine event triggers (artifact_written)
 * - Review flow (auto-submit if needed)
 */
export async function writeArtifactOrchestrated(
    workflowsDir: string,
    projectName: string,
    artifactId: string,
    content: string,
    step?: string,
): Promise<WriteArtifactResult> {
    const ctx = await resolveActive(projectName);
    const { wf, state } = await loadWorkflowForContext(workflowsDir, projectName, ctx);
    const artifactDef = wf.artifactDefinitions[artifactId];

    // Guard: artifact_id must be defined in workflow
    if (!artifactDef) {
        const validIds = Object.keys(wf.artifactDefinitions)
            .filter((id) => !wf.artifactDefinitions[id].unmanaged)
            .join(', ');
        throw new ValidationError(`Artifact "${artifactId}" 未在工作流中定义。可用的 artifact 类型: ${validIds}`);
    }

    // Guard: reject unmanaged artifact types
    if (artifactDef.unmanaged) {
        throw new ValidationError(`Artifact "${artifactId}" 是非托管（unmanaged）产出类型，不应通过此接口写入。`);
    }

    // Guard: empty content
    if (!content.trim()) {
        throw new ValidationError('Artifact 内容为空，请提供实际内容后重新提交。');
    }

    // ─── Sequential Mode ───
    if (isSequentialActive(artifactDef)) {
        return handleSequentialWriteOp(
            workflowsDir,
            state.workflow,
            projectName,
            ctx,
            artifactId,
            content,
            step,
            artifactDef,
        );
    }

    // ─── Normal Mode (no steps) ───
    const isHtml = artifactDef.format === 'html';

    // Schema validation
    const schema = await loadArtifactSchema(workflowsDir, state.workflow, artifactId);
    if (schema) {
        const result = validateArtifact(content, schema, isHtml);
        if (!result.valid) {
            throw new ValidationError(formatValidationErrors(result.errors));
        }
    }

    // Write the artifact
    const writeIoCtx: ArtifactIOContext = {
        contextDir: ctx.dir,
        projectDir: ctx.entry.dir,
        contextLabel: ctx.activeContext,
    };
    const filePath = await writeArtifact(artifactId, content, writeIoCtx, artifactDef);

    // Trigger engine event
    const engineResult = await processWorkflowEvent(workflowsDir, projectName, ctx, {
        type: 'artifact_written',
        artifactId,
    });

    // Check review
    const overrides = await getMergedOverrides(projectName);
    const needsReview = resolveArtifactReview(artifactId, artifactDef, overrides);

    if (needsReview) {
        await submitForReview(projectName, ctx.number, artifactId, ctx.dir);
    }

    return {
        artifactId,
        filePath,
        needsReview,
        artifactName: artifactDef.name ?? artifactId,
        nextAction: formatNextAction(engineResult.nextAction),
    };
}

/**
 * Handle sequential write — step-by-step artifact writing.
 */
async function handleSequentialWriteOp(
    workflowsDir: string,
    workflowName: string,
    projectName: string,
    ctx: ResolvedContext,
    artifactId: string,
    content: string,
    step: string | undefined,
    artifactDef: ArtifactDefinition,
): Promise<WriteArtifactResult> {
    const steps = artifactDef.steps!;
    const stepIds = steps.map((s) => s.id);
    const stepNames = steps.map((s) => `${s.id} (${s.name})`).join(', ');

    // Guard: step parameter is required in sequential mode
    if (!step) {
        throw new ValidationError(
            `Artifact "${artifactId}" 需要分步写入。请指定 step 参数。可用的步骤: ${stepNames}\n\n` +
                `步骤说明:\n` +
                steps.map((s, i) => `  ${i + 1}. ${s.id} — ${s.description}`).join('\n'),
        );
    }

    // Guard: step must be valid
    const stepDef = steps.find((s) => s.id === step);
    if (!stepDef) {
        throw new ValidationError(`未知的步骤 "${step}"。可用的步骤: ${stepNames}`);
    }

    const stepIndex = stepIds.indexOf(step);
    const stepState = await getArtifactStepState(projectName, ctx.number, artifactId, ctx.dir);
    const completedIds = getCompletedStepIds(stepState);

    // Guard: prerequisite steps must be completed
    for (let i = 0; i < stepIndex; i++) {
        if (!completedIds.has(stepIds[i])) {
            const missingStep = steps[i];
            throw new StepPrerequisiteError(step, missingStep.id, missingStep.name);
        }
    }

    // Step schema validation
    const isJson = stepDef.format === 'json';
    const stepSchemaId = `${artifactId}.${step}`;
    const stepSchema = await loadArtifactSchema(workflowsDir, workflowName, stepSchemaId);
    if (stepSchema) {
        const result = validateArtifact(content, stepSchema, false, isJson);
        if (!result.valid) {
            throw new ValidationError(formatValidationErrors(result.errors));
        }
    }

    // Write the step artifact
    const ioCtx: ArtifactIOContext = {
        contextDir: ctx.dir,
        projectDir: ctx.entry.dir,
        contextLabel: ctx.activeContext,
    };
    const artifactPath = await writeStepArtifact(artifactId, step, content, stepDef.format, ioCtx, artifactDef);

    // Record step completion
    await recordStepCompletion(projectName, ctx.number, artifactId, step, artifactPath, stepIds, ctx.dir);

    const isLastStep = stepIndex === steps.length - 1;

    if (isLastStep) {
        return handleFinalStepOp(
            workflowsDir,
            workflowName,
            projectName,
            ctx,
            artifactId,
            content,
            artifactDef,
            stepDef,
            ioCtx,
        );
    }

    // Not the last step
    const nextStep = steps[stepIndex + 1];
    return {
        artifactId,
        filePath: artifactPath,
        needsReview: false,
        artifactName: artifactDef.name ?? artifactId,
        nextAction: '',
        sequential: {
            stepId: step,
            stepName: stepDef.name,
            isLastStep: false,
            nextStep: { id: nextStep.id, description: nextStep.description },
        },
    };
}

/**
 * Handle the final step of sequential writing: validate, write formal artifact, trigger review.
 */
async function handleFinalStepOp(
    workflowsDir: string,
    workflowName: string,
    projectName: string,
    ctx: ResolvedContext,
    artifactId: string,
    content: string,
    artifactDef: ArtifactDefinition,
    stepDef: ArtifactStepDefinition,
    ioCtx: ArtifactIOContext,
): Promise<WriteArtifactResult> {
    const isHtml = artifactDef.format === 'html';

    // Validate against final artifact schema
    const finalSchema = await loadArtifactSchema(workflowsDir, workflowName, artifactId);
    if (finalSchema) {
        const isJson = artifactDef.format === 'json';
        const result = validateArtifact(content, finalSchema, isHtml, isJson);
        if (!result.valid) {
            throw new ValidationError(
                `最终 artifact 校验失败:\n${formatValidationErrors(result.errors)}\n\n请修正后重新提交步骤 "${stepDef.id}"。`,
            );
        }
    }

    // Write the formal artifact
    const filePath = await writeArtifact(artifactId, content, ioCtx, artifactDef);

    // Mark as finalized
    await markFinalized(projectName, ctx.number, artifactId, ctx.dir);

    // Trigger engine event
    const engineResult = await processWorkflowEvent(workflowsDir, projectName, ctx, {
        type: 'artifact_written',
        artifactId,
    });

    // Check review
    const overrides = await getMergedOverrides(projectName);
    const needsReview = resolveArtifactReview(artifactId, artifactDef, overrides);

    if (needsReview) {
        await submitForReview(projectName, ctx.number, artifactId, ctx.dir);
    }

    return {
        artifactId,
        filePath,
        needsReview,
        artifactName: artifactDef.name ?? artifactId,
        nextAction: formatNextAction(engineResult.nextAction),
        sequential: {
            stepId: stepDef.id,
            stepName: stepDef.name,
            isLastStep: true,
        },
    };
}

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

// ─── Status Formatting Helpers ───
// These are pure presentation functions extracted from get-project-status.ts.
// They can be used by any transport layer for consistent formatting.

/** Get status icon for a node. */
export function statusIcon(status: string): string {
    switch (status) {
        case 'completed':
            return '✓';
        case 'active':
            return '●';
        case 'failed':
            return '✗';
        case 'cancelled':
            return '—';
        case 'skipped':
            return '⊘';
        default:
            return '○';
    }
}

/** Format the workflow tree as an indented status view. */
export function formatNodeTree(
    node: WorkflowNode,
    nodes: Record<string, NodeState>,
    dispatches: DispatchRecord[],
    depth: number = 0,
): string[] {
    const indent = '  '.repeat(depth);
    const lines: string[] = [];
    const state = nodes[node.id];
    const status = state?.status ?? 'pending';
    const icon = statusIcon(status);

    switch (node.type) {
        case 'task': {
            const dispatchInfo = getNodeDispatchInfo(node.id, dispatches);
            lines.push(indent + icon + ' ' + node.id + ' (task, ' + node.role + ') — ' + status + dispatchInfo);
            break;
        }
        case 'sequence':
            lines.push(indent + icon + ' ' + node.id + ' (sequence) — ' + status);
            for (const child of node.children) {
                lines.push(...formatNodeTree(child, nodes, dispatches, depth + 1));
            }
            break;
        case 'parallel':
            lines.push(indent + icon + ' ' + node.id + ' (parallel, ' + node.failStrategy + ') — ' + status);
            for (const child of node.children) {
                lines.push(...formatNodeTree(child, nodes, dispatches, depth + 1));
            }
            break;
        case 'gate': {
            const gateStatus = status === 'completed' ? 'passed' : status === 'failed' ? 'failed' : status;
            lines.push(indent + icon + ' ' + node.id + ' (gate) — ' + gateStatus);
            lines.push(...formatNodeTree(node.pass, nodes, dispatches, depth + 1));
            if ('type' in node.fail) {
                lines.push(...formatNodeTree(node.fail as WorkflowNode, nodes, dispatches, depth + 1));
            } else {
                const failTarget = node.fail as { goto: string };
                lines.push(indent + '  ↩ fail → goto ' + failTarget.goto);
            }
            break;
        }
        case 'loop': {
            const loopState = state as LoopNodeState | undefined;
            const iteration = loopState?.currentIteration ?? 0;
            const done = loopState?.done ? ', done marked' : '';
            lines.push(
                indent +
                    icon +
                    ' ' +
                    node.id +
                    ' (loop, ' +
                    iteration +
                    '/' +
                    node.maxIterations +
                    done +
                    ') — ' +
                    status,
            );
            lines.push(...formatNodeTree(node.body, nodes, dispatches, depth + 1));
            break;
        }
    }

    return lines;
}

function getNodeDispatchInfo(nodeId: string, dispatches: DispatchRecord[]): string {
    const nodeDispatches = dispatches.filter(
        (d) => d.nodeId === nodeId && (d.status === 'dispatched' || d.status === 'running'),
    );
    if (nodeDispatches.length === 0) return '';
    const info = nodeDispatches.map((d) => d.id + ':' + d.status).join(', ');
    return ' [' + info + ']';
}

/** Format a dispatch record for display. */
export function formatDispatch(d: DispatchRecord, sessions: SessionRecord[]): string {
    const icon = statusIcon(d.status === 'dispatched' ? 'pending' : d.status === 'running' ? 'active' : d.status);
    const session = sessions.find((s) => s.id === d.sessionId);
    const sessionInfo = session?.agentSessionId ? ' session:' + session.agentSessionId : '';
    const note = d.note ? ' (' + d.note + ')' : '';
    const nodeInfo = d.nodeId ? ' node:' + d.nodeId : '';
    const brief = d.taskBrief.length > 60 ? d.taskBrief.slice(0, 57) + '...' : d.taskBrief;
    return (
        '  ' +
        icon +
        ' ' +
        d.id +
        '  ' +
        d.role.padEnd(12) +
        ' [' +
        d.status +
        ']  ' +
        brief +
        nodeInfo +
        sessionInfo +
        note
    );
}

/** Format a session record for display. */
export function formatSession(s: SessionRecord): string {
    const agentInfo = s.agentSessionId ? 'agent:' + s.agentSessionId : 'no agent ID';
    const label = s.label ? ' (' + s.label + ')' : '';
    const agentType = s.agentType ? ' via ' + s.agentType : '';
    return '  ' + s.id + '  ' + s.role.padEnd(12) + ' [' + s.status + ']  ' + agentInfo + agentType + label;
}

/** Format step progress for a sequential artifact. */
export function formatStepProgress(artifactDef: ArtifactDefinition, stepState: ArtifactStepState | undefined): string {
    const steps = artifactDef.steps!;
    const completedIds = stepState ? getCompletedStepIds(stepState) : new Set<string>();
    const finalized = stepState?.finalized ?? false;

    if (finalized) {
        return '  Steps: all completed ✓ (finalized)';
    }

    let firstIncomplete = steps.length;
    for (let i = 0; i < steps.length; i++) {
        if (!completedIds.has(steps[i].id)) {
            firstIncomplete = i;
            break;
        }
    }

    const parts = steps.map((s, i) => {
        if (completedIds.has(s.id)) return '[✓] ' + s.name;
        if (i === firstIncomplete) return '[→] ' + s.name;
        return '[ ] ' + s.name;
    });

    return '  Steps: ' + parts.join(' → ');
}

/** Format artifacts summary. */
export function formatArtifactsSummary(
    existingArtifacts: string[],
    artifactDefs: Record<string, ArtifactDefinition>,
    reviews: Record<string, { status: string; submittedAt: string }>,
    stepsData: Record<string, ArtifactStepState>,
): string {
    if (existingArtifacts.length === 0) return '(none yet)';

    return existingArtifacts
        .map((id) => {
            const review = reviews[id];
            const reviewTag = review ? ' [' + review.status + ']' : '';
            const def = artifactDefs[id];
            const hasSteps = def?.steps && def.steps.length > 0;
            let line = '- ' + id + reviewTag;
            if (hasSteps) {
                line += '\n' + formatStepProgress(def, stepsData[id]);
            }
            return line;
        })
        .join('\n');
}

/** Format in-progress artifacts (steps started but artifact not yet finalized). */
export function formatInProgressArtifacts(
    existingArtifacts: string[],
    artifactDefs: Record<string, ArtifactDefinition>,
    stepsData: Record<string, ArtifactStepState>,
): string {
    const inProgress = Object.keys(stepsData)
        .filter((id) => !existingArtifacts.includes(id))
        .map((id) => {
            const def = artifactDefs[id];
            if (!def?.steps?.length) return null;
            const stepState = stepsData[id];
            const completedCount = stepState?.completedSteps.length ?? 0;
            if (completedCount === 0) return null;
            return (
                '- ' +
                id +
                ' (in progress, ' +
                completedCount +
                '/' +
                def.steps.length +
                ' steps)\n' +
                formatStepProgress(def, stepState)
            );
        })
        .filter(Boolean);

    return inProgress.length > 0 ? inProgress.join('\n') : '';
}

// ─── getProjectStatus / getProjectList ───

/**
 * Get detailed project status data.
 *
 * Extracted from: src/tools/get-project-status.ts (detail mode)
 *
 * Returns raw structured data — the API layer handles formatting.
 */
export async function getProjectStatus(workflowsDir: string, projectName: string): Promise<ProjectStatusData> {
    const entry = await getProject(projectName);
    if (!entry) {
        throw new Error(`项目 "${projectName}" 未注册。`);
    }

    if (!entry.activeContext) {
        throw new ValidationError(
            `项目 "${projectName}" 已注册但无活跃上下文。` +
                `迭代: ${entry.totalIterations}, 补丁: ${entry.totalPatches}。` +
                `请开始迭代或补丁。`,
        );
    }

    const resolved = resolveContextDir(projectName, entry.activeContext);
    if (!resolved) {
        throw new Error(`项目 "${projectName}" 的 activeContext "${entry.activeContext}" 无法解析。数据可能已损坏。`);
    }

    const contextDir = resolved.dir;
    const contextNumber = resolved.number;
    const state = await readState(projectName, contextNumber, contextDir);
    const wf = await loadWorkflow(workflowsDir, state.workflow);
    const statusIoCtx: ArtifactIOContext = {
        contextDir,
        projectDir: entry.dir,
        contextLabel: entry.activeContext,
    };
    const artifactIds = await listArtifacts(statusIoCtx, wf.artifactDefinitions);
    const reviews = await readReviews(projectName, contextNumber, contextDir);
    const dispatches = await readDispatches(projectName, contextNumber, contextDir);
    const sessions = await readSessions(projectName, contextNumber, contextDir);
    const stepsData = await readSteps(projectName, contextNumber, contextDir);
    const issues = await readIssues(projectName);

    // Workflow tree view
    const treeLines = formatNodeTree(wf.definition.root, state.nodes, dispatches);

    // Floating nodes
    if (wf.definition.floatingNodes && wf.definition.floatingNodes.length > 0) {
        treeLines.push('');
        treeLines.push('Floating nodes:');
        for (const fn of wf.definition.floatingNodes) {
            const fnState = state.nodes[fn.id];
            const fnStatus = fnState?.status ?? 'pending';
            const fnIcon = statusIcon(fnStatus);
            treeLines.push(`  ${fnIcon} ${fn.id} (task, ${fn.role}) \u2014 ${fnStatus}`);
        }
    }

    // Engine nextAction
    let nextActionText = '';
    try {
        const ctx: ResolvedContext = {
            entry,
            number: contextNumber,
            dir: contextDir,
            type: resolved.type as 'iteration' | 'patch',
            activeContext: entry.activeContext!,
        };
        const engineResult = await processWorkflowEvent(workflowsDir, projectName, ctx, {
            type: 'query_status',
        });
        nextActionText = formatNextAction(engineResult.nextAction);
    } catch {
        nextActionText = '\n[Next Action] (could not compute — engine error)';
    }

    return {
        projectName: state.projectName,
        projectDir: state.projectDir,
        workflow: state.workflow,
        activeContext: entry.activeContext,
        contextType: resolved.type,
        contextNumber,
        currentIteration: entry.currentIteration,
        totalIterations: entry.totalIterations,
        currentPatch: entry.currentPatch,
        totalPatches: entry.totalPatches,
        activeNodeId: state.activeNodeId ?? null,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        treeLines,
        artifactIds,
        artifactDefs: wf.artifactDefinitions,
        reviews,
        stepsData,
        dispatches,
        sessions,
        issues,
        nextAction: nextActionText,
    };
}

/**
 * Get project list summary.
 *
 * Extracted from: src/tools/get-project-status.ts (list mode)
 */
export async function getProjectList(): Promise<ProjectListItem[]> {
    const projectNames = await listProjects();

    if (projectNames.length === 0) {
        return [];
    }

    const items: ProjectListItem[] = [];
    for (const name of projectNames) {
        try {
            const entry = await getProject(name);
            if (!entry || !entry.activeContext) {
                items.push({
                    name,
                    dir: entry?.dir ?? '?',
                    activeContext: entry?.activeContext || undefined,
                });
                continue;
            }
            const resolved = resolveContextDir(name, entry.activeContext);
            if (!resolved) {
                items.push({ name, dir: entry.dir, error: 'context error' });
                continue;
            }
            const state = await readState(name, resolved.number, resolved.dir);
            items.push({
                name,
                dir: state.projectDir,
                workflow: state.workflow,
                activeNode: state.activeNodeId ?? undefined,
                activeContext: entry.activeContext,
                updatedAt: state.updatedAt.split('T')[0],
            });
        } catch {
            items.push({ name, dir: '?', error: 'cannot read state' });
        }
    }

    return items;
}
