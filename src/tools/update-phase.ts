/**
 * MCP Tool: update_phase
 * Advance or update the status of a project phase.
 * When completing a phase, checks that all doc-type outputs exist (output guard).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readState, updatePhaseStatus } from '../core/state.js';
import { loadWorkflow } from '../core/workflow.js';
import { listDocs } from '../core/docs.js';

export function registerUpdatePhase(server: McpServer, workflowsDir: string): void {
    server.tool(
        'update_phase',
        'Update the status of a project phase. When a phase is completed, the next phase is automatically started. Completing a phase checks that all required doc outputs exist.',
        {
            project_name: z.string().describe('Project name'),
            phase_id: z.string().describe('Phase ID to update (e.g. clarify, design, develop, test, deliver)'),
            status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).describe('New status for the phase'),
            blocked_reason: z.string().optional().describe("Reason for blocking (required when status is 'blocked')"),
            force: z.boolean().optional().describe('Force completion even if outputs are missing (default: false)'),
        },
        async ({ project_name, phase_id, status, blocked_reason, force }) => {
            try {
                // Output guard: when completing a phase, check doc outputs exist
                if (status === 'completed' && !force) {
                    const currentState = await readState(project_name);
                    const wf = await loadWorkflow(workflowsDir, currentState.workflow);
                    const existingDocs = await listDocs(project_name);

                    const phaseDef = wf.definition.phases.find((p) => p.id === phase_id);
                    if (phaseDef) {
                        const missingDocOutputs = phaseDef.outputs.filter((o) => {
                            const docDef = wf.definition.docs[o];
                            if (!docDef) return false; // unknown output, skip
                            if (docDef.external) return false; // external outputs not managed by write_doc
                            return !existingDocs.includes(o);
                        });

                        if (missingDocOutputs.length > 0) {
                            return {
                                content: [
                                    {
                                        type: 'text' as const,
                                        text: `Cannot complete phase "${phase_id}" — missing doc outputs: ${missingDocOutputs.join(', ')}.\n\nProduce these documents with write_doc first, or use force=true to skip this check.`,
                                    },
                                ],
                                isError: true,
                            };
                        }
                    }
                }

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
