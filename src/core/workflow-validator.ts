/**
 * Static workflow definition validator.
 *
 * Runs at load time to validate the structural integrity of a WorkflowDefinition.
 * Checks:
 * 1. ID uniqueness across tree + floating nodes
 * 2. Goto target legality (exists + reachable in execution order)
 * 3. Cycle detection (no exit-less loops; maxRetries = ok, bubbleFailure or onExhausted provides exit)
 * 4. failStrategy required for parallel nodes
 * 5. Floating node reference validity (onExhausted targets exist in floatingNodes)
 * 6. Role reference validity (task.role must exist in provided roles set)
 * 7. Coordinator validity (definition.coordinator must exist in roles)
 */

import type { WorkflowDefinition, WorkflowNode, GotoTarget, FailureHandler, ValidationError } from './types.js';

/** Represents a goto edge for cycle detection */
interface GotoEdge {
    /** Source node ID (the node containing the goto) */
    from: string;
    /** Target node ID */
    to: string;
    /** Whether this edge has maxRetries set (provides a guaranteed exit path) */
    hasExit: boolean;
}

// ─── Utility: collect all IDs in a node subtree ───

function collectSubtreeIds(node: WorkflowNode, ids: Set<string>): void {
    ids.add(node.id);
    switch (node.type) {
        case 'sequence':
        case 'parallel':
            for (const child of node.children) {
                collectSubtreeIds(child, ids);
            }
            break;
        case 'gate':
            collectSubtreeIds(node.pass, ids);
            if ('type' in node.fail) {
                collectSubtreeIds(node.fail as WorkflowNode, ids);
            }
            break;
        case 'task':
            break;
    }
}

// ─── Main Validator ───

/**
 * Validate a workflow definition.
 *
 * @param definition - The workflow definition to validate
 * @param availableRoles - Set of role IDs available in the role registry
 * @returns Array of validation errors (empty = valid)
 */
export function validateWorkflow(definition: WorkflowDefinition, availableRoles: Set<string>): ValidationError[] {
    const errors: ValidationError[] = [];
    const allIds = new Map<string, string>(); // id → location description
    const floatingNodeIds = new Set<string>();
    const gotoEdges: GotoEdge[] = [];

    // Collect floating node IDs
    if (definition.floatingNodes) {
        for (const fn of definition.floatingNodes) {
            floatingNodeIds.add(fn.id);
        }
    }

    // ── 1. Collect all IDs and check uniqueness + failStrategy ──
    collectAndValidateIds(definition.root, [], allIds, errors);

    if (definition.floatingNodes) {
        for (const fn of definition.floatingNodes) {
            if (allIds.has(fn.id)) {
                errors.push({
                    type: 'duplicate_id',
                    message: `Duplicate node ID "${fn.id}" — found in floating nodes and also at ${allIds.get(fn.id)}`,
                    nodeId: fn.id,
                });
            } else {
                allIds.set(fn.id, 'floatingNodes');
            }
        }
    }

    // ── 2. Validate goto targets + collect edges for cycle detection ──
    validateGotoTargets(definition.root, [], new Set(), allIds, floatingNodeIds, errors, gotoEdges);

    if (definition.floatingNodes) {
        for (const fn of definition.floatingNodes) {
            if (fn.onFailed) {
                validateFailureHandler(
                    fn.onFailed,
                    fn.id,
                    allIds,
                    floatingNodeIds,
                    [],
                    new Set(),
                    errors,
                    gotoEdges,
                    true,
                );
            }
        }
    }

    // ── 3. Cycle detection ──
    detectCycles(gotoEdges, errors);

    // ── 4-5. (done inline during traversals above) ──

    // ── 6. Role reference check ──
    validateRoleReferences(definition.root, availableRoles, errors);

    if (definition.floatingNodes) {
        for (const fn of definition.floatingNodes) {
            if (!availableRoles.has(fn.role)) {
                errors.push({
                    type: 'invalid_role_ref',
                    message: `Floating node "${fn.id}" references role "${fn.role}" which is not in the role registry`,
                    nodeId: fn.id,
                });
            }
        }
    }

    // ── 7. Coordinator check ──
    if (!availableRoles.has(definition.coordinator)) {
        errors.push({
            type: 'invalid_coordinator',
            message: `Coordinator role "${definition.coordinator}" is not in the role registry`,
        });
    }

    return errors;
}

// ─── ID Collection & Uniqueness ───

