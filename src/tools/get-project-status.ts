/**
 * MCP Tool: project_status
 * Read the current project status with rich context for coordinator decision-making.
 *
 * Node-based architecture: displays workflow tree with node states instead of phases.
 * Includes artifacts, pending reviews, dispatch records, active sessions,
 * workflow engine nextAction, and intelligent next-step suggestions.
 *
 * When called without project_name, returns a summary list of all projects.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readState } from '../core/state.js';
import { loadWorkflow } from '../core/plugin.js';
import { listArtifacts } from '../core/artifacts.js';
import { readReviews } from '../core/reviews.js';
import { readDispatches, readSessions } from '../core/dispatch.js';
import { readSteps, getCompletedStepIds } from '../core/steps.js';
import { listProjects, getProject, resolveContextDir } from '../core/registry.js';
import { readIssues } from '../core/issues.js';
import { processWorkflowEvent, formatNextAction } from './engine-helpers.js';
import type {
    DispatchRecord,
    SessionRecord,
    WorkflowNode,
    WorkflowState,
    NodeState,
    ArtifactDefinition,
    WorkflowPlugin,
} from '../core/types.js';
import type { ArtifactStepState } from '../core/types.js';
import type { ResolvedContext } from './utils.js';

// --- Formatting Helpers ---

/**
 * Get status icon for a node.
 */
function statusIcon(status: string): string {
    switch (status) {
        case 'completed':
            return '✓';
        case 'active':
            return '●';
        case 'failed':
            return '✗';
        case 'cancelled':
            return '—';
        case 'skipped':
            return '⊘';
        default:
            return '○';
    }
}

/**
 * Get dispatch info string for a node (if any active dispatches target it).
 */
function getNodeDispatchInfo(nodeId: string, dispatches: DispatchRecord[]): string {
    const nodeDispatches = dispatches.filter(
        (d) => d.nodeId === nodeId && (d.status === 'dispatched' || d.status === 'running'),
    );
    if (nodeDispatches.length === 0) return '';
    const info = nodeDispatches.map((d) => d.id + ':' + d.status).join(', ');
    return ' [' + info + ']';
}

/**
 * Format the workflow tree as an indented status view.
 */
function formatNodeTree(
    node: WorkflowNode,
    nodes: Record<string, NodeState>,
    dispatches: DispatchRecord[],
    depth: number = 0,
): string[] {
    const indent = '  '.repeat(depth);
    const lines: string[] = [];
    const state = nodes[node.id];
    const status = state?.status ?? 'pending';
    const icon = statusIcon(status);

    switch (node.type) {
        case 'task': {
            const dispatchInfo = getNodeDispatchInfo(node.id, dispatches);
            lines.push(indent + icon + ' ' + node.id + ' (task, ' + node.role + ') — ' + status + dispatchInfo);
            break;
        }
        case 'sequence':
            lines.push(indent + icon + ' ' + node.id + ' (sequence) — ' + status);
            for (const child of node.children) {
                lines.push(...formatNodeTree(child, nodes, dispatches, depth + 1));
            }
            break;
        case 'parallel':
            lines.push(indent + icon + ' ' + node.id + ' (parallel, ' + node.failStrategy + ') — ' + status);
            for (const child of node.children) {
                lines.push(...formatNodeTree(child, nodes, dispatches, depth + 1));
            }
            break;
        case 'gate': {
            const gateStatus = status === 'completed' ? 'passed' : status === 'failed' ? 'failed' : status;
            lines.push(indent + icon + ' ' + node.id + ' (gate) — ' + gateStatus);
            lines.push(...formatNodeTree(node.pass, nodes, dispatches, depth + 1));
            if ('type' in node.fail) {
                lines.push(...formatNodeTree(node.fail as WorkflowNode, nodes, dispatches, depth + 1));
            } else {
                const failTarget = node.fail as { goto: string };
                lines.push(indent + '  ↩ fail → goto ' + failTarget.goto);
            }
            break;
        }
    }

    return lines;
}

/**
 * Format a dispatch record for display.
 */
