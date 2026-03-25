/**
 * Project Lifecycle Operations — project init, iteration start, patch start.
 *
 * Extracted from the monolithic operations.ts during the 008 split.
 */

import { createKit, defineHooks, type HookSet, type HookInstallResult } from '@s_s/agent-kit';
import { detectAgent, type AgentType } from '@s_s/agent-kit';
import { loadWorkflow, listWorkflows } from '../plugin.js';
import {
    registerProject,
    getProject,
    getGlobalDir,
    startIteration,
    startPatch,
    getIterationDir,
    getPatchDir,
    resolveContextDir,
} from '../registry.js';
import { initWorkflowState, readState, persistState } from '../state.js';
import { startWorkflow } from '../workflow-engine.js';
import type { EngineContext, GateContext } from '../workflow-engine.js';
import { formatNextAction } from '../engine-helpers.js';
import type { HookCreatorContext } from '../types.js';
import type { InitProjectResult, BeginIterationResult, BeginPatchResult, WorkflowChoice } from './types.js';
import { WorkflowSelectionRequired, ValidationError } from './types.js';

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