function collectAndValidateIds(
    node: WorkflowNode,
    ancestorIds: string[],
    allIds: Map<string, string>,
    errors: ValidationError[],
): void {
    const location = ancestorIds.length > 0 ? `under ${ancestorIds[ancestorIds.length - 1]}` : 'root';
    if (allIds.has(node.id)) {
        errors.push({
            type: 'duplicate_id',
            message: `Duplicate node ID "${node.id}" — found at ${location} and also at ${allIds.get(node.id)}`,
            nodeId: node.id,
        });
    } else {
        allIds.set(node.id, location);
    }

    // Check failStrategy for parallel nodes
    if (node.type === 'parallel' && !node.failStrategy) {
        errors.push({
            type: 'missing_fail_strategy',
            message: `Parallel node "${node.id}" must have a failStrategy ("fail-fast" or "wait-all")`,
            nodeId: node.id,
        });
    }

    const childAncestors = [...ancestorIds, node.id];
    switch (node.type) {
        case 'sequence':
        case 'parallel':
            for (const child of node.children) {
                collectAndValidateIds(child, childAncestors, allIds, errors);
            }
            break;
        case 'gate':
            collectAndValidateIds(node.pass, childAncestors, allIds, errors);
            if ('type' in node.fail) {
                collectAndValidateIds(node.fail as WorkflowNode, childAncestors, allIds, errors);
            }
            break;
        case 'task':
            break;
    }
}

// ─── Goto Target Validation ───

/**
 * Validate goto targets throughout the tree.
 *
 * `reachableIds` tracks all node IDs that are "before" the current node in execution
 * order — ancestors + preceding siblings and their entire subtrees. A goto target
 * must be one of these reachable IDs (or self for task nodes).
 */
function validateGotoTargets(
    node: WorkflowNode,
    ancestorIds: string[],
    reachableIds: Set<string>,
    allIds: Map<string, string>,
    floatingNodeIds: Set<string>,
    errors: ValidationError[],
    gotoEdges: GotoEdge[],
): void {
    const childAncestors = [...ancestorIds, node.id];
    // reachableIds for this node = ancestors + preceding siblings' subtrees
    // (passed in from parent)

    switch (node.type) {
        case 'task': {
            if (node.onFailed) {
                validateFailureHandler(
                    node.onFailed,
                    node.id,
                    allIds,
                    floatingNodeIds,
                    ancestorIds,
                    reachableIds,
                    errors,
                    gotoEdges,
                    true,
                );
            }
            break;
        }
        case 'sequence': {
            // For sequence children, preceding siblings + their subtrees are reachable
            const accumulated = new Set(reachableIds);
            for (const child of node.children) {
                validateGotoTargets(
                    child,
                    childAncestors,
                    new Set(accumulated),
                    allIds,
                    floatingNodeIds,
                    errors,
                    gotoEdges,
                );
                // After processing child, add its entire subtree to accumulated
                collectSubtreeIds(child, accumulated);
            }
            break;
        }
        case 'parallel': {
            // Parallel children cannot see each other's IDs — no cross-branch jumps
            for (const child of node.children) {
                validateGotoTargets(
                    child,
                    childAncestors,
                    new Set(reachableIds),
                    allIds,
                    floatingNodeIds,
                    errors,
                    gotoEdges,
                );
            }
            if (node.onFailed) {
                validateFailureHandler(
                    node.onFailed,
                    node.id,
                    allIds,
                    floatingNodeIds,
                    ancestorIds,
                    reachableIds,
                    errors,
                    gotoEdges,
                    false,
                );
            }
            break;
        }
        case 'gate': {
            // Pass branch
            validateGotoTargets(
                node.pass,
                childAncestors,
                new Set(reachableIds),
                allIds,
                floatingNodeIds,
                errors,
                gotoEdges,
            );

            // Fail branch
            if ('goto' in node.fail && !('type' in node.fail)) {
                const gotoTarget = node.fail as GotoTarget;
                validateGotoRef(
                    gotoTarget,
                    node.id,
                    allIds,
                    floatingNodeIds,
                    ancestorIds,
                    reachableIds,
                    errors,
                    gotoEdges,
                    false,
                );
            } else if ('type' in node.fail) {
                validateGotoTargets(
                    node.fail as WorkflowNode,
                    childAncestors,
                    new Set(reachableIds),
                    allIds,
                    floatingNodeIds,
                    errors,
                    gotoEdges,
                );
            }
            break;
        }
    }
}

/**
 * Validate a single goto reference (GotoTarget or FailureHandler).
 */
