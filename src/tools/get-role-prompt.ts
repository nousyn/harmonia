/**
 * MCP Tool: get_role_prompt
 * Retrieve the prompt and configuration for a specific role.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadWorkflow } from '../core/workflow.js';

export function registerGetRolePrompt(server: McpServer, workflowsDir: string): void {
    server.tool(
        'get_role_prompt',
        "Get the system prompt and configuration for a specific role in the workflow. Use this to understand what a role does or to set up an agent with the role's prompt.",
        {
            workflow: z.string().default('dev').describe('Workflow name (default: dev)'),
            role: z.string().describe('Role ID (e.g. pm, architect, developer, tester)'),
        },
        async ({ workflow: workflowName, role }) => {
            const wf = await loadWorkflow(workflowsDir, workflowName);
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
                        ].join('\n'),
                    },
                ],
            };
        },
    );
}
