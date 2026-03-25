/**
 * Engine integration helpers — migrated from src/tools/engine-helpers.ts
 * and src/tools/utils.ts for use by the Orchestrator and HTTP API layers.
 *
 * This module provides:
 * - ResolvedContext: project context resolution
 * - Gate/Engine context building
 * - Workflow event processing (state load → engine compute → persist)
 * - Utility functions (findTaskNode, formatNextAction, buildOverrideSection)
 */

import { readState, persistState } from './state.js';
import { loadWorkflow } from './plugin.js';
import { listArtifacts, readArtifact } from './artifacts.js';
import type { ArtifactIOContext } from './artifacts.js';
import { readReviews } from './reviews.js';
import { computeNextAction } from './workflow-engine.js';
import type { EngineContext, GateContext } from './workflow-engine.js';
import type {
    WorkflowState,
    WorkflowEvent,
    NextAction,
    WorkflowPlugin,
    TaskNode,
    CapabilityOverride,
    OverrideConfig,
} from './types.js';
import { collectTaskNodes } from './tree-utils.js';
import { getProject, resolveContextDir } from './registry.js';
import type { ProjectEntry } from './registry.js';

// ─── ResolvedContext (from tools/utils.ts) ───

/** Resolved project context — iteration or patch. */
export interface ResolvedContext {
    entry: ProjectEntry;
    /** The iteration or patch number */
    number: number;
    /** "iteration" or "patch" */
    type: 'iteration' | 'patch';
    /** Absolute path to the context directory (iter-N/ or patch-N/) */
    dir: string;
    /** The raw activeContext string, e.g. "iter-1" or "patch-2" */
    activeContext: string;
}

/**
 * Resolve the active context for a project.
 * Throws an error on failure.
 */
export async function resolveActive(projectName: string): Promise<ResolvedContext> {
    const entry = await getProject(projectName);

    if (!entry) {
        throw new Error(`项目 "${projectName}" 未注册。请先调用 project_init 注册项目。`);
    }

    if (!entry.activeContext) {
        throw new Error(`项目 "${projectName}" 尚未开始迭代或补丁。请先调用 iteration_start 或 patch_start。`);
    }

    const resolved = resolveContextDir(projectName, entry.activeContext);
    if (!resolved) {
        throw new Error(`项目 "${projectName}" 的 activeContext "${entry.activeContext}" 无法解析。数据可能已损坏。`);
    }

    return {
        entry,
        number: resolved.number,
        type: resolved.type,
        dir: resolved.dir,
        activeContext: entry.activeContext,
    };
}

// ─── Engine Result & Helpers (from tools/engine-helpers.ts) ───

/** Result of processing a workflow event through the engine. */
export interface EngineResult {
    /** Updated workflow state (already persisted) */
    state: WorkflowState;
    /** What the orchestrator should do next */
    nextAction: NextAction;
}

/**
 * Resolve a dot-separated field path on a JSON object.
 * e.g. "result" on { result: "pass" } → "pass"
 * e.g. "stats.total" on { stats: { total: 10 } } → 10
 */
