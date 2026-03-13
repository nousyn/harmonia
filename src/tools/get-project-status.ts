/**
 * MCP Tool: get_project_status
 * Read the current project status.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readState } from '../core/state.js';
import { loadWorkflow } from '../core/workflow.js';
import { listDocs } from '../core/docs.js';

export function registerGetProjectStatus(server: McpServer, workflowsDir: string): void {
    server.tool(
        'get_project_status',
        'Get the current project status including phase progress, scale, and available documents.',
        {
            project_name: z.string().describe('Project name'),
        },
        async ({ project_name }) => {
            try {
                const state = await readState(project_name);
                const wf = await loadWorkflow(workflowsDir, state.workflow);
                const docs = await listDocs(project_name);

                const phasesSummary = state.phases
                    .map((p) => {
                        const def = wf.definition.phases.find((pd) => pd.id === p.id);
                        const marker = p.id === state.currentPhase ? ' <-- current' : '';
                        const name = def ? ` (${def.name})` : '';
                        return `  ${p.id}${name}: ${p.status}${p.blockedReason ? ` [blocked: ${p.blockedReason}]` : ''}${marker}`;
                    })
                    .join('\n');

                const currentPhaseDef = wf.definition.phases.find((p) => p.id === state.currentPhase);

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: [
                                `# Project Status: ${state.projectName}`,
                                ``,
                                `Source directory: ${state.projectDir}`,
                                `Workflow: ${state.workflow}`,
                                `Scale: ${state.scale}`,
                                `Created: ${state.createdAt}`,
                                `Updated: ${state.updatedAt}`,
                                ``,
                                `## Phases`,
                                phasesSummary,
                                ``,
                                `## Current Phase`,
                                currentPhaseDef
                                    ? `${currentPhaseDef.name} (${currentPhaseDef.id}): ${currentPhaseDef.description}`
                                    : 'Unknown',
                                currentPhaseDef?.roles ? `Roles: ${currentPhaseDef.roles.join(', ')}` : '',
                                ``,
                                `## Documents`,
                                docs.length > 0 ? docs.map((d) => `- ${d}`).join('\n') : '(none yet)',
                            ].join('\n'),
                        },
                    ],
                };
            } catch {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: 'Project not initialized. Use project_init to get started.',
                        },
                    ],
                    isError: true,
                };
            }
        },
    );
}
