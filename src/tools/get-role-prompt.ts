/**
 * MCP Tool: get_role_prompt
 * Retrieve the prompt and configuration for a specific role,
 * with capability overrides injected into the prompt.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadWorkflow } from '../core/workflow.js';
import { getMergedOverrides, resolveCapabilityOverride } from '../core/overrides.js';
import type { CapabilityOverride, OverrideConfig } from '../core/types.js';

/**
 * Generate override prompt instructions for a role based on configured overrides.
 */
function buildOverridePromptSection(roleId: string, overrides: OverrideConfig): string {
    const roleOverrides = overrides.roles?.[roleId]?.capabilities;
    if (!roleOverrides || Object.keys(roleOverrides).length === 0) {
        return '';
    }

    const lines: string[] = [
        '',
        '## Enhanced Capabilities',
        '',
        'The following capabilities have been configured to use external tools.',
        'When performing these actions, use the specified tool instead of built-in behavior.',
        '',
    ];

    for (const [capId, override] of Object.entries(roleOverrides)) {
        const o = override as CapabilityOverride;
        const toolRef =
            o.type === 'mcp' && o.server
                ? `\`${o.server}\` MCP server's \`${o.tool}\` tool`
                : `\`${o.tool}\` skill tool`;

        let instruction = `- **${capId}**: Use ${toolRef}`;

        if (o.params && Object.keys(o.params).length > 0) {
            const paramStr = Object.entries(o.params)
                .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                .join(', ');
            instruction += ` with fixed parameters: ${paramStr}`;
        }

        if (o.notes) {
            instruction += `. Note: ${o.notes}`;
        }

        lines.push(instruction);
    }

    return lines.join('\n');
}

export function registerGetRolePrompt(server: McpServer, workflowsDir: string): void {
    server.tool(
        'get_role_prompt',
        "Get the system prompt and configuration for a specific role in the workflow. Includes any capability overrides configured at global or project level. Use this to understand what a role does or to set up an agent with the role's prompt.",
        {
            workflow: z.string().default('dev').describe('Workflow name (default: dev)'),
            role: z.string().describe('Role ID (e.g. pm, architect, developer, tester)'),
            project_name: z
                .string()
                .optional()
                .describe('Project name — if provided, includes project-specific capability overrides in the prompt'),
        },
        async ({ workflow: workflowName, role, project_name }) => {
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

            // Build override section if project_name is provided
            let overrideSection = '';
            if (project_name) {
                const overrides = await getMergedOverrides(project_name);
                overrideSection = buildOverridePromptSection(role, overrides);
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
