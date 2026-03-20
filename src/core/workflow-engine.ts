/**
 * Workflow engine — core state machine for node-based workflow execution.
 *
 * This module handles:
 * - Node state initialization from a WorkflowDefinition
 * - State transitions based on WorkflowEvents
 * - NextAction computation (telling the coordinator what to do)
 * - Gate evaluation
 * - Goto execution (state reset + retry tracking)
 * - Failure handling (onFailed, bubbling, onExhausted)
 *
 * Key insight: Core is passive (MCP server). Every interaction is
 * coordinator-driven. Engine computes state changes and returns nextAction,
 * but never proactively pushes the workflow forward.
 */

import type {
    WorkflowDefinition,
    WorkflowNode,
    TaskNode,
    SequenceNode,
    ParallelNode,
    GateNode,
    GotoTarget,
    FailureHandler,
    WorkflowState,
    NodeState,
    NextAction,
    WorkflowEvent,
    GateCondition,
    GateConditionResult,
    GateEvaluationResult,
} from './types.js';

// ─── Types ───

/** Context needed for gate evaluation */
export interface GateContext {
    /** Check if an artifact exists */
    artifactExists: (artifactId: string) => boolean;
    /** Check if an artifact is approved */
    artifactApproved: (artifactId: string) => boolean;
    /** Read a field from an artifact (returns undefined if not found) */
    artifactField: (artifactId: string, field: string) => unknown;
}

/** Context needed by the engine for computing next actions */
export interface EngineContext {
    /** Gate evaluation context */
    gate: GateContext;
    /** Get role prompt (assembled by plugin layer) */
    getRolePrompt?: (role: string, nodeId: string, gateResults?: GateEvaluationResult) => string;
    /** Get input artifact IDs for a node */
    getInputArtifacts?: (nodeId: string) => string[];
}

// ─── Node State Initialization ───

/**
 * Initialize node states for all nodes in a workflow definition.
 * All nodes start as 'pending', except the first actionable node
 * which will be activated when the workflow begins.
 */
export function initNodeStates(definition: WorkflowDefinition): Record<string, NodeState> {
    const states: Record<string, NodeState> = {};
    collectNodeStates(definition.root, states);
    if (definition.floatingNodes) {
        for (const fn of definition.floatingNodes) {
            states[fn.id] = createNodeState(fn.id);
        }
    }
    return states;
}

function collectNodeStates(node: WorkflowNode, states: Record<string, NodeState>): void {
    states[node.id] = createNodeState(node.id);
    switch (node.type) {
        case 'sequence':
        case 'parallel':
            for (const child of node.children) {
                collectNodeStates(child, states);
            }
            break;
        case 'gate':
            collectNodeStates(node.pass, states);
            if ('type' in node.fail) {
                collectNodeStates(node.fail as WorkflowNode, states);
            }
            break;
        case 'task':
            break;
    }
}

function createNodeState(id: string): NodeState {
    return {
        id,
        status: 'pending',
        retryCount: 0,
    };
}

// ─── Start Workflow ───

/**
 * Start the workflow — activate the root node and return the first nextAction.
 */
export function startWorkflow(
    definition: WorkflowDefinition,
    state: WorkflowState,
    context: EngineContext,
): { state: WorkflowState; nextAction: NextAction } {
    const now = new Date().toISOString();
    const newState = { ...state, nodes: { ...state.nodes }, updatedAt: now };

    return activateNode(definition.root, definition, newState, context);
}

// ─── Compute Next Action ───

/**
 * Process a workflow event and compute the next action.
 * This is the main entry point for all state transitions.
 */
export function computeNextAction(
    definition: WorkflowDefinition,
    state: WorkflowState,
    event: WorkflowEvent,
    context: EngineContext,
): { state: WorkflowState; nextAction: NextAction } {
    const now = new Date().toISOString();
    const newState = { ...state, nodes: { ...state.nodes }, updatedAt: now };

    switch (event.type) {
        case 'node_completed':
            return completeNode(newState, definition, event.nodeId, context, event.result);

        case 'node_failed':
            return failNode(newState, definition, event.nodeId, event.error, context);

        case 'artifact_written':
        case 'artifact_approved':
            // These events might trigger gate re-evaluation
            return reevaluateGates(newState, definition, context);

        case 'dispatch_requested':
            return handleDispatchRequest(newState, definition, event.nodeId, context);

        case 'query_status':
            return { state: newState, nextAction: computeStatusAction(newState, definition, context) };
    }
}

