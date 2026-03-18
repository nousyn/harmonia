/**
 * MCP Tool: role_dispatch
 *
 * Prepare all data needed to hand off a task to a team member role.
 * Returns: role prompt (with overrides injected), frontmatter config,
 * input artifacts, task brief, and dispatch tracking info.
 *
 * Node-based architecture: validates against workflow node states instead
 * of phase definitions. Accepts an optional node_id parameter to target
 * a specific task node.
 *
 * Automatically:
 * - Creates a dispatch record for tracking
 * - Searches for reusable idle sessions and provides guidance
 * - Triggers a dispatch_requested engine event
 * - Returns nextAction from the workflow engine
 *
 * This tool does NOT launch agents — it only prepares the data.
 * The coordinator decides how to pass this to the team member.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readDoc } from '../core/docs.js';
import { getMergedOverrides, resolveRoleConfig } from '../core/overrides.js';
import { createDispatch, findIdleSession } from '../core/dispatch.js';
import { loadDocSchema, formatSchemaGuidance } from '../core/schema.js';
import type { StepSchemaEntry } from '../core/schema.js';
import { resolveActive, isError } from './utils.js';
import { loadWorkflowForContext, processWorkflowEvent, formatNextAction } from './engine-helpers.js';
import type {
    CapabilityOverride,
    OverrideConfig,
    WorkflowNode,
    TaskNode,
    ArtifactDefinition,
    WorkflowPlugin,
    WorkflowState,
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
 * Find all task nodes in the workflow tree (recursive).
 */
function collectTaskNodes(node: WorkflowNode): TaskNode[] {
    const tasks: TaskNode[] = [];
    switch (node.type) {
        case 'task':
            tasks.push(node);
            break;
        case 'sequence':
        case 'parallel':
            for (const child of node.children) {
                tasks.push(...collectTaskNodes(child));
            }
            break;
        case 'gate':
            tasks.push(...collectTaskNodes(node.pass));
            if ('type' in node.fail) {
                tasks.push(...collectTaskNodes(node.fail as WorkflowNode));
            }
            break;
    }
    return tasks;
}

/**
 * Find a task node by ID in the workflow definition (including floating nodes).
 */
function findTaskNode(wf: WorkflowPlugin, nodeId: string): TaskNode | undefined {
    const allTasks = collectTaskNodes(wf.definition.root);
    const found = allTasks.find((t) => t.id === nodeId);
    if (found) return found;
    // Check floating nodes
    return wf.definition.floatingNodes?.find((fn) => fn.id === nodeId);
}

/**
 * Find task nodes for a given role that are active or pending.
 */
