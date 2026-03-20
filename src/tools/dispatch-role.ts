/**
 * MCP Tool: role_dispatch
 *
 * Prepare all data needed to hand off a task to a team member role.
 * Returns: role prompt (with overrides injected), session guidance,
 * input artifacts, task brief, and dispatch tracking info.
 *
 * Node-based architecture: validates against workflow node states.
 * Accepts an optional node_id parameter to target a specific task node.
 *
 * Session/parallel behavior is enforced by Core:
 * - session: none → never searches for idle sessions
 * - session: persistent → searches for idle sessions, directs reuse
 * - session: optional → searches for idle sessions, suggests reuse
 * - parallel: true + running dispatch → forces new session
 *
 * Automatically:
 * - Creates a dispatch record for tracking
 * - Enforces session/parallel strategy from role frontmatter
 * - Triggers a dispatch_requested engine event
 * - Returns nextAction from the workflow engine
 *
 * This tool does NOT launch agents — it only prepares the data.
 * The coordinator decides how to pass this to the team member.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readArtifact, listArtifacts, resolveArtifactDir } from '../core/artifacts.js';
import type { ArtifactIOContext } from '../core/artifacts.js';
import { getMergedOverrides, resolveRoleConfig } from '../core/overrides.js';
import { createDispatch, findIdleSession, hasRunningDispatch } from '../core/dispatch.js';
import { loadArtifactSchema, formatSchemaGuidance } from '../core/schema.js';
import type { StepSchemaEntry } from '../core/schema.js';
import { resolveActive, isError, buildOverrideSection } from './utils.js';
import {
    loadWorkflowForContext,
    processWorkflowEvent,
    formatNextAction,
    collectTaskNodes,
    findTaskNode,
} from './engine-helpers.js';
import type { TaskNode, WorkflowPlugin, WorkflowState, ActionContext } from '../core/types.js';

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
 * Build session guidance text.
 *
 * Incorporates session type behavior, parallel status, model, and agent info.
 * This replaces the former separate "## Configuration" section — all dispatch
 * configuration info is now part of Session Guidance.
 */
function buildSessionGuidance(params: {
    idleSession: Awaited<ReturnType<typeof findIdleSession>>;
    sessionType: 'none' | 'persistent' | 'optional';
    model?: string;
    agent?: string;
    parallelForced: boolean;
}): string {
    const { idleSession, sessionType, model, agent, parallelForced } = params;
    const lines: string[] = [];

    // Consistent agent descriptor used across all Action lines
    const agentDesc = agent ? `拉起 ${agent} 作为子 agent 执行任务` : '拉起子 agent 执行任务';

    // Model/agent header
    if (model) {
        const agentSuffix = agent ? `，使用 ${agent}` : '';
        lines.push(`**Model**: \`${model}\`${agentSuffix}`);
    } else if (agent) {
        lines.push(`**Agent**: ${agent}`);
    }
    if (lines.length > 0) lines.push('');

    // Session guidance based on type and findings
    if (parallelForced) {
        // parallel=true and same role already has a running dispatch → force new session
        lines.push(`**Session**: 该角色已有运行中的 dispatch，强制启动新会话（parallel 模式）`);
        lines.push('');
        lines.push(`**Action**: ${agentDesc}。`);
    } else if (idleSession) {
        const agentId = idleSession.agentSessionId
            ? `Agent session ID: \`${idleSession.agentSessionId}\``
            : 'Agent session ID: not recorded';
        const label = idleSession.label ? ` (${idleSession.label})` : '';

        lines.push(`**Reusable session found**: ${idleSession.id}${label}`);
        lines.push(`- ${agentId}`);
        lines.push(`- Agent type: ${idleSession.agentType ?? 'unknown'}`);
        lines.push(`- Last active: ${idleSession.lastActiveAt}`);
        lines.push('');

        if (sessionType === 'persistent') {
            lines.push(`**Action**: 复用已有会话，而非启动新 agent。`);
            lines.push(
                idleSession.agentSessionId
                    ? `使用 \`--resume ${idleSession.agentSessionId}\` 或 \`--session ${idleSession.agentSessionId}\` 恢复会话。`
                    : `注意: 该会话未记录 agent session ID，可能需要${agentDesc}。`,
            );
        } else {
            // optional — suggestion, not directive
            lines.push(`**Suggestion**: 存在空闲会话，可复用也可启动新会话，由你决定。`);
            if (idleSession.agentSessionId) {
                lines.push(
                    `如需复用: \`--resume ${idleSession.agentSessionId}\` 或 \`--session ${idleSession.agentSessionId}\``,
                );
            }
        }
    } else {
        // No idle session found (or session type is 'none')
        if (sessionType === 'none') {
            lines.push(`**Session**: 每次 dispatch 启动全新会话（session: none）`);
        } else {
            lines.push(`**未找到可复用会话**`);
            lines.push(`Session type: ${sessionType}`);
        }
        lines.push('');
        lines.push(`**Action**: ${agentDesc}。`);
    }

    return lines.join('\n');
}