function formatDispatch(d: DispatchRecord, sessions: SessionRecord[]): string {
    const icon = statusIcon(d.status === 'dispatched' ? 'pending' : d.status === 'running' ? 'active' : d.status);
    const session = sessions.find((s) => s.id === d.sessionId);
    const sessionInfo = session?.agentSessionId ? ' session:' + session.agentSessionId : '';
    const note = d.note ? ' (' + d.note + ')' : '';
    const nodeInfo = d.nodeId ? ' node:' + d.nodeId : '';
    const brief = d.taskBrief.length > 60 ? d.taskBrief.slice(0, 57) + '...' : d.taskBrief;
    return (
        '  ' +
        icon +
        ' ' +
        d.id +
        '  ' +
        d.role.padEnd(12) +
        ' [' +
        d.status +
        ']  ' +
        brief +
        nodeInfo +
        sessionInfo +
        note
    );
}

/**
 * Format a session record for display.
 */
function formatSession(s: SessionRecord): string {
    const agentInfo = s.agentSessionId ? 'agent:' + s.agentSessionId : 'no agent ID';
    const label = s.label ? ' (' + s.label + ')' : '';
    const agentType = s.agentType ? ' via ' + s.agentType : '';
    return '  ' + s.id + '  ' + s.role.padEnd(12) + ' [' + s.status + ']  ' + agentInfo + agentType + label;
}

/**
 * Format step progress for a sequential artifact.
 */
function formatStepProgress(artifactDef: ArtifactDefinition, stepState: ArtifactStepState | undefined): string {
    const steps = artifactDef.steps!;
    const completedIds = stepState ? getCompletedStepIds(stepState) : new Set<string>();
    const finalized = stepState?.finalized ?? false;

    if (finalized) {
        return '  Steps: all completed ✓ (finalized)';
    }

    let firstIncomplete = steps.length;
    for (let i = 0; i < steps.length; i++) {
        if (!completedIds.has(steps[i].id)) {
            firstIncomplete = i;
            break;
        }
    }

    const parts = steps.map((s, i) => {
        if (completedIds.has(s.id)) return '[✓] ' + s.name;
        if (i === firstIncomplete) return '[→] ' + s.name;
        return '[ ] ' + s.name;
    });

    return '  Steps: ' + parts.join(' → ');
}

/**
 * Format artifacts summary.
 */
function formatArtifacts(
    existingArtifacts: string[],
    artifactDefs: Record<string, ArtifactDefinition>,
    reviews: Record<string, { status: string; submittedAt: string }>,
    stepsData: Record<string, ArtifactStepState>,
): string {
    if (existingArtifacts.length === 0) return '(none yet)';

    return existingArtifacts
        .map((id) => {
            const review = reviews[id];
            const reviewTag = review ? ' [' + review.status + ']' : '';
            const def = artifactDefs[id];
            const hasSteps = def?.steps && def.steps.length > 0;
            let line = '- ' + id + reviewTag;
            if (hasSteps) {
                line += '\n' + formatStepProgress(def, stepsData[id]);
            }
            return line;
        })
        .join('\n');
}

/**
 * Format in-progress artifacts (steps started but artifact not yet finalized).
 */
function formatInProgressArtifacts(
    existingArtifacts: string[],
    artifactDefs: Record<string, ArtifactDefinition>,
    stepsData: Record<string, ArtifactStepState>,
): string {
    const inProgress = Object.keys(stepsData)
        .filter((id) => !existingArtifacts.includes(id))
        .map((id) => {
            const def = artifactDefs[id];
            if (!def?.steps?.length) return null;
            const stepState = stepsData[id];
            const completedCount = stepState?.completedSteps.length ?? 0;
            if (completedCount === 0) return null;
            return (
                '- ' +
                id +
                ' (in progress, ' +
                completedCount +
                '/' +
                def.steps.length +
                ' steps)\n' +
                formatStepProgress(def, stepState)
            );
        })
        .filter(Boolean);

    return inProgress.length > 0 ? inProgress.join('\n') : '';
}

/**
 * Build the project list summary (when project_name is not provided).
 */
