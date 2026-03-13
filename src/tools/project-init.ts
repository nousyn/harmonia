/**
 * MCP Tool: project_init
 * Initialize a new Harmonia project with global registry and data directory.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadWorkflow } from '../core/workflow.js';
import { initProjectState, readState, projectStateExists } from '../core/state.js';
import { registerProject, getProject } from '../core/registry.js';
import type { ProjectScale } from '../core/types.js';

export function registerProjectInit(server: McpServer, workflowsDir: string): void {
    server.tool(
        'project_init',
        "Initialize a new Harmonia project. Registers the project in the global data directory, creates data directories for documents/state, and creates the project source directory if it doesn't exist.",
        {
            project_name: z.string().describe('Unique project name (used as directory name in the data directory)'),
            project_dir: z
                .string()
                .describe("Absolute path to the project source directory (will be created if it doesn't exist)"),
            workflow: z.string().default('dev').describe('Workflow name to use (default: dev)'),
            scale: z.enum(['small', 'medium', 'large']).default('small').describe('Project scale (small/medium/large)'),
        },
        async ({ project_name, project_dir, workflow: workflowName, scale }) => {
            // Check if already initialized
            const existing = await getProject(project_name);
            if (existing) {
                const state = await readState(project_name);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Project "${project_name}" already exists.\n\nSource directory: ${existing.dir}\n\nCurrent state:\n${JSON.stringify(state, null, 2)}`,
                        },
                    ],
                };
            }

            // Load workflow definition
            const wf = await loadWorkflow(workflowsDir, workflowName);

            // Register project (creates global data dirs + project source dir)
            await registerProject(project_name, project_dir, workflowName);

            // Initialize project state
            const state = await initProjectState(project_name, project_dir, wf, scale as ProjectScale);

            // Build doc list based on scale
            const requiredDocs = Object.entries(wf.definition.docs)
                .filter(([, doc]) => {
                    const s = doc.scale[scale];
                    return s === 'full' || s === 'lite';
                })
                .map(([id, doc]) => `- ${doc.name} (${id})`)
                .join('\n');

            const optionalDocs = Object.entries(wf.definition.docs)
                .filter(([, doc]) => doc.scale[scale] === 'optional')
                .map(([id, doc]) => `- ${doc.name} (${id})`)
                .join('\n');

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: [
                            `Project "${project_name}" initialized successfully.`,
                            ``,
                            `Source directory: ${project_dir}`,
                            `Workflow: ${wf.definition.name} (${wf.definition.description})`,
                            `Scale: ${scale}`,
                            `Current phase: ${state.currentPhase}`,
                            `Available roles: ${Object.keys(wf.roles).join(', ')}`,
                            ``,
                            `Required documents:`,
                            requiredDocs || '(none)',
                            optionalDocs ? `\nOptional documents:\n${optionalDocs}` : '',
                        ].join('\n'),
                    },
                ],
            };
        },
    );
}
