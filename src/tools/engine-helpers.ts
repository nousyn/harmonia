/**
 * Shared engine helpers for tool handlers.
 *
 * Provides a workflow engine integration layer so that individual tools
 * can trigger engine events (artifact_written, artifact_approved, etc.)
 * and receive the computed nextAction.
 */

import { readState, persistState } from '../core/state.js';
import { loadWorkflow } from '../core/plugin.js';
import { listArtifacts, readArtifact } from '../core/artifacts.js';
import type { ArtifactIOContext } from '../core/artifacts.js';
import { readReviews } from '../core/reviews.js';
import { computeNextAction } from '../core/workflow-engine.js';
import type { EngineContext, GateContext } from '../core/workflow-engine.js';
import type {
    WorkflowState,
    WorkflowEvent,
    NextAction,
    WorkflowPlugin,
    WorkflowNode,
    TaskNode,
} from '../core/types.js';
import type { ResolvedContext } from './utils.js';

/** Result of processing a workflow event through the engine */
export interface EngineResult {
    /** Updated workflow state (already persisted) */
    state: WorkflowState;
    /** What the coordinator should do next */
    nextAction: NextAction;
}

/**
 * Resolve a dot-separated field path on a JSON object.
 * e.g. "result" on { result: "pass" } → "pass"
 * e.g. "stats.total" on { stats: { total: 10 } } → 10
 */
function resolveFieldPath(obj: unknown, path: string): unknown {
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
 * This provides the artifact existence/approval/field checks
 * that the engine needs for gate evaluation.
 *
 * For artifact_field conditions, pre-loads and caches all existing
 * JSON artifact contents so field access can be synchronous.
 */
function buildGateContext(
    projectName: string,
    iteration: number,
    contextDir: string,
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
async function buildEngineContext(
    projectName: string,
    iteration: number,
    contextDir: string,
    wf: WorkflowPlugin,
    ioCtx: ArtifactIOContext,
): Promise<EngineContext> {
    // Load current artifacts and reviews for gate evaluation
    const artifactList = await listArtifacts(ioCtx, wf.artifactDefinitions);
    const existingArtifacts = new Set(artifactList);
    const reviews = await readReviews(projectName, iteration, contextDir);

    // Pre-load artifact content for field access (JSON artifacts only)
    const artifactCache = new Map<string, unknown>();
    for (const artifactId of artifactList) {
        const artifactDef = wf.artifactDefinitions[artifactId];
        try {
            const content = await readArtifact(artifactId, ioCtx, artifactDef);
            // Try to parse as JSON; if it fails, store raw string
            try {
                artifactCache.set(artifactId, JSON.parse(content));
            } catch {
                artifactCache.set(artifactId, content);
            }
        } catch {
            // Artifact listed but unreadable — skip
        }
    }

    const gateCtx = buildGateContext(projectName, iteration, contextDir, existingArtifacts, reviews, artifactCache);

    return {
        gate: gateCtx,
        getRolePrompt: (role: string, nodeId: string) => {
            const roleDef = wf.roles[role];
            return roleDef?.prompt ?? `Role "${role}" prompt not found`;
        },
    };
}

/**
 * Collect all task nodes from a workflow tree (recursive).
 */
export function collectTaskNodes(node: WorkflowNode): TaskNode[] {
    const tasks: TaskNode[] = [];
    switch (node.type) {
        case 'task':
            tasks.push(node);
            break;
        case 'sequence':
        case 'parallel':
            for (const child of node.children) {
                tasks.push(...collectTaskNodes(child));
            }
            break;
        case 'gate':
            tasks.push(...collectTaskNodes(node.pass));
            if ('type' in node.fail) {
                tasks.push(...collectTaskNodes(node.fail as WorkflowNode));
            }
            break;
        case 'loop':
            tasks.push(...collectTaskNodes(node.body));
            break;
    }
    return tasks;
}

/**
 * Find a task node by ID in the workflow definition (including floating nodes).
 */
export function findTaskNode(wf: WorkflowPlugin, nodeId: string): TaskNode | undefined {
    const allTasks = collectTaskNodes(wf.definition.root);
    const found = allTasks.find((t) => t.id === nodeId);
    if (found) return found;
    // Check floating nodes
    return wf.definition.floatingNodes?.find((fn) => fn.id === nodeId);
}

/**
 * Process a workflow event through the engine.
 *
 * 1. Loads current state + workflow plugin
 * 2. Builds engine context (gate evaluation, role prompts)
 * 3. Calls computeNextAction
 * 4. Persists updated state
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

    // Skip persisting state for read-only events (query_status doesn't modify state)
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
 * Format a nextAction into a human-readable message for the tool response.
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
            // No specific next action
            break;
    }

    return lines.join('\n');
}