// ─── Node Activation ───

/**
 * Activate a node — set it to 'active' and determine what action to take.
 */
function activateNode(
    node: WorkflowNode,
    definition: WorkflowDefinition,
    state: WorkflowState,
    context: EngineContext,
    gateResults?: GateEvaluationResult,
): { state: WorkflowState; nextAction: NextAction } {
    const now = new Date().toISOString();
    state.nodes[node.id] = {
        ...state.nodes[node.id],
        status: 'active',
        startedAt: now,
    };

    switch (node.type) {
        case 'task':
            return activateTask(node, state, context, gateResults);

        case 'sequence':
            return activateSequence(node, definition, state, context);

        case 'parallel':
            return activateParallel(node, definition, state, context);

        case 'gate':
            return activateGate(node, definition, state, context);
    }
}

function activateTask(
    node: TaskNode,
    state: WorkflowState,
    context: EngineContext,
    gateResults?: GateEvaluationResult,
): { state: WorkflowState; nextAction: NextAction } {
    state.activeNodeId = node.id;

    const rolePrompt = context.getRolePrompt ? context.getRolePrompt(node.role, node.id, gateResults) : undefined;
    const inputArtifacts = context.getInputArtifacts ? context.getInputArtifacts(node.id) : undefined;

    return {
        state,
        nextAction: {
            type: 'dispatch',
            nodeId: node.id,
            role: node.role,
            instructions: `Dispatch role "${node.role}" for task "${node.id}"`,
            rolePrompt,
            inputArtifacts,
            gateResults,
        },
    };
}

function activateSequence(
    node: SequenceNode,
    definition: WorkflowDefinition,
    state: WorkflowState,
    context: EngineContext,
): { state: WorkflowState; nextAction: NextAction } {
    if (node.children.length === 0) {
        // Empty sequence — immediately complete
        return markCompleted(node, definition, state, context);
    }

    // Activate the first child
    return activateNode(node.children[0], definition, state, context);
}

function activateParallel(
    node: ParallelNode,
    definition: WorkflowDefinition,
    state: WorkflowState,
    context: EngineContext,
): { state: WorkflowState; nextAction: NextAction } {
    if (node.children.length === 0) {
        return markCompleted(node, definition, state, context);
    }

    // Activate all children simultaneously
    for (const child of node.children) {
        const result = activateNode(child, definition, state, context);
        state = result.state;
    }

    // Build parallel dispatch list with each child's nodeId and role
    const dispatchActions = node.children
        .filter((c) => c.type === 'task')
        .map((c) => ({
            nodeId: c.id,
            role: (c as TaskNode).role,
        }));

    return {
        state,
        nextAction: {
            type: 'dispatch',
            nodeId: node.id,
            instructions: `Parallel execution: dispatch ${dispatchActions.length} tasks simultaneously: ${dispatchActions.map((d) => `${d.role}(${d.nodeId})`).join(', ')}`,
            role: dispatchActions[0]?.role,
            parallelDispatch: dispatchActions,
        },
    };
}

function activateGate(
    node: GateNode,
    definition: WorkflowDefinition,
    state: WorkflowState,
    context: EngineContext,
): { state: WorkflowState; nextAction: NextAction } {
    const evaluation = evaluateGate(node, context.gate);

    if (evaluation.passed) {
        // Gate passed — activate pass branch
        state.nodes[node.id] = {
            ...state.nodes[node.id],
            status: 'completed',
            completedAt: new Date().toISOString(),
        };
        return activateNode(node.pass, definition, state, context);
    }

    // Gate failed
    if ('goto' in node.fail && !('type' in node.fail)) {
        // fail is a GotoTarget
        const gotoTarget = node.fail as GotoTarget;
        return handleGoto(gotoTarget, node.id, definition, state, context, evaluation);
    } else {
        // fail is an inline WorkflowNode
        state.nodes[node.id] = {
            ...state.nodes[node.id],
            status: 'completed',
            completedAt: new Date().toISOString(),
        };
        return activateNode(node.fail as WorkflowNode, definition, state, context, evaluation);
    }
}