function findDispatchableNodes(wf: WorkflowPlugin, state: WorkflowState, role: string): TaskNode[] {
    const allTasks = collectTaskNodes(wf.definition.root);
    // Include floating nodes
    if (wf.definition.floatingNodes) {
        allTasks.push(...wf.definition.floatingNodes);
    }
    return allTasks.filter((t) => {
        if (t.role !== role) return false;
        const nodeState = state.nodes[t.id];
        return nodeState && (nodeState.status === 'active' || nodeState.status === 'pending');
    });
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

/**
 * Build Artifact Requirements section for the dispatch data package.
 * Loads schemas for each artifact defined in the workflow and formats them as writing guidance.
 * No scale filtering — all required artifacts are included.
 */
async function buildArtifactRequirements(
    wf: WorkflowPlugin,
    builtinDir: string,
    customDir: string,
    workflowName: string,
): Promise<string> {
    const artifactDefs = wf.artifactDefinitions;
    const artifactIds = Object.keys(artifactDefs);
    if (artifactIds.length === 0) return '';

    const sections: string[] = [];

    for (const artifactId of artifactIds) {
        const artifactDef = artifactDefs[artifactId];
        if (!artifactDef || artifactDef.external) continue;

        // Load main schema
        const schema = await loadDocSchema(builtinDir, customDir, workflowName, artifactId);

        // Load step schemas if artifact has steps
        let stepSchemas: StepSchemaEntry[] | undefined;
        if (artifactDef.steps && artifactDef.steps.length > 0) {
            stepSchemas = [];
            for (const step of artifactDef.steps) {
                const stepSchema = await loadDocSchema(
                    builtinDir,
                    customDir,
                    workflowName,
                    `${artifactId}.${step.id}`,
                );
                stepSchemas.push({ step, schema: stepSchema });
            }
        }

        // Skip if no schema at all
        if (!schema && (!stepSchemas || stepSchemas.every((s) => !s.schema))) continue;

        sections.push(formatSchemaGuidance(artifactId, artifactDef, schema, stepSchemas));
    }

    if (sections.length === 0) return '';

    return ['## Artifact Requirements', '', ...sections].join('\n');
}

export function registerDispatchRole(server: McpServer, builtinDir: string, customDir: string): void {
    server.tool(
        'role_dispatch',
        "Prepare all data needed to dispatch a task to a team member. Returns the role's prompt (with capability overrides), configuration, input artifacts, task brief, and a dispatch tracking ID. Automatically searches for reusable sessions and provides guidance. Does NOT launch agents — you (coordinator) decide how to pass this to the team member. After launching, call dispatch_report to register the session.",
        {
            project_name: z.string().describe('Project name'),
            role: z.string().describe('Role ID to dispatch (e.g. architect, developer, tester)'),
            task_brief: z
                .string()
                .describe(
                    'Task description for the team member — what they need to do, which tasks from the breakdown, specific instructions, etc.',
                ),
            node_id: z
                .string()
                .optional()
                .describe(
                    'Target task node ID from the workflow tree. If omitted, automatically finds an active/pending task node for the specified role.',
                ),
            input_artifact_ids: z
                .array(z.string())
                .optional()
                .describe(
                    'Artifact IDs to include as input for the team member. If not specified, no artifacts are auto-included.',
                ),
        },
        async ({ project_name, role, task_brief, node_id, input_artifact_ids }) => {
            try {
                const ctx = await resolveActive(project_name);
                if (isError(ctx)) return ctx;

                // Load project state and workflow plugin
                const { wf, state } = await loadWorkflowForContext(builtinDir, customDir, project_name, ctx);

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

                // Resolve target task node
                let targetNode: TaskNode | undefined;

                if (node_id) {
                    // Explicit node_id — validate it
                    targetNode = findTaskNode(wf, node_id);
                    if (!targetNode) {
                        return {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: `Node "${node_id}" not found or is not a task node in the workflow.`,
                                },
                            ],
                            isError: true,
                        };
                    }
                    if (targetNode.role !== role) {
                        return {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: `Node "${node_id}" is assigned to role "${targetNode.role}", not "${role}".`,
                                },
                            ],
                            isError: true,
                        };
                    }
                    // Validate node state allows dispatch
                    const nodeState = state.nodes[node_id];
                    if (nodeState && nodeState.status !== 'active' && nodeState.status !== 'pending') {
                        return {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: `Node "${node_id}" is in status "${nodeState.status}" — cannot dispatch. Only active or pending nodes can be dispatched.`,
                                },
                            ],
                            isError: true,
                        };
                    }
                } else {
                    // Auto-find: look for active/pending task nodes for this role
                    const candidates = findDispatchableNodes(wf, state, role);
                    if (candidates.length === 0) {
                        return {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: `No active or pending task nodes found for role "${role}". Check project_status to see the current workflow state.`,
                                },
                            ],
                            isError: true,
                        };
                    }
                    // Prefer active over pending
                    targetNode = candidates.find((t) => state.nodes[t.id]?.status === 'active') ?? candidates[0];
                }

                const targetNodeId = targetNode.id;

                // Get merged overrides
                const overrides = await getMergedOverrides(project_name);

                // Build the full prompt with overrides injected
                const overrideSection = buildOverrideSection(role, overrides);
                const fullPrompt = overrideSection ? `${roleDef.prompt}\n${overrideSection}` : roleDef.prompt;

                // Read input artifacts
                const artifactIds = input_artifact_ids ?? [];
                const inputArtifacts: Record<string, string> = {};
                const missingArtifacts: string[] = [];
                for (const artifactId of artifactIds) {
                    const artifactDef = wf.artifactDefinitions[artifactId];
                    if (artifactDef?.external) continue; // external not stored
                    try {
                        inputArtifacts[artifactId] = await readDoc(project_name, ctx.number, artifactId, ctx.dir);
                    } catch {
                        missingArtifacts.push(artifactId);
                    }
                }

                // Resolve agent/model overrides
                const roleConfig = resolveRoleConfig(role, overrides);

                // Check for reusable idle session
                const idleSession = await findIdleSession(project_name, ctx.number, role, ctx.dir);

                // Create dispatch record
                const dispatch = await createDispatch(
                    project_name,
                    ctx.number,
                    role,
                    task_brief,
                    [], // expectedOutputs — determined dynamically, not from phase
                    idleSession?.id,
                    ctx.dir,
                    targetNodeId,
                );

                // Trigger engine event: dispatch_requested
                const engineResult = await processWorkflowEvent(
                    builtinDir,
                    customDir,
                    project_name,
                    ctx,
                    { type: 'dispatch_requested', nodeId: targetNodeId },
                );

                const nextActionText = formatNextAction(engineResult.nextAction);

                // Build session guidance
                const sessionGuidance = buildSessionGuidance(
                    idleSession,
                    roleDef.frontmatter.session,
                    roleConfig.agent,
                );

                // Build human-readable summary
                const agentLine = roleConfig.agent ? `\n- Agent: ${roleConfig.agent}` : '';
                const modelDisplay = roleConfig.model ?? roleDef.frontmatter.model;

                // Build artifact requirements for expected outputs
                const artifactRequirements = await buildArtifactRequirements(
                    wf,
                    builtinDir,
                    customDir,
                    state.workflow,
                );

                const summary = [
                    `# Dispatch: ${role}`,
                    ``,
                    `## Dispatch Tracking`,
                    `- Dispatch ID: \`${dispatch.id}\``,
                    `- Status: ${dispatch.status}`,
                    `- Target Node: ${targetNodeId}`,
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
                    `- Workflow: ${state.workflow}`,
                    ``,
                    `## Input Artifacts (${Object.keys(inputArtifacts).length}${missingArtifacts.length > 0 ? `, ${missingArtifacts.length} missing` : ''})`,
                ];

                for (const [artifactId, content] of Object.entries(inputArtifacts)) {
                    summary.push(``, `### ${artifactId}`, ``, content);
                }

                if (missingArtifacts.length > 0) {
                    summary.push(``, `### Missing Artifacts`, ...missingArtifacts.map((a) => `- ${a}`));
                }

                summary.push(
                    ``,
                    `## Next Step`,
                    `After launching the agent, call \`dispatch_report\` with dispatch_id="${dispatch.id}" and the agent's session ID.`,
                    `When the agent finishes, call \`dispatch_report\` again with status="completed" (or "failed").`,
                );

                if (artifactRequirements) {
                    summary.push(``, artifactRequirements);
                }

                summary.push(``, `## Role Prompt`, ``, fullPrompt);
                summary.push(nextActionText);

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
