/**
 * Shared engine helpers for tool handlers.
 *
 * Provides a workflow engine integration layer so that individual tools
 * can trigger engine events (artifact_written, artifact_approved, etc.)
 * and receive the computed nextAction.
 */

import { readState, persistState } from '../core/state.js';
import { loadWorkflow } from '../core/workflow.js';
import { listDocs, readDoc } from '../core/docs.js';
import { readReviews } from '../core/reviews.js';
import { computeNextAction, startWorkflow } from '../core/workflow-engine.js';
import type { EngineContext, GateContext } from '../core/workflow-engine.js';
import type { WorkflowState, WorkflowEvent, NextAction, WorkflowPlugin } from '../core/types.js';
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
    existingDocs: Set<string>,
    reviews: Record<string, { status: string }>,
    artifactCache: Map<string, unknown>,
): GateContext {
    return {
        artifactExists: (artifactId: string) => existingDocs.has(artifactId),
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
): Promise<EngineContext> {
    // Load current docs and reviews for gate evaluation
    const docList = await listDocs(projectName, iteration, contextDir);
    const existingDocs = new Set(docList);
    const reviews = await readReviews(projectName, iteration, contextDir);

    // Pre-load artifact content for field access (JSON artifacts only)
    const artifactCache = new Map<string, unknown>();
    for (const docId of docList) {
        try {
            const content = await readDoc(projectName, iteration, docId, contextDir);
            // Try to parse as JSON; if it fails, store raw string
            try {
                artifactCache.set(docId, JSON.parse(content));
            } catch {
                artifactCache.set(docId, content);
            }
        } catch {
            // Artifact listed but unreadable — skip
        }
    }

    const gateCtx = buildGateContext(projectName, iteration, contextDir, existingDocs, reviews, artifactCache);

    return {
        gate: gateCtx,
        getRolePrompt: (role: string, nodeId: string) => {
            const roleDef = wf.roles[role];
            return roleDef?.prompt ?? `Role "${role}" prompt not found`;
        },
        getInputArtifacts: (_nodeId: string) => {
            // Input artifacts will be determined by the workflow plugin in Phase 4.
            // For now return an empty array.
            return [];
        },
    };
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
    builtinDir: string,
    customDir: string,
    projectName: string,
    ctx: ResolvedContext,
    event: WorkflowEvent,
): Promise<EngineResult> {
    const state = await readState(projectName, ctx.number, ctx.dir);
    const wf = await loadWorkflow(builtinDir, customDir, state.workflow);
    const engineCtx = await buildEngineContext(projectName, ctx.number, ctx.dir, wf);

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
    builtinDir: string,
    customDir: string,
    projectName: string,
    ctx: ResolvedContext,
): Promise<{ wf: WorkflowPlugin; state: WorkflowState }> {
    const state = await readState(projectName, ctx.number, ctx.dir);
    const wf = await loadWorkflow(builtinDir, customDir, state.workflow);
    return { wf, state };
}

/**
 * Format a nextAction into a human-readable message for the tool response.
 */
export function formatNextAction(nextAction: NextAction): string {
    const lines: string[] = [];

    switch (nextAction.type) {
        case 'dispatch':
            lines.push(`\n[Next Action] Dispatch role "${nextAction.role}" for node "${nextAction.nodeId}"`);
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