async function buildProjectList(): Promise<string> {
    const projectNames = await listProjects();

    if (projectNames.length === 0) {
        return [
            '# Harmonia Projects',
            '',
            '(no registered projects)',
            '',
            'Use project_init(project_name, project_dir) to create a new project.',
        ].join('\n');
    }

    const rows: string[] = [];
    for (const name of projectNames) {
        try {
            const entry = await getProject(name);
            if (!entry || !entry.activeContext) {
                rows.push(`| ${name} | ${entry?.dir ?? '?'} | (no active context) | - | - |`);
                continue;
            }
            const resolved = resolveContextDir(name, entry.activeContext);
            if (!resolved) {
                rows.push(`| ${name} | ${entry.dir} | (context error) | - | - |`);
                continue;
            }
            const state = await readState(name, resolved.number, resolved.dir);
            const updated = state.updatedAt.split('T')[0];
            const activeNode = state.activeNodeId ?? '(none)';
            rows.push(
                `| ${name} | ${state.projectDir} | ${state.workflow} | ${activeNode} | ${entry.activeContext} | ${updated} |`,
            );
        } catch {
            rows.push(`| ${name} | (cannot read state) | - | - | - | - |`);
        }
    }

    return [
        '# Harmonia Projects',
        '',
        `Total: ${projectNames.length} projects`,
        '',
        '| Project | Directory | Workflow | Active Node | Context | Updated |',
        '|---------|-----------|----------|-------------|---------|---------|',
        ...rows,
        '',
        'Use project_status(project_name) to view project details.',
    ].join('\n');
}

