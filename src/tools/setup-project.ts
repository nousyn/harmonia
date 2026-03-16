/**
 * MCP Tool: project_setup
 *
 * Inject Harmonia PM guidance into the host agent's config file (e.g. AGENTS.md).
 * This makes the host agent aware of Harmonia tools and the PM workflow.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readState } from '../core/state.js';
import { getGlobalDir } from '../core/registry.js';
import { detectHostAgent, injectPrompt } from '../setup/inject.js';
import { installHooks } from '../hooks/install.js';
import type { AgentType } from '@s_s/agent-kit';

export function registerSetupProject(server: McpServer): void {
    server.tool(
        'project_setup',
        "Inject Harmonia PM guidance into the host agent's config file (AGENTS.md / CLAUDE.md). Makes the host agent aware of all Harmonia tools and the PM workflow. Requires project_init to be called first. Idempotent — safe to call multiple times.",
        {
            project_name: z.string().describe('Project name (must be initialized)'),
            agent_type: z
                .enum(['opencode', 'claude-code', 'codex', 'openclaw'])
                .optional()
                .describe('Host agent type. If not specified, auto-detects based on project directory contents.'),
        },
        async ({ project_name, agent_type }) => {
            try {
                // Ensure project is initialized
                const state = await readState(project_name);

                // Detect or use specified agent type
                const detectedType: AgentType = agent_type ?? (await detectHostAgent(state.projectDir));

                // Inject the prompt
                const result = await injectPrompt(state.projectDir, detectedType, {
                    projectName: state.projectName,
                    projectDir: state.projectDir,
                    workflow: state.workflow,
                    scale: state.scale,
                });

                // Install agent hooks (boundary guard + proactive reminders)
                let hookStatus = '';
                try {
                    const hookResult = await installHooks(detectedType, {
                        dataDir: getGlobalDir(),
                        projectName: state.projectName,
                        projectDir: state.projectDir,
                    });
                    if (hookResult.success) {
                        hookStatus = `Installed (${hookResult.filesWritten.length} files)`;
                        if (hookResult.warnings.length > 0) {
                            hookStatus += ` — warnings: ${hookResult.warnings.join('; ')}`;
                        }
                    } else {
                        hookStatus = `Failed: ${hookResult.error ?? 'unknown error'}`;
                    }
                } catch (hookErr) {
                    hookStatus = `Error: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`;
                }

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
                                `- Full tool reference (${15} Harmonia tools)`,
                                `- Phase-by-phase workflow guide`,
                                `- Document review flow`,
                                `- Team member dispatch guide`,
                                `- Important rules for PM behavior`,
                                ``,
                                `## Agent Hooks`,
                                `- Status: ${hookStatus}`,
                                `- Boundary guard: prevents PM from directly modifying code or running dev commands`,
                                `- Proactive reminders: dispatch timeout, idle phase, pending reviews`,
                                ``,
                                `## Next Steps`,
                                `The host agent will now follow the PM workflow automatically.`,
                                `Start by calling \`project_status\` to see where the project stands.`,
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
                                text: `Project "${project_name}" not initialized. Call project_init first, then project_setup.`,
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
