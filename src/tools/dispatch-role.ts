/**
 * MCP Tool: dispatch_role
 *
 * Prepare all data needed to hand off a task to a team member role.
 * Returns: role prompt (with overrides injected), frontmatter config,
 * input documents, task brief, and dispatch tracking info.
 *
 * Automatically:
 * - Creates a dispatch record for tracking
 * - Searches for reusable idle sessions and provides guidance
 *
 * This tool does NOT launch agents — it only prepares the data.
 * The host agent (PM) decides how to pass this to the team member.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadWorkflow } from '../core/workflow.js';
import { readState } from '../core/state.js';
import { readDoc } from '../core/docs.js';
import { getMergedOverrides, resolveRoleConfig } from '../core/overrides.js';
import { createDispatch, findIdleSession } from '../core/dispatch.js';
import type {
    CapabilityOverride,
    OverrideConfig,
    PhaseDefinition,
    ProjectScale,
    WorkflowDefinition,
} from '../core/types.js';

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

/**
 * Resolve expected output doc IDs for a dispatch.
 * Uses the current phase's outputs, filtering out external, scale-skipped, and optional docs.
 */
function resolveExpectedOutputs(
    currentPhase: PhaseDefinition | undefined,
    workflowDef: WorkflowDefinition,
    scale: ProjectScale,
): string[] {
    if (!currentPhase) return [];
    return currentPhase.outputs.filter((docId) => {
        const docDef = workflowDef.docs[docId];
        if (!docDef) return false;
        if (docDef.external) return false;
        const scaleVal = docDef.scale[scale];
        if (scaleVal === 'skip' || scaleVal === 'optional') return false;
        return true;
    });
}

export function registerDispatchRole(server: McpServer, workflowsDir: string): void {
    server.tool(
        'dispatch_role',
        "Prepare all data needed to dispatch a task to a team member. Returns the role's prompt (with capability overrides), configuration, input documents, task brief, and a dispatch tracking ID. Automatically searches for reusable sessions and provides guidance. Does NOT launch agents — you (PM) decide how to pass this to the team member. After launching, call report_dispatch to register the session.",
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

                // Guard: role-phase validation
                const currentPhase = findCurrentPhase(wf.definition.phases, state.currentPhase);
                const currentPhaseRoles = currentPhase?.roles ?? [];
                const phaseIndex = wf.definition.phases.findIndex((p) => p.id === state.currentPhase);
                const nextPhase = phaseIndex >= 0 ? wf.definition.phases[phaseIndex + 1] : undefined;
                const nextPhaseRoles = nextPhase?.roles ?? [];
                const allowedRoles = [...new Set([...currentPhaseRoles, ...nextPhaseRoles])];

                if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: [
                                    `角色 "${role}" 不属于当前阶段 "${state.currentPhase}" 或下一阶段的角色。`,
                                    `当前阶段允许的角色: ${currentPhaseRoles.join(', ') || '(无)'}`,
                                    nextPhase
                                        ? `下一阶段 (${nextPhase.id}) 允许的角色: ${nextPhaseRoles.join(', ')}`
                                        : '',
                                    '',
                                    '如确需 dispatch 此角色，请先推进阶段。',
                                ]
                                    .filter(Boolean)
                                    .join('\n'),
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
                const docIds = input_doc_ids ?? currentPhase?.inputs ?? [];

                // Read input documents (skip external docs like "code" — not managed by write_doc)
                const inputDocs: Record<string, string> = {};
                const missingDocs: string[] = [];
                for (const docId of docIds) {
                    const docDef = wf.definition.docs[docId];
                    if (docDef?.external) continue; // external outputs not stored as docs
                    try {
                        inputDocs[docId] = await readDoc(project_name, docId);
                    } catch {
                        missingDocs.push(docId);
                    }
                }

                // Resolve agent/model overrides
                const roleConfig = resolveRoleConfig(role, overrides);

                // Resolve expected outputs for this dispatch
                const expectedOutputs = resolveExpectedOutputs(currentPhase, wf.definition, state.scale);

                // Check for reusable idle session
                const idleSession = await findIdleSession(project_name, role);

                // Create dispatch record
                const dispatch = await createDispatch(project_name, role, task_brief, expectedOutputs, idleSession?.id);

                // Build session guidance
                const sessionGuidance = buildSessionGuidance(
                    idleSession,
                    roleDef.frontmatter.session,
                    roleConfig.agent,
                );

                // Build human-readable summary for the agent
                const agentLine = roleConfig.agent ? `\n- Agent: ${roleConfig.agent}` : '';
                const modelDisplay = roleConfig.model ?? roleDef.frontmatter.model;
                const summary = [
                    `# Dispatch: ${role}`,
                    ``,
                    `## Dispatch Tracking`,
                    `- Dispatch ID: \`${dispatch.id}\``,
                    `- Status: ${dispatch.status}`,
                    ``,
                    `## Session Guidance`,
                    sessionGuidance,
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

                summary.push(
                    ``,
                    `## Next Step`,
                    `After launching the agent, call \`report_dispatch\` with dispatch_id="${dispatch.id}" and the agent's session ID.`,
                    `When the agent finishes, call \`report_dispatch\` again with status="completed" (or "failed").`,
                    ``,
                    `## Role Prompt`,
                    ``,
                    fullPrompt,
                );

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

/**
 * Build session guidance text based on whether an idle session exists.
 */
function buildSessionGuidance(
    idleSession: Awaited<ReturnType<typeof findIdleSession>>,
    sessionType: string,
    agentOverride?: string,
): string {
    if (idleSession) {
        const agentId = idleSession.agentSessionId
            ? `Agent session ID: \`${idleSession.agentSessionId}\``
            : 'Agent session ID: not recorded';
        const label = idleSession.label ? ` (${idleSession.label})` : '';
        return [
            `**Reusable session found**: ${idleSession.id}${label}`,
            `- ${agentId}`,
            `- Agent type: ${idleSession.agentType ?? 'unknown'}`,
            `- Last active: ${idleSession.lastActiveAt}`,
            ``,
            `**Action**: Resume this session instead of launching a new agent.`,
            idleSession.agentSessionId
                ? `Use \`--resume ${idleSession.agentSessionId}\` or \`--session ${idleSession.agentSessionId}\` to restore the conversation.`
                : `Note: No agent session ID was recorded for this session. You may need to launch a new agent.`,
        ].join('\n');
    }

    return [
        `**No reusable session found** for this role.`,
        `Session type: ${sessionType}`,
        ``,
        `**Action**: Launch a new agent for this role.`,
        agentOverride ? `Configured agent type: ${agentOverride}` : '',
    ]
        .filter(Boolean)
        .join('\n');
}
