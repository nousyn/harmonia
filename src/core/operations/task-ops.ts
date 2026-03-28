/**
 * Task Operations — complete, fail, loop-done.
 *
 * These endpoints let agents signal task lifecycle events to the workflow engine,
 * enabling workflow progression after agent work is done.
 */

import { resolveActive } from '../engine-helpers.js';
import { processWorkflowEvent, findTaskNode, formatNextAction, loadWorkflowForContext } from '../engine-helpers.js';

// ─── Types ───

export interface TaskActionResult {
    taskId: string;
    status: string;
    nextAction: string;
}

// ─── Task Complete ───

/**
 * Mark a task as completed. The engine will advance the workflow to the next node.
 */
export async function completeTask(
    workflowsDir: string,
    projectName: string,
    taskId: string,
    result?: unknown,
): Promise<TaskActionResult> {
    const ctx = await resolveActive(projectName);
    const { wf, state } = await loadWorkflowForContext(workflowsDir, projectName, ctx);

    // Validate: task exists and is a task-type node
    const taskNode = findTaskNode(wf, taskId);
    if (!taskNode) {
        throw new Error(`Task "${taskId}" not found in workflow definition.`);
    }

    // Validate: task is in active state
    const nodeState = state.nodes[taskId];
    if (!nodeState || nodeState.status !== 'active') {
        throw new Error(
            `Task "${taskId}" is not in 'active' state (current: ${nodeState?.status ?? 'unknown'}). Cannot complete.`,
        );
    }

    const engineResult = await processWorkflowEvent(workflowsDir, projectName, ctx, {
        type: 'node_completed',
        nodeId: taskId,
        result,
    });

    return {
        taskId,
        status: 'completed',
        nextAction: formatNextAction(engineResult.nextAction),
    };
}

// ─── Task Fail ───

/**
 * Report a task as failed. The engine will process the failure handler or bubble up.
 */
export async function failTask(
    workflowsDir: string,
    projectName: string,
    taskId: string,
    error: string,
): Promise<TaskActionResult> {
    const ctx = await resolveActive(projectName);
    const { wf, state } = await loadWorkflowForContext(workflowsDir, projectName, ctx);

    const taskNode = findTaskNode(wf, taskId);
    if (!taskNode) {
        throw new Error(`Task "${taskId}" not found in workflow definition.`);
    }

    const nodeState = state.nodes[taskId];
    if (!nodeState || nodeState.status !== 'active') {
        throw new Error(
            `Task "${taskId}" is not in 'active' state (current: ${nodeState?.status ?? 'unknown'}). Cannot fail.`,
        );
    }

    const engineResult = await processWorkflowEvent(workflowsDir, projectName, ctx, {
        type: 'node_failed',
        nodeId: taskId,
        error,
    });

    return {
        taskId,
        status: 'failed',
        nextAction: formatNextAction(engineResult.nextAction),
    };
}

// ─── Loop Done ───

/**
 * Signal that a loop task should terminate after the current iteration.
 */
export async function signalLoopDone(
    workflowsDir: string,
    projectName: string,
    taskId: string,
): Promise<TaskActionResult> {
    const ctx = await resolveActive(projectName);
    const { state } = await loadWorkflowForContext(workflowsDir, projectName, ctx);

    const nodeState = state.nodes[taskId];
    if (!nodeState || nodeState.status !== 'active') {
        throw new Error(
            `Task "${taskId}" is not in 'active' state (current: ${nodeState?.status ?? 'unknown'}). Cannot signal loop-done.`,
        );
    }

    const engineResult = await processWorkflowEvent(workflowsDir, projectName, ctx, {
        type: 'loop_done',
        nodeId: taskId,
    });

    return {
        taskId,
        status: 'loop-done',
        nextAction: formatNextAction(engineResult.nextAction),
    };
}
