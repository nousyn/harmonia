/**
 * MCP Tool: dispatch_report
 *
 * Coordinator calls this tool to report dispatch status changes:
 * 1. After launching an agent: provide agent_session_id → creates/reuses session, marks dispatch running
 * 2. After agent finishes: provide status=completed/failed → updates dispatch, session goes idle/closed
 *
 * Node-based architecture changes:
 * - On completed: triggers `node_completed` engine event → computes nextAction
 * - On failed: triggers `node_failed` engine event → engine checks onFailed → computes nextAction
 * - Returns nextAction in response so coordinator knows what to do next
 *
 * Guards:
 * - State machine: terminal states (completed/failed/cancelled) are irreversible
 * - Valid transitions: dispatched→running/cancelled, running→completed/failed/cancelled
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
    getDispatch,
    updateDispatch,
    createSession,
    updateSession,
    findSessionByAgentId,
    readSessions,
    isValidTransition,
    isTerminalStatus,
} from '../core/dispatch.js';
import { resolveActive, isError } from './utils.js';
import { loadWorkflowForContext, processWorkflowEvent, formatNextAction, findTaskNode } from './engine-helpers.js';
import { readArtifact, listArtifacts } from '../core/artifacts.js';
import type { ArtifactIOContext } from '../core/artifacts.js';
import type { AgentType, DispatchRecord, SessionRecord, ActionContext, LoopNodeState } from '../core/types.js';
import { findAncestorLoopId } from '../core/tree-utils.js';

export function registerReportDispatch(server: McpServer, workflowsDir: string): void {
    server.tool(
        'dispatch_report',
        'Report dispatch status after launching or completing a team member agent. Call with agent_session_id after launching to register the session. Call with status="completed" or "failed" when the agent finishes. Returns nextAction indicating what the coordinator should do next.',
        {
            project_name: z.string().describe('Project name'),
            dispatch_id: z.string().describe('Dispatch ID returned by role_dispatch'),
            status: z
                .enum(['running', 'completed', 'failed', 'cancelled'])
                .optional()
                .describe('New dispatch status. Omit when only registering agent_session_id (defaults to "running").'),
            agent_session_id: z
                .string()
                .optional()
                .describe(
                    'The actual session ID from the host agent (e.g. OpenCode session ID). Provide on first report after launching.',
                ),
            agent_type: z
                .enum(['opencode', 'openclaw', 'claude-code', 'codex'])
                .optional()
                .describe('Agent type used for this dispatch'),
            label: z.string().optional().describe('Optional label for the session (e.g. "dev-auth-module")'),
            note: z.string().optional().describe('Optional note (e.g. failure reason)'),
        },
        async ({ project_name, dispatch_id, status, agent_session_id, agent_type, label, note }) => {
            try {
                const ctx = await resolveActive(project_name);
                if (isError(ctx)) return ctx;

                // Load the dispatch record
                const dispatch = await getDispatch(project_name, ctx.number, dispatch_id, ctx.dir);
                if (!dispatch) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Dispatch "${dispatch_id}" not found in project "${project_name}".`,
                            },
                        ],
                        isError: true,
                    };
                }

                const effectiveStatus = status ?? 'running';
                const results: string[] = [];

                // Guard: state machine — reject invalid transitions
                if (!isValidTransition(dispatch.status, effectiveStatus)) {
                    const reason = isTerminalStatus(dispatch.status)
                        ? `Dispatch "${dispatch_id}" is in terminal status "${dispatch.status}" — cannot transition to "${effectiveStatus}".`
                        : `Dispatch "${dispatch_id}" current status "${dispatch.status}" does not allow transition to "${effectiveStatus}".`;
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: reason,
                            },
                        ],
                        isError: true,
                    };
                }

                // Handle session registration (when agent_session_id is provided)
                let session: SessionRecord | null = null;
                if (agent_session_id) {
                    session = await resolveOrCreateSession(
                        project_name,
                        ctx.number,
                        dispatch,
                        agent_session_id,
                        agent_type as AgentType | undefined,
                        label,
                        ctx.dir,
                    );
                    results.push(`Session: ${session.id} (agent: ${agent_session_id}, status: ${session.status})`);
                }

                // Handle status transitions
                let nextActionText = '';

                if (
                    effectiveStatus === 'completed' ||
                    effectiveStatus === 'failed' ||
                    effectiveStatus === 'cancelled'
                ) {
                    // Terminal states: update dispatch and transition session
                    await updateDispatch(
                        project_name,
                        ctx.number,
                        dispatch_id,
                        {
                            status: effectiveStatus,
                            ...(session ? { sessionId: session.id } : {}),
                            ...(note ? { note } : {}),
                        },
                        ctx.dir,
                    );

                    // Transition session: completed → idle, failed/cancelled → lost
                    const sessionId = session?.id ?? dispatch.sessionId;
                    if (sessionId) {
                        const newSessionStatus = effectiveStatus === 'completed' ? 'idle' : 'lost';
                        await updateSession(project_name, ctx.number, sessionId, { status: newSessionStatus }, ctx.dir);
                        results.push(`Session ${sessionId} → ${newSessionStatus}`);
                    }

                    results.push(`Dispatch ${dispatch_id} → ${effectiveStatus}`);

                    // Trigger engine events for completed/failed/cancelled
                    if (dispatch.nodeId) {
                        if (effectiveStatus === 'completed') {
                            const engineResult = await processWorkflowEvent(workflowsDir, project_name, ctx, {
                                type: 'node_completed',
                                nodeId: dispatch.nodeId,
                            });
                            nextActionText = formatNextAction(engineResult.nextAction);

                            // Execute afterComplete hooks
                            try {
                                const { wf, state: currentState } = await loadWorkflowForContext(
                                    workflowsDir,
                                    project_name,
                                    ctx,
                                );
                                const targetNode = findTaskNode(wf, dispatch.nodeId);
                                if (targetNode?.afterComplete) {
                                    const hookInjections: string[] = [];
                                    if (targetNode.afterComplete.inject) {
                                        hookInjections.push(...targetNode.afterComplete.inject);
                                    }
                                    if (targetNode.afterComplete.actions && wf.actions) {
                                        const reportIoCtx: ArtifactIOContext = {
                                            contextDir: ctx.dir,
                                            projectDir: ctx.entry.dir,
                                            contextLabel: ctx.activeContext,
                                        };
                                        const nodeState = currentState.nodes[dispatch.nodeId];
                                        // Resolve loopIteration: find ancestor loop node and read its current iteration
                                        let loopIteration: number | undefined;
                                        const ancestorLoopId = findAncestorLoopId(wf.definition.root, dispatch.nodeId);
                                        if (ancestorLoopId) {
                                            const loopState = currentState.nodes[ancestorLoopId] as
                                                | LoopNodeState
                                                | undefined;
                                            if (loopState) {
                                                loopIteration = loopState.currentIteration;
                                            }
                                        }

                                        const actionCtx: ActionContext = {
                                            nodeId: dispatch.nodeId,
                                            role: dispatch.role,
                                            retryCount: nodeState?.retryCount ?? 0,
                                            projectName: project_name,
                                            pluginConfig: wf.config,
                                            workflowState: currentState,
                                            artifacts: {
                                                read: (artifactId: string) =>
                                                    readArtifact(
                                                        artifactId,
                                                        reportIoCtx,
                                                        wf.artifactDefinitions[artifactId],
                                                    ),
                                                list: () => listArtifacts(reportIoCtx, wf.artifactDefinitions),
                                            },
                                            loopIteration,
                                        };
                                        for (const actionName of targetNode.afterComplete.actions) {
                                            const handler = wf.actions[actionName];
                                            if (handler) {
                                                try {
                                                    const actionResult = await handler(actionCtx);
                                                    if (actionResult.inject) {
                                                        hookInjections.push(...actionResult.inject);
                                                    }
                                                } catch (err) {
                                                    console.warn(
                                                        `[harmonia] afterComplete action "${actionName}" failed:`,
                                                        err,
                                                    );
                                                }
                                            }
                                        }
                                    }
                                    if (hookInjections.length > 0) {
                                        results.push('', '## After-Complete Hook Output', ...hookInjections);
                                    }
                                }
                            } catch (err) {
                                console.warn('[harmonia] afterComplete hook processing failed:', err);
                            }
                        } else if (effectiveStatus === 'failed') {
                            const engineResult = await processWorkflowEvent(workflowsDir, project_name, ctx, {
                                type: 'node_failed',
                                nodeId: dispatch.nodeId,
                                error: note ?? 'Unknown failure',
                            });
                            nextActionText = formatNextAction(engineResult.nextAction);
                        } else if (effectiveStatus === 'cancelled') {
                            // Cancelled dispatches should also update node state via engine
                            // so the node doesn't stay stuck in 'active' forever
                            const engineResult = await processWorkflowEvent(workflowsDir, project_name, ctx, {
                                type: 'node_failed',
                                nodeId: dispatch.nodeId,
                                error: note ?? 'Dispatch cancelled',
                            });
                            nextActionText = formatNextAction(engineResult.nextAction);
                        }
                    }
                } else {
                    // Running: update dispatch status + associate session
                    await updateDispatch(
                        project_name,
                        ctx.number,
                        dispatch_id,
                        {
                            status: 'running',
                            ...(session ? { sessionId: session.id } : {}),
                            ...(note ? { note } : {}),
                        },
                        ctx.dir,
                    );

                    // Mark session as active
                    const sessionId = session?.id ?? dispatch.sessionId;
                    if (sessionId) {
                        await updateSession(project_name, ctx.number, sessionId, { status: 'active' }, ctx.dir);
                    }

                    results.push(`Dispatch ${dispatch_id} → running`);
                }

                // Build response
                const nextStepHint =
                    effectiveStatus === 'running'
                        ? `\nNext: When the agent finishes, call dispatch_report with dispatch_id="${dispatch_id}" and status="completed" (or "failed").`
                        : `\nNext: Call project_status to check overall progress and determine next steps.`;

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `# Report Dispatch: ${dispatch_id}\n\n${results.join('\n')}${nextStepHint}${nextActionText}`,
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

/**
 * Resolve an existing session by agent session ID, or create a new one.
 */
