/**
 * Pure node-tree traversal utilities.
 *
 * All functions here are pure (no side effects, no engine state dependency),
 * and only depend on types from ./types.ts.
 *
 * Extracted from workflow-engine.ts, loop-done.ts, role-dispatch.ts,
 * engine-helpers.ts, and workflow-validator.ts to eliminate duplication
 * and avoid circular dependencies.
 */

import type { WorkflowNode, TaskNode } from './types.js';

/**
 * Find a node by ID within a workflow tree.
 * Returns null if not found.
 */
export function findNodeInTree(node: WorkflowNode, targetId: string): WorkflowNode | null {
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
        case 'loop': {
            const bodyResult = findNodeInTree(node.body, targetId);
            if (bodyResult) return bodyResult;
            break;
        }
    }

    return null;
}

/**
 * Find the path from root to a specific node (inclusive on both ends).
 * Returns null if node not found.
 */
export function findPathToNode(node: WorkflowNode, targetId: string): WorkflowNode[] | null {
    if (node.id === targetId) return [node];

    switch (node.type) {
        case 'sequence':
        case 'parallel':
            for (const child of node.children) {
                const path = findPathToNode(child, targetId);
                if (path) return [node, ...path];
            }
            break;
        case 'gate': {
            const passPath = findPathToNode(node.pass, targetId);
            if (passPath) return [node, ...passPath];
            if ('type' in node.fail) {
                const failPath = findPathToNode(node.fail as WorkflowNode, targetId);
                if (failPath) return [node, ...failPath];
            }
            break;
        }
        case 'loop': {
            const bodyPath = findPathToNode(node.body, targetId);
            if (bodyPath) return [node, ...bodyPath];
            break;
        }
    }

    return null;
}

/**
 * Recursively collect all node IDs in a subtree.
 */
export function collectAllNodeIds(node: WorkflowNode, ids: Set<string>): void {
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
        case 'loop':
            collectAllNodeIds(node.body, ids);
            break;
    }
}

/**
 * Find the parent of a node by its ID.
 * Returns the parent node and the child's index, or null if not found.
 */
export function findParent(
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

        case 'loop':
            if (node.body.id === targetId) {
                return { parent: node, childIndex: 0 };
            }
            const loopResult = findParent(root, targetId, node.body);
            if (loopResult) return loopResult;
            break;
    }

    return null;
}

/**
 * Collect all node IDs that come after a target node in execution order.
 *
 * "After" means:
 * - Subsequent siblings (and their full subtrees) in the parent sequence
 * - Any nodes that follow the parent in its grandparent sequence (recursively)
 *
 * For parallel nodes, subsequent siblings don't apply (they execute simultaneously).
 */
export function collectSubsequentNodeIds(root: WorkflowNode, targetId: string): Set<string> {
    const result = new Set<string>();

    // Find the path from root to the target
    const path = findPathToNode(root, targetId);
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
 * Find the nearest ancestor loop node for a given node ID.
 * Returns the loop node ID if found, undefined otherwise.
 */
export function findAncestorLoopId(root: WorkflowNode, targetId: string): string | undefined {
    const path = findPathToNode(root, targetId);
    if (!path) return undefined;
    // Walk backwards through ancestors (excluding the target itself)
    for (let i = path.length - 2; i >= 0; i--) {
        if (path[i].type === 'loop') return path[i].id;
    }
    return undefined;
}