function validateGotoRef(
    target: GotoTarget,
    sourceNodeId: string,
    allIds: Map<string, string>,
    floatingNodeIds: Set<string>,
    ancestorIds: string[],
    reachableIds: Set<string>,
    errors: ValidationError[],
    gotoEdges: GotoEdge[],
    isTask: boolean,
): void {
    const targetId = target.goto;

    // Check target exists
    if (!allIds.has(targetId)) {
        errors.push({
            type: 'invalid_goto',
            message: `Node "${sourceNodeId}" has goto target "${targetId}" which does not exist`,
            nodeId: sourceNodeId,
        });
    } else {
        // Check reachability: target must be an ancestor, a preceding node (in reachableIds),
        // or self (only for task nodes).
        const canGotoSelf = isTask && targetId === sourceNodeId;
        const isAncestor = ancestorIds.includes(targetId);
        const isReachable = reachableIds.has(targetId);

        if (!canGotoSelf && !isAncestor && !isReachable) {
            errors.push({
                type: 'invalid_goto',
                message: `Node "${sourceNodeId}" has goto target "${targetId}" which is not an ancestor or preceding node — violates goto constraint`,
                nodeId: sourceNodeId,
            });
        }
    }

    // Check onExhausted reference
    if (target.onExhausted && !floatingNodeIds.has(target.onExhausted)) {
        errors.push({
            type: 'invalid_floating_ref',
            message: `Node "${sourceNodeId}" references onExhausted="${target.onExhausted}" which is not in floatingNodes`,
            nodeId: sourceNodeId,
        });
    }

    // Collect edge for cycle detection
    gotoEdges.push({
        from: sourceNodeId,
        to: targetId,
        hasExit: target.maxRetries !== undefined,
    });
}

function validateFailureHandler(
    handler: FailureHandler,
    sourceNodeId: string,
    allIds: Map<string, string>,
    floatingNodeIds: Set<string>,
    ancestorIds: string[],
    reachableIds: Set<string>,
    errors: ValidationError[],
    gotoEdges: GotoEdge[],
    isTask: boolean,
): void {
    validateGotoRef(
        handler as GotoTarget,
        sourceNodeId,
        allIds,
        floatingNodeIds,
        ancestorIds,
        reachableIds,
        errors,
        gotoEdges,
        isTask,
    );
}

// ─── Cycle Detection ───

/**
 * Detect cycles in goto edges that have no exit.
 *
 * A goto edge with hasExit=true (maxRetries set) has a guaranteed exit path
 * (either via onExhausted or bubbleFailure), so it does not contribute to exit-less cycles.
 *
 * We look for strongly connected components in the subgraph of exit-less goto edges.
 * Any node that can reach itself through exit-less gotos forms a problematic cycle.
 */
function detectCycles(edges: GotoEdge[], errors: ValidationError[]): void {
    // Build adjacency list from edges that have no exit
    const adj = new Map<string, string[]>();
    for (const edge of edges) {
        if (!edge.hasExit) {
            if (!adj.has(edge.from)) {
                adj.set(edge.from, []);
            }
            adj.get(edge.from)!.push(edge.to);
        }
    }

    if (adj.size === 0) return;

    // For cycle detection we need to check: can any node reach itself?
    // Since goto edges go from a later node back to an earlier node,
    // a cycle requires a "forward path" in the workflow tree from
    // the goto target back to the goto source. This always exists
    // (that's the normal execution flow). So any exit-less goto edge
    // effectively forms a cycle: target → (normal flow) → source → (goto) → target.
    //
    // Therefore: every exit-less goto is a potential infinite loop.
    const reported = new Set<string>();
    for (const edge of edges) {
        if (!edge.hasExit && !reported.has(edge.from)) {
            reported.add(edge.from);
            errors.push({
                type: 'cycle',
                message: `Detected exit-less cycle: node "${edge.from}" has goto to "${edge.to}" without maxRetries exit`,
                nodeId: edge.from,
            });
        }
    }
}

// ─── Role Reference Validation ───

function validateRoleReferences(node: WorkflowNode, availableRoles: Set<string>, errors: ValidationError[]): void {
    switch (node.type) {
        case 'task':
            if (!availableRoles.has(node.role)) {
                errors.push({
                    type: 'invalid_role_ref',
                    message: `Task node "${node.id}" references role "${node.role}" which is not in the role registry`,
                    nodeId: node.id,
                });
            }
            break;
        case 'sequence':
        case 'parallel':
            for (const child of node.children) {
                validateRoleReferences(child, availableRoles, errors);
            }
            break;
        case 'gate':
            validateRoleReferences(node.pass, availableRoles, errors);
            if ('type' in node.fail) {
                validateRoleReferences(node.fail as WorkflowNode, availableRoles, errors);
            }
            break;
    }
}