// ─── Node Completion ───

/**
 * Handle node completion: mark as completed, advance to next node.
 */
export function completeNode(
    state: WorkflowState,
    definition: WorkflowDefinition,
    nodeId: string,
    context: EngineContext,
    result?: unknown,
): { state: WorkflowState; nextAction: NextAction } {
    const now = new Date().toISOString();
    state.nodes[nodeId] = {
        ...state.nodes[nodeId],
        status: 'completed',
        completedAt: now,
    };

    // Find the parent node to determine what happens next
    const parentInfo = findParent(definition.root, nodeId);

    if (!parentInfo) {
        // This is the root node completing — workflow is done
        return {
            state,
            nextAction: {
                type: 'completed',
                instructions: 'Workflow completed successfully',
            },
        };
    }

    const { parent } = parentInfo;

    switch (parent.type) {
        case 'sequence':
            return handleSequenceChildComplete(parent, nodeId, definition, state, context);

        case 'parallel':
            return handleParallelChildComplete(parent, definition, state, context);

        case 'gate':
            // Pass/fail branch task completed — gate's work is done
            // Mark gate as completed and check parent
            return markCompleted(parent, definition, state, context);

        default:
            return {
                state,
                nextAction: {
                    type: 'wait',
                    instructions: `Node "${nodeId}" completed, but could not determine next step`,
                },
            };
    }
}

function handleSequenceChildComplete(
    sequence: SequenceNode,
    completedChildId: string,
    definition: WorkflowDefinition,
    state: WorkflowState,
    context: EngineContext,
): { state: WorkflowState; nextAction: NextAction } {
    const childIndex = sequence.children.findIndex((c) => c.id === completedChildId);

    if (childIndex < 0) {
        return {
            state,
            nextAction: {
                type: 'wait',
                instructions: `Child "${completedChildId}" not found in sequence "${sequence.id}"`,
            },
        };
    }

    // Check if there's a next child
    const nextIndex = childIndex + 1;
    if (nextIndex < sequence.children.length) {
        // Activate next child
        return activateNode(sequence.children[nextIndex], definition, state, context);
    }

    // All children completed — mark sequence as completed
    return markCompleted(sequence, definition, state, context);
}

function handleParallelChildComplete(
    parallel: ParallelNode,
    definition: WorkflowDefinition,
    state: WorkflowState,
    context: EngineContext,
): { state: WorkflowState; nextAction: NextAction } {
    // Check if all children are done
    const allDone = parallel.children.every((c) => {
        const childState = state.nodes[c.id];
        return childState?.status === 'completed' || childState?.status === 'failed';
    });

    if (!allDone) {
        return {
            state,
            nextAction: {
                type: 'wait',
                nodeId: parallel.id,
                instructions: `Parallel node "${parallel.id}": waiting for remaining tasks to complete`,
            },
        };
    }

    // Check for failures
    const failures = parallel.children.filter((c) => state.nodes[c.id]?.status === 'failed');

    if (failures.length > 0) {
        // Parallel has failures — treat as failed
        return failNode(
            state,
            definition,
            parallel.id,
            `${failures.length} child node(s) failed: ${failures.map((f) => f.id).join(', ')}`,
            context,
        );
    }

    // All succeeded
    return markCompleted(parallel, definition, state, context);
}

/**
 * Mark a node as completed and propagate up.
 */
function markCompleted(
    node: WorkflowNode,
    definition: WorkflowDefinition,
    state: WorkflowState,
    context: EngineContext,
): { state: WorkflowState; nextAction: NextAction } {
    const now = new Date().toISOString();
    state.nodes[node.id] = {
        ...state.nodes[node.id],
        status: 'completed',
        completedAt: now,
    };

    // Propagate up — find parent and handle completion there
    const parentInfo = findParent(definition.root, node.id);
    if (!parentInfo) {
        // Root completed
        return {
            state,
            nextAction: {
                type: 'completed',
                instructions: 'Workflow completed successfully',
            },
        };
    }

    return completeNode(state, definition, node.id, context);
}