export function resolveFieldPath(obj: unknown, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;
    for (const part of parts) {
        if (current === null || current === undefined || typeof current !== 'object') {
            return undefined;
        }
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}

/**
 * Build a GateContext from the current project state.
 * Provides artifact existence/approval/field checks for gate evaluation.
 */
export function buildGateContext(
    existingArtifacts: Set<string>,
    reviews: Record<string, { status: string }>,
    artifactCache: Map<string, unknown>,
): GateContext {
    return {
        artifactExists: (artifactId: string) => existingArtifacts.has(artifactId),
        artifactApproved: (artifactId: string) => reviews[artifactId]?.status === 'approved',
        artifactField: (artifactId: string, field: string) => {
            const content = artifactCache.get(artifactId);
            if (content === undefined) return undefined;
            return resolveFieldPath(content, field);
        },
    };
}

/**
 * Build the full EngineContext needed for engine operations.
 * Pre-loads artifact content for field-based gate evaluation.
 */
export async function buildEngineContext(
    projectName: string,
    iteration: number,
    contextDir: string,
    wf: WorkflowPlugin,
    ioCtx: ArtifactIOContext,
): Promise<EngineContext> {
    const artifactList = await listArtifacts(ioCtx, wf.artifactDefinitions);
    const existingArtifacts = new Set(artifactList);
    const reviews = await readReviews(projectName, iteration, contextDir);

    // Pre-load artifact content for field access (JSON artifacts only)
    const artifactCache = new Map<string, unknown>();
    for (const artifactId of artifactList) {
        const artifactDef = wf.artifactDefinitions[artifactId];
        try {
            const content = await readArtifact(artifactId, ioCtx, artifactDef);
            try {
                artifactCache.set(artifactId, JSON.parse(content));
            } catch {
                artifactCache.set(artifactId, content);
            }
        } catch {
            // Artifact listed but unreadable — skip
        }
    }

    const gateCtx = buildGateContext(existingArtifacts, reviews, artifactCache);

    return {
        gate: gateCtx,
        getRolePrompt: (role: string, _nodeId: string) => {
            const roleDef = wf.roles[role];
            return roleDef?.prompt ?? `Role "${role}" prompt not found`;
        },
    };
}

/**
 * Find a task node by ID in the workflow definition (including floating nodes).
 */
export function findTaskNode(wf: WorkflowPlugin, nodeId: string): TaskNode | undefined {
    const allTasks = collectTaskNodes(wf.definition.root);
    const found = allTasks.find((t) => t.id === nodeId);
    if (found) return found;
    return wf.definition.floatingNodes?.find((fn) => fn.id === nodeId);
}

/**
 * Process a workflow event through the engine.
 *
 * 1. Loads current state + workflow plugin
 * 2. Builds engine context (gate evaluation, role prompts)
 * 3. Calls computeNextAction
 * 4. Persists updated state (except for query_status)
 * 5. Returns the nextAction
 */
export async function processWorkflowEvent(
    workflowsDir: string,
    projectName: string,
    ctx: ResolvedContext,
    event: WorkflowEvent,
): Promise<EngineResult> {
    const state = await readState(projectName, ctx.number, ctx.dir);
    const wf = await loadWorkflow(workflowsDir, state.workflow);
    const ioCtx: ArtifactIOContext = {
        contextDir: ctx.dir,
        projectDir: ctx.entry.dir,
        contextLabel: ctx.activeContext,
    };
    const engineCtx = await buildEngineContext(projectName, ctx.number, ctx.dir, wf, ioCtx);

    const result = computeNextAction(wf.definition, state, event, engineCtx);

    // Skip persisting state for read-only events
    if (event.type !== 'query_status') {
        await persistState(projectName, ctx.number, result.state, ctx.dir);
    }

    return {
        state: result.state,
        nextAction: result.nextAction,
    };
}

/**
 * Load the workflow plugin for a resolved context.
 */
export async function loadWorkflowForContext(
    workflowsDir: string,
    projectName: string,
    ctx: ResolvedContext,
): Promise<{ wf: WorkflowPlugin; state: WorkflowState }> {
    const state = await readState(projectName, ctx.number, ctx.dir);
    const wf = await loadWorkflow(workflowsDir, state.workflow);
    return { wf, state };
}

/**
 * Format a nextAction into a human-readable message.
 */
export function formatNextAction(nextAction: NextAction): string {
    const lines: string[] = [];

    switch (nextAction.type) {
        case 'dispatch':
            if (nextAction.parallelDispatch && nextAction.parallelDispatch.length > 1) {
                lines.push(`\n[Next Action] Parallel dispatch: ${nextAction.parallelDispatch.length} tasks`);
                for (const d of nextAction.parallelDispatch) {
                    lines.push(`  - role "${d.role}" for node "${d.nodeId}"`);
                }
            } else {
                lines.push(`\n[Next Action] Dispatch role "${nextAction.role}" for node "${nextAction.nodeId}"`);
            }
            if (nextAction.instructions) lines.push(nextAction.instructions);
            break;
        case 'write_artifact':
            lines.push(`\n[Next Action] Write artifact`);
            if (nextAction.instructions) lines.push(nextAction.instructions);
            break;
        case 'approve_artifact':
            lines.push(`\n[Next Action] Approve artifact`);
            if (nextAction.instructions) lines.push(nextAction.instructions);
            break;
        case 'wait':
            lines.push(`\n[Next Action] ${nextAction.instructions}`);
            break;
        case 'completed':
            lines.push(`\n[Next Action] Workflow completed!`);
            break;
        case 'failed':
            lines.push(`\n[Workflow Failed] ${nextAction.instructions}`);
            break;
        case 'evaluate_gate':
            lines.push(`\n[Next Action] Evaluate gate "${nextAction.nodeId}"`);
            if (nextAction.instructions) lines.push(nextAction.instructions);
            break;
        case 'none':
            break;
    }

    return lines.join('\n');
}

// ─── Override Section (from tools/utils.ts) ───

/**
 * Build override instructions to inject into a role prompt.
 */
export function buildOverrideSection(roleId: string, overrides: OverrideConfig): string {
    const roleOverrides = overrides.roles?.[roleId]?.capabilities;
    if (!roleOverrides || Object.keys(roleOverrides).length === 0) {
        return '';
    }

    const lines: string[] = [
        '',
        '## Enhanced Capabilities',
        '',
        'The following capabilities have been configured to use external tools.',
        'Use the specified tool instead of built-in behavior for these actions.',
        '',
    ];

    for (const [capId, override] of Object.entries(roleOverrides)) {
        const o = override as CapabilityOverride;
        const toolRef =
            o.type === 'mcp' && o.server
                ? `\`${o.server}\` MCP server's \`${o.tool}\` tool`
                : `\`${o.tool}\` skill tool`;

        let instruction = `- **${capId}**: Use ${toolRef}`;

        if (o.params && Object.keys(o.params).length > 0) {
            const paramStr = Object.entries(o.params)
                .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                .join(', ');
            instruction += ` with fixed parameters: ${paramStr}`;
        }

        if (o.notes) {
            instruction += `. Note: ${o.notes}`;
        }

        lines.push(instruction);
    }

    return lines.join('\n');
}
