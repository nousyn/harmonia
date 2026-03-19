/**
 * Workflow state management — manages state.json within iteration/patch directories.
 *
 * Rewritten for the new node-based architecture. State now tracks individual
 * workflow nodes instead of linear phases.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { initNodeStates } from './workflow-engine.js';
import type { ContextType, WorkflowState, WorkflowPlugin, NodeState } from './types.js';

const STATE_FILE = 'state.json';

function statePath(projectName: string, iteration: number, contextDir?: string): string {
    return join(contextDir!, STATE_FILE);
}

/**
 * Initialize a new workflow state file.
 *
 * Creates initial NodeState records for all nodes in the workflow definition.
 * All nodes start as 'pending'.
 *
 * @param contextDir - Directory containing state.json
 */
export async function initWorkflowState(
    projectName: string,
    projectDir: string,
    workflow: WorkflowPlugin,
    iteration: number,
    type: ContextType = 'iteration',
    contextDir?: string,
): Promise<WorkflowState> {
    const now = new Date().toISOString();
    const nodes = initNodeStates(workflow.definition);

    const state: WorkflowState = {
        projectName,
        projectDir,
        workflow: workflow.definition.name,
        type,
        iteration,
        activeNodeId: null,
        nodes,
        createdAt: now,
        updatedAt: now,
    };

    await writeState(projectName, iteration, state, contextDir);
    return state;
}

/**
 * Read the current workflow state.
 */
export async function readState(projectName: string, iteration: number, contextDir?: string): Promise<WorkflowState> {
    const content = await readFile(statePath(projectName, iteration, contextDir), 'utf-8');
    return JSON.parse(content) as WorkflowState;
}

/**
 * Write workflow state to disk.
 */
export async function writeState(
    projectName: string,
    iteration: number,
    state: WorkflowState,
    contextDir?: string,
): Promise<void> {
    const filePath = statePath(projectName, iteration, contextDir);
    await mkdir(dirname(filePath), { recursive: true });
    state.updatedAt = new Date().toISOString();
    await writeFile(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

/**
 * Update a specific node's state. Reads current state, applies the partial update,
 * and writes back.
 *
 * @returns The updated full WorkflowState
 */
export async function updateNodeState(
    projectName: string,
    iteration: number,
    nodeId: string,
    update: Partial<NodeState>,
    contextDir?: string,
): Promise<WorkflowState> {
    const state = await readState(projectName, iteration, contextDir);
    const existing = state.nodes[nodeId];

    if (!existing) {
        throw new Error(`Node "${nodeId}" not found in workflow state for project "${projectName}"`);
    }

    state.nodes[nodeId] = { ...existing, ...update };
    await writeState(projectName, iteration, state, contextDir);
    return state;
}

/**
 * Persist engine-computed state changes. After the workflow engine computes
 * a new state (via computeNextAction or startWorkflow), call this to persist it.
 *
 * This is the preferred way to save state changes from the engine,
 * as it replaces the entire state atomically.
 */
export async function persistState(
    projectName: string,
    iteration: number,
    state: WorkflowState,
    contextDir?: string,
): Promise<void> {
    await writeState(projectName, iteration, state, contextDir);
}

/**
 * Check if a workflow state file exists.
 */
export async function stateExists(projectName: string, iteration: number, contextDir?: string): Promise<boolean> {
    try {
        await readFile(statePath(projectName, iteration, contextDir), 'utf-8');
        return true;
    } catch {
        return false;
    }
}