// ─── Node Failure Handling ───

/**
 * Handle node failure: check onFailed handler, process goto or bubble up.
 *
 * Failure flow:
 * 1. If node has onFailed with goto → try goto (with retry tracking)
 * 2. If goto maxRetries exhausted → jump to onExhausted floating node
 * 3. If no onFailed → bubble failure up to parent
 */
function failNode(
    state: WorkflowState,
    definition: WorkflowDefinition,
    nodeId: string,
    error: string,
    context: EngineContext,
): { state: WorkflowState; nextAction: NextAction } {
    const now = new Date().toISOString();
    state.nodes[nodeId] = {
        ...state.nodes[nodeId],
        status: 'failed',
        completedAt: now,
        error,
    };

    // Find the node to check for onFailed
    const node = findNode(definition.root, nodeId, definition.floatingNodes);
    if (!node) {
        return {
            state,
            nextAction: {
                type: 'wait',
                instructions: `Node "${nodeId}" failed but could not be found in definition: ${error}`,
            },
        };
    }

    // Check if the node has onFailed handler
    const failureHandler = getFailureHandler(node);
    if (failureHandler) {
        return handleFailureHandler(failureHandler, nodeId, definition, state, context, error);
    }

    // No onFailed — bubble failure up to parent
    return bubbleFailure(nodeId, error, definition, state, context);
}

/**
 * Get the failure handler from a node (only task and parallel have onFailed).
 */
function getFailureHandler(node: WorkflowNode): FailureHandler | undefined {
    if (node.type === 'task' || node.type === 'parallel') {
        return node.onFailed;
    }
    return undefined;
}

/**
 * Process a FailureHandler (goto with retry tracking).
 */
function handleFailureHandler(
    handler: FailureHandler,
    failedNodeId: string,
    definition: WorkflowDefinition,
    state: WorkflowState,
    context: EngineContext,
    error: string,
): { state: WorkflowState; nextAction: NextAction } {
    // Check retry count for the goto target
    const targetState = state.nodes[handler.goto];
    const currentRetries = targetState?.retryCount ?? 0;

    if (handler.maxRetries !== undefined && currentRetries >= handler.maxRetries) {
        // Retries exhausted
        if (handler.onExhausted) {
            return activateFloatingNode(handler.onExhausted, definition, state, context, error);
        }
        // No onExhausted — bubble up
        return bubbleFailure(failedNodeId, error, definition, state, context);
    }

    // Execute goto
    return handleGoto(
        { goto: handler.goto, maxRetries: handler.maxRetries, onExhausted: handler.onExhausted },
        failedNodeId,
        definition,
        state,
        context,
    );
}

/**
 * Bubble a failure up to the parent node.
 */
function bubbleFailure(
    failedNodeId: string,
    error: string,
    definition: WorkflowDefinition,
    state: WorkflowState,
    context: EngineContext,
): { state: WorkflowState; nextAction: NextAction } {
    const parentInfo = findParent(definition.root, failedNodeId);

    if (!parentInfo) {
        // Root node failed — workflow failed
        return {
            state,
            nextAction: {
                type: 'failed',
                instructions: `Workflow failed: ${error}`,
            },
        };
    }

    const { parent } = parentInfo;

    if (parent.type === 'parallel') {
        if (parent.failStrategy === 'fail-fast') {
            // Cancel remaining active children
            for (const child of parent.children) {
                const childState = state.nodes[child.id];
                if (childState && childState.status === 'active') {
                    state.nodes[child.id] = {
                        ...childState,
                        status: 'cancelled',
                        completedAt: new Date().toISOString(),
                    };
                }
            }
            // Fail the parallel node itself
            return failNode(state, definition, parent.id, error, context);
        }

        // wait-all: check if all children are done
        const allDone = parent.children.every((c) => {
            const cs = state.nodes[c.id];
            return cs?.status === 'completed' || cs?.status === 'failed' || cs?.status === 'cancelled';
        });

        if (allDone) {
            return failNode(state, definition, parent.id, error, context);
        }

        // Still waiting for others
        return {
            state,
            nextAction: {
                type: 'wait',
                nodeId: parent.id,
                instructions: `Parallel node "${parent.id}": child "${failedNodeId}" failed, waiting for remaining tasks (wait-all strategy)`,
            },
        };
    }

    // For sequence parents, failure in a child means the sequence fails
    return failNode(state, definition, parent.id, error, context);
}

