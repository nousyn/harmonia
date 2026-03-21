/**
 * MCP Tool: loop_done
 * Signal that a loop node should terminate after the current iteration completes.
 *
 * The coordinator calls this when it determines the loop's work is done
 * (e.g., all items processed). The engine marks the loop's `done` flag,
 * but does NOT immediately terminate — the current iteration's body
 * continues to completion first.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readState } from '../core/state.js';
import { loadWorkflow } from '../core/plugin.js';
import { resolveActive, isError } from './utils.js';
import { processWorkflowEvent, formatNextAction } from './engine-helpers.js';
import type { LoopNode, LoopNodeState } from '../core/types.js';

/**
 * Find a node by ID in the workflow tree (recursive).
 */
function findNodeById(
    node: import('../core/types.js').WorkflowNode,
    targetId: string,
): import('../core/types.js').WorkflowNode | null {
    if (node.id === targetId) return node;
    switch (node.type) {
        case 'sequence':
        case 'parallel':
            for (const child of node.children) {
                const found = findNodeById(child, targetId);
                if (found) return found;
            }
            break;
        case 'gate': {
            const passResult = findNodeById(node.pass, targetId);
            if (passResult) return passResult;
            if ('type' in node.fail) {
                const failResult = findNodeById(node.fail as import('../core/types.js').WorkflowNode, targetId);
                if (failResult) return failResult;
            }
            break;
        }
        case 'loop': {
            const bodyResult = findNodeById(node.body, targetId);
            if (bodyResult) return bodyResult;
            break;
        }
    }
    return null;
}

export function registerLoopDone(server: McpServer, workflowsDir: string): void {
    server.tool(
        'loop_done',
        "Signal that a loop node should terminate. The current iteration will complete normally, then the loop ends. Call this when the loop's work is finished (e.g., all items have been processed).",
        {
            project_name: z.string().describe('Project name'),
            node_id: z.string().describe('The loop node ID to terminate'),
        },
        async ({ project_name, node_id }) => {
            try {
                const ctx = await resolveActive(project_name);
                if (isError(ctx)) return ctx;

                // Load state and workflow to validate the node
                const state = await readState(project_name, ctx.number, ctx.dir);
                const wf = await loadWorkflow(workflowsDir, state.workflow);

                // Validate: node exists and is a loop
                const node = findNodeById(wf.definition.root, node_id);
                if (!node) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Node "${node_id}" not found in the workflow definition.`,
                            },
                        ],
                        isError: true,
                    };
                }
                if (node.type !== 'loop') {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Node "${node_id}" is a ${node.type} node, not a loop. Only loop nodes can be terminated with loop_done.`,
                            },
                        ],
                        isError: true,
                    };
                }

                // Validate: loop is active
                const nodeState = state.nodes[node_id] as LoopNodeState | undefined;
                if (!nodeState || nodeState.status !== 'active') {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Loop "${node_id}" is not active (current status: ${nodeState?.status ?? 'unknown'}). Only active loops can be terminated.`,
                            },
                        ],
                        isError: true,
                    };
                }

                // Check if already marked done
                if (nodeState.done) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Loop "${node_id}" is already marked for termination (iteration ${nodeState.currentIteration}). It will end after the current iteration completes.`,
                            },
                        ],
                    };
                }

                // Process the loop_done event through the engine
                const engineResult = await processWorkflowEvent(workflowsDir, project_name, ctx, {
                    type: 'loop_done',
                    nodeId: node_id,
                });

                const loopStateAfter = engineResult.state.nodes[node_id] as LoopNodeState;

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: [
                                `Loop "${node_id}" marked for termination.`,
                                `Current iteration: ${loopStateAfter.currentIteration}`,
                                `The current iteration's body will complete normally, then the loop will end.`,
                                formatNextAction(engineResult.nextAction),
                            ].join('\n'),
                        },
                    ],
                };
            } catch (err) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    );
}
