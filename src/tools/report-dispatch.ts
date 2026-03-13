/**
 * MCP Tool: report_dispatch
 *
 * PM calls this tool to report dispatch status changes:
 * 1. After launching an agent: provide agent_session_id → creates/reuses session, marks dispatch running
 * 2. After agent finishes: provide status=completed/failed → updates dispatch, session goes idle/closed
 *
 * This is the single tool PM needs for all dispatch lifecycle management.
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
} from '../core/dispatch.js';
import type { AgentType, DispatchRecord, SessionRecord } from '../core/types.js';

export function registerReportDispatch(server: McpServer): void {
    server.tool(
        'report_dispatch',
        'Report dispatch status after launching or completing a team member agent. Call with agent_session_id after launching to register the session. Call with status="completed" or "failed" when the agent finishes.',
        {
            project_name: z.string().describe('Project name'),
            dispatch_id: z.string().describe('Dispatch ID returned by dispatch_role'),
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
                // Load the dispatch record
                const dispatch = await getDispatch(project_name, dispatch_id);
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

                // Handle session registration (when agent_session_id is provided)
                let session: SessionRecord | null = null;
                if (agent_session_id) {
                    session = await resolveOrCreateSession(
                        project_name,
                        dispatch,
                        agent_session_id,
                        agent_type as AgentType | undefined,
                        label,
                    );
                    results.push(`Session: ${session.id} (agent: ${agent_session_id}, status: ${session.status})`);
                }

                // Handle status transitions
                if (
                    effectiveStatus === 'completed' ||
                    effectiveStatus === 'failed' ||
                    effectiveStatus === 'cancelled'
                ) {
                    // Terminal states: update dispatch and transition session
                    await updateDispatch(project_name, dispatch_id, {
                        status: effectiveStatus,
                        ...(session ? { sessionId: session.id } : {}),
                        ...(note ? { note } : {}),
                    });

                    // Transition session: completed → idle, failed → lost
                    const sessionId = session?.id ?? dispatch.sessionId;
                    if (sessionId) {
                        const newSessionStatus = effectiveStatus === 'completed' ? 'idle' : 'lost';
                        await updateSession(project_name, sessionId, { status: newSessionStatus });
                        results.push(`Session ${sessionId} → ${newSessionStatus}`);
                    }

                    results.push(`Dispatch ${dispatch_id} → ${effectiveStatus}`);
                } else {
                    // Running: update dispatch status + associate session
                    await updateDispatch(project_name, dispatch_id, {
                        status: 'running',
                        ...(session ? { sessionId: session.id } : {}),
                        ...(note ? { note } : {}),
                    });

                    // Mark session as active
                    const sessionId = session?.id ?? dispatch.sessionId;
                    if (sessionId) {
                        await updateSession(project_name, sessionId, { status: 'active' });
                    }

                    results.push(`Dispatch ${dispatch_id} → running`);
                }

                // Build response
                const nextStepHint =
                    effectiveStatus === 'running'
                        ? `\nNext: When the agent finishes, call report_dispatch with dispatch_id="${dispatch_id}" and status="completed" (or "failed").`
                        : `\nNext: Call get_project_status to check overall progress and determine next steps.`;

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `# Report Dispatch: ${dispatch_id}\n\n${results.join('\n')}${nextStepHint}`,
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
    dispatch: DispatchRecord,
    agentSessionId: string,
    agentType?: AgentType,
    label?: string,
): Promise<SessionRecord> {
    // If the dispatch already has a session, update it with the agent session ID
    if (dispatch.sessionId) {
        const sessions = await readSessions(projectName);
        const existing = sessions.find((s) => s.id === dispatch.sessionId);
        if (existing) {
            return await updateSession(projectName, existing.id, {
                agentSessionId,
                ...(agentType ? { agentType } : {}),
                ...(label ? { label } : {}),
                status: 'active',
            });
        }
    }

    // Check if a session with this agent session ID already exists for this role
    const existingByAgent = await findSessionByAgentId(projectName, dispatch.role, agentSessionId);
    if (existingByAgent) {
        return await updateSession(projectName, existingByAgent.id, {
            status: 'active',
            ...(agentType ? { agentType } : {}),
            ...(label ? { label } : {}),
        });
    }

    // Create a new session
    const session = await createSession(projectName, dispatch.role, agentType, label);
    return await updateSession(projectName, session.id, { agentSessionId });
}