/**
 * Build Artifact Requirements section for the dispatch data package.
 * Only includes schemas for artifacts associated with the dispatched role
 * (via the role's capabilities).
 */
async function buildArtifactRequirements(
    wf: WorkflowPlugin,
    workflowsDir: string,
    workflowName: string,
    role: string,
): Promise<string> {
    const artifactDefs = wf.artifactDefinitions;

    // Extract artifact IDs from role capabilities
    const roleDef = wf.roles[role];
    const roleArtifactIds = new Set<string>();
    if (roleDef?.frontmatter.capabilities) {
        for (const cap of roleDef.frontmatter.capabilities) {
            if (cap.artifact) {
                roleArtifactIds.add(cap.artifact);
            }
        }
    }

    // If role has no artifact capabilities, skip
    if (roleArtifactIds.size === 0) return '';

    const sections: string[] = [];

    for (const artifactId of roleArtifactIds) {
        const artifactDef = artifactDefs[artifactId];
        if (!artifactDef || artifactDef.unmanaged) continue;

        // Load main schema
        const schema = await loadArtifactSchema(workflowsDir, workflowName, artifactId);

        // Load step schemas if artifact has steps
        let stepSchemas: StepSchemaEntry[] | undefined;
        if (artifactDef.steps && artifactDef.steps.length > 0) {
            stepSchemas = [];
            for (const step of artifactDef.steps) {
                const stepSchema = await loadArtifactSchema(workflowsDir, workflowName, `${artifactId}.${step.id}`);
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

export function registerDispatchRole(server: McpServer, workflowsDir: string): void {
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
                const { wf, state } = await loadWorkflowForContext(workflowsDir, project_name, ctx);

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

                // Build I/O context for artifact path resolution
                const ioCtx: ArtifactIOContext = {
                    contextDir: ctx.dir,
                    projectDir: ctx.entry.dir,
                    contextLabel: ctx.activeContext,
                };

                // Get merged overrides
                const overrides = await getMergedOverrides(project_name);

                // Build the full prompt with overrides injected
                const overrideSection = buildOverrideSection(role, overrides);
                let fullPrompt = overrideSection ? `${roleDef.prompt}\n${overrideSection}` : roleDef.prompt;

                // Execute beforeDispatch hooks (if defined on the target node)
                const hookInjections: string[] = [];
                if (targetNode.beforeDispatch) {
                    // Collect static inject text
                    if (targetNode.beforeDispatch.inject) {
                        hookInjections.push(...targetNode.beforeDispatch.inject);
                    }

                    // Execute registered actions
                    if (targetNode.beforeDispatch.actions && wf.actions) {
                        const nodeState = state.nodes[targetNodeId];
                        const actionCtx: ActionContext = {
                            nodeId: targetNodeId,
                            role,
                            retryCount: nodeState?.retryCount ?? 0,
                            projectName: project_name,
                            pluginConfig: wf.config,
                            workflowState: state,
                            artifacts: {
                                read: (artifactId: string) =>
                                    readArtifact(artifactId, ioCtx, wf.artifactDefinitions[artifactId]),
                                list: () => listArtifacts(ioCtx, wf.artifactDefinitions),
                            },
                        };
                        for (const actionName of targetNode.beforeDispatch.actions) {
                            const handler = wf.actions[actionName];
                            if (handler) {
                                try {
                                    const result = await handler(actionCtx);
                                    if (result.inject) {
                                        hookInjections.push(...result.inject);
                                    }
                                } catch (err) {
                                    console.warn(`[harmonia] beforeDispatch action "${actionName}" failed:`, err);
                                }
                            } else {
                                console.warn(`[harmonia] beforeDispatch action "${actionName}" not registered`);
                            }
                        }
                    }
                }

                // Append hook injections to the role prompt
                if (hookInjections.length > 0) {
                    fullPrompt += '\n\n' + hookInjections.join('\n\n');
                }

                // Read input artifacts
                const artifactIds = input_artifact_ids ?? [];
                const inputArtifacts: Record<string, string> = {};
                const missingArtifacts: string[] = [];
                for (const artifactId of artifactIds) {
                    const artifactDef = wf.artifactDefinitions[artifactId];
                    if (artifactDef?.unmanaged) continue; // unmanaged not stored via artifact_write
                    try {
                        inputArtifacts[artifactId] = await readArtifact(artifactId, ioCtx, artifactDef);
                    } catch {
                        missingArtifacts.push(artifactId);
                    }
                }

                // Resolve agent/model: override takes precedence over frontmatter
                const roleConfig = resolveRoleConfig(role, overrides);
                const modelDisplay = roleConfig.model ?? roleDef.frontmatter.model;
                const agentDisplay = roleConfig.agent ?? roleDef.frontmatter.agent;
                const sessionType = roleDef.frontmatter.session;

                // Determine session strategy based on session type + parallel field
                let idleSession: Awaited<ReturnType<typeof findIdleSession>> = null;
                let parallelForced = false;

                if (sessionType === 'none') {
                    // session: none → never look for idle sessions
                    idleSession = null;
                } else if (roleDef.frontmatter.parallel) {
                    // parallel=true → check if same role has running dispatches
                    const hasRunning = await hasRunningDispatch(project_name, ctx.number, role, ctx.dir);
                    if (hasRunning) {
                        // Force new session — don't look for idle ones
                        parallelForced = true;
                        idleSession = null;
                    } else {
                        // No running dispatch → follow normal session behavior
                        idleSession = await findIdleSession(project_name, ctx.number, role, ctx.dir);
                    }
                } else {
                    // session: persistent or optional → look for idle sessions
                    idleSession = await findIdleSession(project_name, ctx.number, role, ctx.dir);
                }

                // Create dispatch record
                const dispatch = await createDispatch(
                    project_name,
                    ctx.number,
                    role,
                    task_brief,
                    [], // expectedOutputs — determined dynamically by workflow engine
                    idleSession?.id,
                    ctx.dir,
                    targetNodeId,
                );

                // Trigger engine event: dispatch_requested
                const engineResult = await processWorkflowEvent(workflowsDir, project_name, ctx, {
                    type: 'dispatch_requested',
                    nodeId: targetNodeId,
                });

                const nextActionText = formatNextAction(engineResult.nextAction);

                // Build session guidance (now includes model/agent info — replaces ## Configuration)
                const sessionGuidance = buildSessionGuidance({
                    idleSession,
                    sessionType,
                    model: modelDisplay,
                    agent: agentDisplay,
                    parallelForced,
                });

                // Build artifact requirements for expected outputs
                const artifactRequirements = await buildArtifactRequirements(wf, workflowsDir, state.workflow, role);

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
                    `## Project Context`,
                    `- Project: ${project_name}`,
                    `- Directory: ${state.projectDir}`,
                    `- Workflow: ${state.workflow}`,
                ];

                // Inject unmanaged artifact output path hints
                const unmanagedHints: string[] = [];
                for (const cap of roleDef.frontmatter.capabilities ?? []) {
                    if (!cap.artifact) continue;
                    const def = wf.artifactDefinitions[cap.artifact];
                    if (!def?.unmanaged) continue;
                    const outputDir = resolveArtifactDir(def.output, ioCtx);
                    unmanagedHints.push(`- **${cap.artifact}** (${def.name}): \`${outputDir}\``);
                }
                if (unmanagedHints.length > 0) {
                    summary.push(
                        ``,
                        `## Unmanaged Artifact Output Paths`,
                        `以下 artifact 由 agent 直接输出（非 artifact_write），请将产出写入对应路径:`,
                        ...unmanagedHints,
                    );
                }

                summary.push(
                    ``,
                    `## Input Artifacts (${Object.keys(inputArtifacts).length}${missingArtifacts.length > 0 ? `, ${missingArtifacts.length} missing` : ''})`,
                );

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