async function resolveOrCreateSession(
    projectName: string,
    iteration: number,
    dispatch: DispatchRecord,
    agentSessionId: string,
    agentType?: AgentType,
    label?: string,
    contextDir?: string,
): Promise<SessionRecord> {
    // If the dispatch already has a session, update it with the agent session ID
    if (dispatch.sessionId) {
        const sessions = await readSessions(projectName, iteration, contextDir);
        const existing = sessions.find((s) => s.id === dispatch.sessionId);
        if (existing) {
            return await updateSession(
                projectName,
                iteration,
                existing.id,
                {
                    agentSessionId,
                    ...(agentType ? { agentType } : {}),
                    ...(label ? { label } : {}),
                    status: 'active',
                },
                contextDir,
            );
        }
    }

    // Check if a session with this agent session ID already exists for this role
    const existingByAgent = await findSessionByAgentId(
        projectName,
        iteration,
        dispatch.role,
        agentSessionId,
        contextDir,
    );
    if (existingByAgent) {
        return await updateSession(
            projectName,
            iteration,
            existingByAgent.id,
            {
                status: 'active',
                ...(agentType ? { agentType } : {}),
                ...(label ? { label } : {}),
            },
            contextDir,
        );
    }

    // Create a new session
    const session = await createSession(projectName, iteration, dispatch.role, agentType, label, contextDir);
    return await updateSession(projectName, iteration, session.id, { agentSessionId }, contextDir);
}
