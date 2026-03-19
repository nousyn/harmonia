/**
 * MCP Tool: role_prompt
 * Retrieve the prompt and configuration for a specific role,
 * with capability overrides injected into the prompt.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadWorkflow } from '../core/plugin.js';
import { getMergedOverrides } from '../core/overrides.js';
import { buildOverrideSection } from './utils.js';

export function registerGetRolePrompt(server: McpServer, builtinDir: string, customDir: string): void {
    server.tool(
        'role_prompt',
        "Get the system prompt and configuration for a specific role in the workflow. Includes any capability overrides configured at project level. Use this to understand what a role does or to set up an agent with the role's prompt.",
        {
            workflow: z.string().default('dev').describe('Workflow name (default: dev)'),
            role: z.string().describe('Role ID (e.g. coordinator, architect, developer, tester)'),
            project_name: z
                .string()
                .optional()
                .describe('Project name — if provided, includes project-specific capability overrides in the prompt'),
        },
        async ({ workflow: workflowName, role, project_name }) => {
            const wf = await loadWorkflow(builtinDir, customDir, workflowName);
            const roleDef = wf.roles[role];

            if (!roleDef) {
                const available = Object.keys(wf.roles).join(', ');
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Role "${role}" not found in workflow "${workflowName}". Available roles: ${available}`,
                        },
                    ],
                    isError: true,
                };
            }

            // Build override section if project_name is provided
            let overrideSection = '';
            if (project_name) {
                const overrides = await getMergedOverrides(project_name);
                overrideSection = buildOverrideSection(role, overrides);
            }

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: [
                            `# Role: ${roleDef.id}`,
                            ``,
                            `## Configuration`,
                            `- Model level: ${roleDef.frontmatter.model}`,
                            `- Session: ${roleDef.frontmatter.session}`,
                            `- Parallel: ${roleDef.frontmatter.parallel}`,
                            ``,
                            `## Prompt`,
                            ``,
                            roleDef.prompt,
                            overrideSection,
                        ].join('\n'),
                    },
                ],
            };
        },
    );
}