export function registerGetProjectStatus(server: McpServer, workflowsDir: string): void {
    server.tool(
        'project_status',
        'View project status. Without project_name: returns summary of all projects. With project_name: returns detailed status including workflow tree, artifacts, dispatches, sessions, and next action.',
        {
            project_name: z.string().optional().describe('Project name. Omit to list all projects.'),
        },
        async ({ project_name }) => {
            // List mode
            if (!project_name) {
                const text = await buildProjectList();
                return { content: [{ type: 'text' as const, text }] };
            }

            // Detail mode
            try {
                const entry = await getProject(project_name);
                if (!entry) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Project "${project_name}" not registered. Use project_status() to list all projects, or project_init to create a new one.`,
                            },
                        ],
                        isError: true,
                    };
                }

                if (!entry.activeContext) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: [
                                    `# Project: ${project_name}`,
                                    ``,
                                    `Source directory: ${entry.dir}`,
                                    `Registered: ${entry.createdAt}`,
                                    `Iterations: ${entry.totalIterations}`,
                                    `Patches: ${entry.totalPatches}`,
                                    `Active context: (none)`,
                                    ``,
                                    `Project is registered but has no active iteration or patch. Call iteration_start(project_name="${project_name}") to begin.`,
                                ].join('\n'),
                            },
                        ],
                    };
                }

                const resolved = resolveContextDir(project_name, entry.activeContext);
                if (!resolved) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Project "${project_name}" activeContext "${entry.activeContext}" cannot be resolved. Data may be corrupted.`,
                            },
                        ],
                        isError: true,
                    };
                }

                const contextDir = resolved.dir;
                const contextNumber = resolved.number;
                const state = await readState(project_name, contextNumber, contextDir);
                const wf = await loadWorkflow(workflowsDir, state.workflow);
                const artifactIds = await listArtifacts(project_name, contextNumber, contextDir);
                const reviews = await readReviews(project_name, contextNumber, contextDir);
                const dispatches = await readDispatches(project_name, contextNumber, contextDir);
                const sessions = await readSessions(project_name, contextNumber, contextDir);
                const stepsData = await readSteps(project_name, contextNumber, contextDir);
                const issues = await readIssues(project_name);

                // Workflow tree view
                const treeLines = formatNodeTree(wf.definition.root, state.nodes, dispatches);

                // Floating nodes
                if (wf.definition.floatingNodes && wf.definition.floatingNodes.length > 0) {
                    treeLines.push('');
                    treeLines.push('Floating nodes:');
                    for (const fn of wf.definition.floatingNodes) {
                        const fnState = state.nodes[fn.id];
                        const fnStatus = fnState?.status ?? 'pending';
                        const fnIcon = statusIcon(fnStatus);
                        treeLines.push(`  ${fnIcon} ${fn.id} (task, ${fn.role}) \u2014 ${fnStatus}`);
                    }
                }

                // Artifacts
                const artifactDefs = wf.artifactDefinitions;
                const artifactsSection = formatArtifacts(artifactIds, artifactDefs, reviews, stepsData);
                const inProgressSection = formatInProgressArtifacts(artifactIds, artifactDefs, stepsData);

                // Pending reviews
                const pendingReviews = Object.values(reviews).filter((r) => r.status === 'pending');
                const pendingSection =
                    pendingReviews.length > 0
                        ? pendingReviews
                              .map((r) => `- ${r.artifactId} (submitted: ${r.submittedAt.split('T')[0]})`)
                              .join('\n')
                        : '(none)';

                // Sessions
                const activeSessions = sessions.filter((s) => s.status !== 'closed');
                const sessionsSection =
                    activeSessions.length > 0 ? activeSessions.map((s) => formatSession(s)).join('\n') : '(none)';

                // Dispatches
                const dispatchesSection =
                    dispatches.length > 0 ? dispatches.map((d) => formatDispatch(d, sessions)).join('\n') : '(none)';

                // Issues
                const openIssues = issues.filter((i) => i.status === 'open');
                const closedIssues = issues.filter((i) => i.status === 'closed');
                const issuesSummary =
                    issues.length > 0
                        ? [
                              `Total: ${issues.length} (${openIssues.length} open, ${closedIssues.length} closed)`,
                              ...openIssues.map((i) => {
                                  const resolvedBy = i.resolvedBy
                                      ? ` \u2192 ${i.resolvedBy.type}-${i.resolvedBy.number}`
                                      : '';
                                  return `  [OPEN] ${i.id}: ${i.title} (iter-${i.iteration}, ${i.source})${resolvedBy}`;
                              }),
                          ].join('\n')
                        : '(none)';

                // Engine nextAction
                let nextActionText = '';
                try {
                    const ctx: ResolvedContext = {
                        entry,
                        number: contextNumber,
                        dir: contextDir,
                        type: resolved.type as 'iteration' | 'patch',
                        activeContext: entry.activeContext!,
                    };
                    const engineResult = await processWorkflowEvent(workflowsDir, project_name, ctx, {
                        type: 'query_status',
                    });
                    nextActionText = formatNextAction(engineResult.nextAction);
                } catch {
                    nextActionText = '\n[Next Action] (could not compute \u2014 engine error)';
                }

                // Build response
                const output = [
                    `# Project Status: ${state.projectName}`,
                    ``,
                    `Source directory: ${state.projectDir}`,
                    `Workflow: ${state.workflow}`,
                    `Active context: ${entry.activeContext} (${resolved.type} #${contextNumber})`,
                    `Iterations: ${entry.currentIteration} / ${entry.totalIterations}`,
                    `Patches: ${entry.currentPatch} / ${entry.totalPatches}`,
                    `Active node: ${state.activeNodeId ?? '(none)'}`,
                    `Created: ${state.createdAt}`,
                    `Updated: ${state.updatedAt}`,
                    ``,
                    `## Workflow Tree`,
                    ...treeLines,
                    ``,
                    `## Sessions`,
                    sessionsSection,
                    ``,
                    `## Dispatches`,
                    dispatchesSection,
                    ``,
                    `## Issues`,
                    issuesSummary,
                    ``,
                    `## Pending Reviews`,
                    pendingSection,
                    ``,
                    `## Artifacts`,
                    artifactsSection,
                    ...(inProgressSection ? [``, `## In-Progress Artifacts`, inProgressSection] : []),
                    ``,
                    `## Next Action`,
                    nextActionText || '(none)',
                ];

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: output.join('\n'),
                        },
                    ],
                };
            } catch (err) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Failed to read project "${project_name}" status: ${err instanceof Error ? err.message : String(err)}`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    );
}
