/**
 * MCP Tool: setup_project
 *
 * Inject Harmonia PM guidance into the host agent's config file (e.g. AGENTS.md).
 * This makes the host agent aware of Harmonia tools and the PM workflow.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readState } from '../core/state.js';
import { detectHostAgent, injectPrompt, type HostAgentType } from '../setup/inject.js';

export function registerSetupProject(server: McpServer): void {
    server.tool(
        'setup_project',
        "Inject Harmonia PM guidance into the host agent's config file (AGENTS.md / CLAUDE.md). Makes the host agent aware of all Harmonia tools and the PM workflow. Requires project_init to be called first. Idempotent — safe to call multiple times.",
        {
            project_name: z.string().describe('Project name (must be initialized)'),
            agent_type: z
                .enum(['opencode', 'claude-code', 'codex'])
                .optional()
                .describe('Host agent type. If not specified, auto-detects based on project directory contents.'),
        },
        async ({ project_name, agent_type }) => {
            try {
                // Ensure project is initialized
                const state = await readState(project_name);

                // Detect or use specified agent type
                const detectedType: HostAgentType = agent_type ?? (await detectHostAgent(state.projectDir));

                // Inject the prompt
                const result = await injectPrompt(state.projectDir, detectedType, {
                    projectName: state.projectName,
                    projectDir: state.projectDir,
                    workflow: state.workflow,
                    scale: state.scale,
                });

                const action = result.created ? 'Created' : result.replaced ? 'Updated' : 'Appended to';

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: [
                                `# Setup Complete`,
                                ``,
                                `${action} **${result.filePath}** with Harmonia PM guidance.`,
                                ``,
                                `## Configuration`,
                                `- Agent type: ${detectedType}`,
                                `- Project: ${state.projectName}`,
                                `- Workflow: ${state.workflow}`,
                                `- Scale: ${state.scale}`,
                                ``,
                                `## What was injected`,
                                `- Project Manager role definition and responsibilities`,
                                `- Full tool reference (${14} Harmonia tools)`,
                                `- Phase-by-phase workflow guide`,
                                `- Document review flow`,
                                `- Team member dispatch guide`,
                                `- Important rules for PM behavior`,
                                ``,
                                `## Next Steps`,
                                `The host agent will now follow the PM workflow automatically.`,
                                `Start by calling \`get_project_status\` to see where the project stands.`,
                            ].join('\n'),
                        },
                    ],
                };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);

                // Check if it's a "project not found" error
                if (message.includes('ENOENT') || message.includes('not found')) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Project "${project_name}" not initialized. Call project_init first, then setup_project.`,
                            },
                        ],
                        isError: true,
                    };
                }

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Error: ${message}`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    );
}