/**
 * Activate a floating node (used by onExhausted).
 */
function activateFloatingNode(
    floatingNodeId: string,
    definition: WorkflowDefinition,
    state: WorkflowState,
    context: EngineContext,
    error: string,
): { state: WorkflowState; nextAction: NextAction } {
    const floatingNode = definition.floatingNodes?.find((fn) => fn.id === floatingNodeId);

    if (!floatingNode) {
        return {
            state,
            nextAction: {
                type: 'wait',
                instructions: `Floating node "${floatingNodeId}" not found. Retries exhausted. Original error: ${error}`,
            },
        };
    }

    return activateNode(floatingNode, definition, state, context);
}

// ─── Goto Handling ───

/**
 * Execute a goto: reset the target node and all subsequent nodes to pending,
 * increment retry count on the target, then re-activate the target.
 */
function handleGoto(
    gotoTarget: GotoTarget,
    sourceNodeId: string,
    definition: WorkflowDefinition,
    state: WorkflowState,
    context: EngineContext,
    gateResults?: GateEvaluationResult,
): { state: WorkflowState; nextAction: NextAction } {
    const targetId = gotoTarget.goto;

    // Check retry limit before proceeding
    const targetState = state.nodes[targetId];
    const currentRetries = targetState?.retryCount ?? 0;

    if (gotoTarget.maxRetries !== undefined && currentRetries >= gotoTarget.maxRetries) {
        // Retries exhausted
        if (gotoTarget.onExhausted) {
            return activateFloatingNode(
                gotoTarget.onExhausted,
                definition,
                state,
                context,
                `Goto target "${targetId}" exhausted retries (${currentRetries}/${gotoTarget.maxRetries})`,
            );
        }
        // No onExhausted — report as failed
        return {
            state,
            nextAction: {
                type: 'failed',
                instructions: `Goto target "${targetId}" exhausted retries (${currentRetries}/${gotoTarget.maxRetries}). No onExhausted handler configured.`,
            },
        };
    }

    // Reset target and subsequent nodes
    state = executeGoto(state, definition, targetId);

    // Find the target node and activate it
    const targetNode = findNode(definition.root, targetId, definition.floatingNodes);
    if (!targetNode) {
        return {
            state,
            nextAction: {
                type: 'wait',
                instructions: `Goto target node "${targetId}" not found in definition`,
            },
        };
    }

    return activateNode(targetNode, definition, state, context, gateResults);
}

/**
 * Execute goto state reset: reset target node and all subsequent nodes to pending.
 * Increment retry count on the target node.
 */
function executeGoto(state: WorkflowState, definition: WorkflowDefinition, targetId: string): WorkflowState {
    // Collect all node IDs that need to be reset:
    // the target node itself + all nodes that come after it in execution order
    const resetIds = collectSubsequentNodeIds(definition.root, targetId);
    resetIds.add(targetId);

    const now = new Date().toISOString();

    resetIds.forEach((id) => {
        const existing = state.nodes[id];
        if (existing) {
            const isTarget = id === targetId;
            state.nodes[id] = {
                id,
                status: 'pending',
                retryCount: isTarget ? existing.retryCount + 1 : 0,
                // Clear timing fields
            };
        }
    });

    state.updatedAt = now;
    return state;
}

/**
 * Collect all node IDs that come after the target node in execution order.
 * This includes:
 * - Subsequent siblings (and their full subtrees) in the parent sequence
 * - Any nodes that follow the parent in its grandparent sequence (recursively)
 *
 * For parallel nodes, subsequent siblings don't apply (they execute simultaneously).
 */
