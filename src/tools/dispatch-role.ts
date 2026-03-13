/**
 * MCP Tool: dispatch_role
 *
 * Prepare all data needed to hand off a task to a team member role.
 * Returns: role prompt (with overrides injected), frontmatter config,
 * input documents, and task brief.
 *
 * This tool does NOT launch agents — it only prepares the data.
 * The host agent (PM) decides how to pass this to the team member.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadWorkflow } from '../core/workflow.js';
import { readState } from '../core/state.js';
import { readDoc } from '../core/docs.js';
import { getMergedOverrides, resolveCapabilityOverride, resolveRoleConfig } from '../core/overrides.js';
import type { CapabilityOverride, OverrideConfig, PhaseDefinition, RoleDefinition } from '../core/types.js';

/**
 * Build override instructions to inject into the role prompt.
 */
function buildOverrideSection(roleId: string, overrides: OverrideConfig): string {
    const roleOverrides = overrides.roles?.[roleId]?.capabilities;
    if (!roleOverrides || Object.keys(roleOverrides).length === 0) {
        return '';
    }

    const lines: string[] = [
        '',
        '## Enhanced Capabilities',
        '',
        'The following capabilities have been configured to use external tools.',
        'Use the specified tool instead of built-in behavior for these actions.',
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

/**
 * Find the current phase definition from the workflow.
 */
function findCurrentPhase(phases: PhaseDefinition[], currentPhaseId: string): PhaseDefinition | undefined {
    return phases.find((p) => p.id === currentPhaseId);
}

export function registerDispatchRole(server: McpServer, workflowsDir: string): void {
    server.tool(
        'dispatch_role',
        "Prepare all data needed to dispatch a task to a team member. Returns the role's prompt (with capability overrides), configuration, input documents, and a task brief. Does NOT launch agents — you (PM) decide how to pass this to the team member.",
        {
            project_name: z.string().describe('Project name'),
            role: z.string().describe('Role ID to dispatch (e.g. architect, developer, tester)'),
            task_brief: z
                .string()
                .describe(
                    'Task description for the team member — what they need to do, which tasks from the breakdown, specific instructions, etc.',
                ),
            input_doc_ids: z
                .array(z.string())
                .optional()
                .describe(
                    "Document IDs to include as input for the team member. If not specified, automatically uses the current phase's input docs.",
                ),
        },
        async ({ project_name, role, task_brief, input_doc_ids }) => {
            try {
                // Load project state and workflow
                const state = await readState(project_name);
                const wf = await loadWorkflow(workflowsDir, state.workflow);

                // Validate role exists
                const roleDef = wf.roles[role];
                if (!roleDef) {
                    const available = Object.keys(wf.roles).join(', ');
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Role "${role}" not found. Available: ${available}`,
                            },
                        ],
                        isError: true,
                    };
                }

                // Get merged overrides
                const overrides = await getMergedOverrides(project_name);

                // Build the full prompt with overrides injected
                const overrideSection = buildOverrideSection(role, overrides);
                const fullPrompt = overrideSection ? `${roleDef.prompt}\n${overrideSection}` : roleDef.prompt;

                // Determine input docs
                const currentPhase = findCurrentPhase(wf.definition.phases, state.currentPhase);
                const docIds = input_doc_ids ?? currentPhase?.inputs ?? [];

                // Read input documents
                const inputDocs: Record<string, string> = {};
                const missingDocs: string[] = [];
                for (const docId of docIds) {
                    try {
                        inputDocs[docId] = await readDoc(project_name, docId);
                    } catch {
                        missingDocs.push(docId);
                    }
                }

                // Resolve agent/model overrides
                const roleConfig = resolveRoleConfig(role, overrides);

                // Build the response
                const result: Record<string, unknown> = {
                    role: role,
                    config: {
                        model: roleConfig.model ?? roleDef.frontmatter.model,
                        session: roleDef.frontmatter.session,
                        parallel: roleDef.frontmatter.parallel,
                        ...(roleConfig.agent ? { agent: roleConfig.agent } : {}),
                    },
                    prompt: fullPrompt,
                    task_brief: task_brief,
                    project: {
                        name: project_name,
                        dir: state.projectDir,
                        workflow: state.workflow,
                        scale: state.scale,
                        current_phase: state.currentPhase,
                    },
                    input_docs: inputDocs,
                };

                if (missingDocs.length > 0) {
                    result.missing_docs = missingDocs;
                }

                // Build human-readable summary for the agent
                const agentLine = roleConfig.agent ? `\n- Agent: ${roleConfig.agent}` : '';
                const modelDisplay = roleConfig.model ?? roleDef.frontmatter.model;
                const summary = [
                    `# Dispatch: ${role}`,
                    ``,
                    `## Task Brief`,
                    task_brief,
                    ``,
                    `## Configuration`,
                    `- Model: ${modelDisplay}`,
                    `- Session: ${roleDef.frontmatter.session}`,
                    `- Parallel: ${roleDef.frontmatter.parallel}${agentLine}`,
                    ``,
                    `## Project Context`,
                    `- Project: ${project_name}`,
                    `- Directory: ${state.projectDir}`,
                    `- Scale: ${state.scale}`,
                    `- Current phase: ${state.currentPhase}`,
                    ``,
                    `## Input Documents (${Object.keys(inputDocs).length}${missingDocs.length > 0 ? `, ${missingDocs.length} missing` : ''})`,
                ];

                for (const [docId, content] of Object.entries(inputDocs)) {
                    summary.push(``, `### ${docId}`, ``, content);
                }

                if (missingDocs.length > 0) {
                    summary.push(``, `### Missing Documents`, ...missingDocs.map((d) => `- ${d}`));
                }

                summary.push(``, `## Role Prompt`, ``, fullPrompt);

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: summary.join('\n'),
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
