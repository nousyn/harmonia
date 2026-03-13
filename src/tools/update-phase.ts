/**
 * MCP Tool: update_phase
 * Advance or update the status of a project phase.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { updatePhaseStatus } from '../core/state.js';

export function registerUpdatePhase(server: McpServer): void {
    server.tool(
        'update_phase',
        'Update the status of a project phase. When a phase is completed, the next phase is automatically started.',
        {
            project_name: z.string().describe('Project name'),
            phase_id: z.string().describe('Phase ID to update (e.g. clarify, design, develop, test, deliver)'),
            status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).describe('New status for the phase'),
            blocked_reason: z.string().optional().describe("Reason for blocking (required when status is 'blocked')"),
        },
        async ({ project_name, phase_id, status, blocked_reason }) => {
            try {
                const state = await updatePhaseStatus(project_name, phase_id, status, blocked_reason);

                const phasesSummary = state.phases
                    .map((p) => {
                        const marker = p.id === state.currentPhase ? ' <-- current' : '';
                        return `  ${p.id}: ${p.status}${p.blockedReason ? ` (${p.blockedReason})` : ''}${marker}`;
                    })
                    .join('\n');

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Phase "${phase_id}" updated to "${status}".\n\nProject phases:\n${phasesSummary}`,
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