function collectSubsequentNodeIds(root: WorkflowNode, targetId: string): Set<string> {
    const result = new Set<string>();

    // Find the path from root to the target
    const path = findPathTo(root, targetId);
    if (!path || path.length === 0) return result;

    // Walk up the path, collecting subsequent siblings at each level
    for (let i = 0; i < path.length - 1; i++) {
        const parent = path[i];
        const child = path[i + 1];

        if (parent.type === 'sequence') {
            const childIndex = parent.children.findIndex((c) => c.id === child.id);
            // Collect all children after the one on our path
            for (let j = childIndex + 1; j < parent.children.length; j++) {
                collectAllNodeIds(parent.children[j], result);
            }
        }
        // For gate nodes, if our path goes through pass, we don't need to collect fail
        // because fail is an alternative path, not a subsequent one.
        // For parallel nodes, siblings are concurrent not subsequent — don't reset.
    }

    return result;
}

/**
 * Find the path from root to a specific node (inclusive on both ends).
 * Returns null if node not found.
 */
function findPathTo(node: WorkflowNode, targetId: string): WorkflowNode[] | null {
    if (node.id === targetId) return [node];

    switch (node.type) {
        case 'sequence':
        case 'parallel':
            for (const child of node.children) {
                const path = findPathTo(child, targetId);
                if (path) return [node, ...path];
            }
            break;
        case 'gate': {
            const passPath = findPathTo(node.pass, targetId);
            if (passPath) return [node, ...passPath];
            if ('type' in node.fail) {
                const failPath = findPathTo(node.fail as WorkflowNode, targetId);
                if (failPath) return [node, ...failPath];
            }
            break;
        }
    }

    return null;
}

/**
 * Recursively collect all node IDs in a subtree.
 */
function collectAllNodeIds(node: WorkflowNode, ids: Set<string>): void {
    ids.add(node.id);
    switch (node.type) {
        case 'sequence':
        case 'parallel':
            for (const child of node.children) {
                collectAllNodeIds(child, ids);
            }
            break;
        case 'gate':
            collectAllNodeIds(node.pass, ids);
            if ('type' in node.fail) {
                collectAllNodeIds(node.fail as WorkflowNode, ids);
            }
            break;
    }
}

// ─── Gate Evaluation ───

/**
 * Evaluate all conditions for a gate node.
 * All conditions must pass for the gate to pass (AND logic).
 */
export function evaluateGate(gate: GateNode, gateCtx: GateContext): GateEvaluationResult {
    const results: GateConditionResult[] = gate.conditions.map((condition) => evaluateCondition(condition, gateCtx));

    return {
        passed: results.every((r) => r.met),
        conditions: results,
    };
}

/**
 * Evaluate a single gate condition.
 */
function evaluateCondition(condition: GateCondition, ctx: GateContext): GateConditionResult {
    switch (condition.type) {
        case 'artifact_exists': {
            const exists = ctx.artifactExists(condition.artifact);
            return { condition, met: exists };
        }
        case 'artifact_approved': {
            const approved = ctx.artifactApproved(condition.artifact);
            return { condition, met: approved };
        }
        case 'artifact_field': {
            const value = ctx.artifactField(condition.artifact, condition.field);
            const met = evaluateFieldCondition(value, condition.operator, condition.value);
            return { condition, met, actualValue: value };
        }
    }
}

/**
 * Evaluate a field comparison operation.
 */
function evaluateFieldCondition(
    actualValue: unknown,
    operator: import('./types.js').ArtifactFieldOperator,
    expectedValue: unknown,
): boolean {
    switch (operator) {
        case 'eq':
            return actualValue === expectedValue;
        case 'neq':
            return actualValue !== expectedValue;
        case 'gt':
            return typeof actualValue === 'number' && typeof expectedValue === 'number' && actualValue > expectedValue;
        case 'lt':
            return typeof actualValue === 'number' && typeof expectedValue === 'number' && actualValue < expectedValue;
        case 'gte':
            return typeof actualValue === 'number' && typeof expectedValue === 'number' && actualValue >= expectedValue;
        case 'lte':
            return typeof actualValue === 'number' && typeof expectedValue === 'number' && actualValue <= expectedValue;
        case 'contains':
            if (typeof actualValue === 'string' && typeof expectedValue === 'string') {
                return actualValue.includes(expectedValue);
            }
            if (Array.isArray(actualValue)) {
                return actualValue.includes(expectedValue);
            }
            return false;
        case 'in':
            if (Array.isArray(expectedValue)) {
                return expectedValue.includes(actualValue);
            }
            return false;
        default:
            return false;
    }
}

// ─── Gate Re-evaluation ───

/**
 * Re-evaluate all active gate nodes after an artifact event.
 * If a gate that was previously waiting (status='active') now passes,
 * activate its pass branch.
 */
function reevaluateGates(
    state: WorkflowState,
    definition: WorkflowDefinition,
    context: EngineContext,
): { state: WorkflowState; nextAction: NextAction } {
    // Find all active gate nodes
    const activeGates = findActiveGates(definition.root, state);

    for (const gate of activeGates) {
        const evaluation = evaluateGate(gate, context.gate);

        if (evaluation.passed) {
            // Gate now passes — mark it completed and activate pass branch
            state.nodes[gate.id] = {
                ...state.nodes[gate.id],
                status: 'completed',
                completedAt: new Date().toISOString(),
            };
            return activateNode(gate.pass, definition, state, context);
        }
    }

    // No gate changed — return wait
    return {
        state,
        nextAction: {
            type: 'wait',
            instructions: 'Artifact event processed. No gate conditions newly satisfied.',
        },
    };
}

/**
 * Find all gate nodes that are currently in 'active' state.
 */
function findActiveGates(node: WorkflowNode, state: WorkflowState): GateNode[] {
    const gates: GateNode[] = [];

    if (node.type === 'gate' && state.nodes[node.id]?.status === 'active') {
        gates.push(node);
    }

    switch (node.type) {
        case 'sequence':
        case 'parallel':
            for (const child of node.children) {
                gates.push(...findActiveGates(child, state));
            }
            break;
        case 'gate':
            gates.push(...findActiveGates(node.pass, state));
            if ('type' in node.fail) {
                gates.push(...findActiveGates(node.fail as WorkflowNode, state));
            }
            break;
    }

    return gates;
}

// ─── Dispatch Request Handling ───

/**
 * Handle an explicit dispatch request for a specific node.
 * Used when the coordinator explicitly requests to dispatch a node
 * (e.g., for parallel tasks that need individual dispatching).
 */
function handleDispatchRequest(
    state: WorkflowState,
    definition: WorkflowDefinition,
    nodeId: string,
    context: EngineContext,
): { state: WorkflowState; nextAction: NextAction } {
    const node = findNode(definition.root, nodeId, definition.floatingNodes);

    if (!node) {
        return {
            state,
            nextAction: {
                type: 'wait',
                instructions: `Node "${nodeId}" not found in workflow definition`,
            },
        };
    }

    const nodeState = state.nodes[nodeId];

    if (!nodeState || nodeState.status !== 'active') {
        return {
            state,
            nextAction: {
                type: 'wait',
                instructions: `Node "${nodeId}" is not in 'active' state (current: ${nodeState?.status ?? 'unknown'})`,
            },
        };
    }

    if (node.type !== 'task') {
        return {
            state,
            nextAction: {
                type: 'wait',
                instructions: `Node "${nodeId}" is a ${node.type} node, not a task. Only task nodes can be dispatched.`,
            },
        };
    }

    // Return dispatch action for this task
    return activateTask(node, state, context);
}

// ─── Status Query ───

/**
 * Compute the current status nextAction without modifying state.
 * Used for query_status events — tells the coordinator what to do next
 * based on the current workflow state.
 */
function computeStatusAction(state: WorkflowState, definition: WorkflowDefinition, context: EngineContext): NextAction {
    // Collect all node statuses for a summary
    const activeNodes: string[] = [];
    const pendingNodes: string[] = [];
    const failedNodes: string[] = [];
    const completedNodes: string[] = [];

    for (const [id, nodeState] of Object.entries(state.nodes)) {
        switch (nodeState.status) {
            case 'active':
                activeNodes.push(id);
                break;
            case 'pending':
                pendingNodes.push(id);
                break;
            case 'failed':
                failedNodes.push(id);
                break;
            case 'completed':
                completedNodes.push(id);
                break;
        }
    }

    // Check if workflow is completed (root node completed)
    const rootState = state.nodes[definition.root.id];
    if (rootState?.status === 'completed') {
        return {
            type: 'completed',
            instructions: 'Workflow completed successfully',
        };
    }

    if (rootState?.status === 'failed') {
        return {
            type: 'failed',
            instructions: `Workflow failed. Failed nodes: ${failedNodes.join(', ')}`,
        };
    }

    // If there's an active task node, suggest dispatching it
    if (state.activeNodeId) {
        const activeNode = findNode(definition.root, state.activeNodeId, definition.floatingNodes);
        if (activeNode?.type === 'task') {
            return {
                type: 'dispatch',
                nodeId: state.activeNodeId,
                role: activeNode.role,
                instructions: `Current active task: "${state.activeNodeId}" (role: ${activeNode.role}). ${activeNodes.length} active, ${pendingNodes.length} pending, ${completedNodes.length} completed, ${failedNodes.length} failed.`,
            };
        }
    }

    return {
        type: 'wait',
        instructions: `${activeNodes.length} active, ${pendingNodes.length} pending, ${completedNodes.length} completed, ${failedNodes.length} failed. Active nodes: ${activeNodes.join(', ') || 'none'}`,
    };
}

// ─── Helper Functions ───

/**
 * Find the parent of a node by its ID.
 * Returns the parent node and the child's index, or null if not found.
 */
function findParent(
    root: WorkflowNode,
    targetId: string,
    current?: WorkflowNode,
): { parent: WorkflowNode; childIndex: number } | null {
    const node = current ?? root;

    switch (node.type) {
        case 'sequence':
        case 'parallel':
            for (let i = 0; i < node.children.length; i++) {
                if (node.children[i].id === targetId) {
                    return { parent: node, childIndex: i };
                }
                const found = findParent(root, targetId, node.children[i]);
                if (found) return found;
            }
            break;

        case 'gate':
            if (node.pass.id === targetId) {
                return { parent: node, childIndex: 0 };
            }
            const passResult = findParent(root, targetId, node.pass);
            if (passResult) return passResult;

            if ('type' in node.fail) {
                const failNode = node.fail as WorkflowNode;
                if (failNode.id === targetId) {
                    return { parent: node, childIndex: 1 };
                }
                const failResult = findParent(root, targetId, failNode);
                if (failResult) return failResult;
            }
            break;
    }

    return null;
}

/**
 * Find a node by ID anywhere in the workflow tree (including floating nodes).
 */
function findNode(root: WorkflowNode, targetId: string, floatingNodes?: TaskNode[]): WorkflowNode | null {
    // Check the tree
    const found = findNodeInTree(root, targetId);
    if (found) return found;

    // Check floating nodes
    if (floatingNodes) {
        const floating = floatingNodes.find((fn) => fn.id === targetId);
        if (floating) return floating;
    }

    return null;
}

/**
 * Find a node by ID within a workflow tree.
 */
function findNodeInTree(node: WorkflowNode, targetId: string): WorkflowNode | null {
    if (node.id === targetId) return node;

    switch (node.type) {
        case 'sequence':
        case 'parallel':
            for (const child of node.children) {
                const found = findNodeInTree(child, targetId);
                if (found) return found;
            }
            break;
        case 'gate': {
            const passResult = findNodeInTree(node.pass, targetId);
            if (passResult) return passResult;
            if ('type' in node.fail) {
                const failResult = findNodeInTree(node.fail as WorkflowNode, targetId);
                if (failResult) return failResult;
            }
            break;
        }
    }

    return null;
}
