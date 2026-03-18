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
import { listDocs } from '../core/docs.js';
import { readReviews } from '../core/reviews.js';
import { readDispatches, readSessions } from '../core/dispatch.js';
import { readSteps, getCompletedStepIds } from '../core/steps.js';
import { listProjects, getProject, resolveContextDir } from '../core/registry.js';
import { readIssues } from '../core/issues.js';
import { processWorkflowEvent, loadWorkflowForContext, formatNextAction } from './engine-helpers.js';
import { resolveActive, isError } from './utils.js';
import type {
    ArtifactDefinition,
    ArtifactStepState,
    DispatchRecord,
    NodeState,
    ReviewState,
    SessionRecord,
    WorkflowNode,
    WorkflowPlugin,
    WorkflowState,
} from '../core/types.js';

// ─── Node Tree Formatting ───

/** Status icon for node display */
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
        case 'pending':
        default:
            return '○';
    }
}

/** Get dispatch info for a specific node (brief inline summary) */
function getNodeDispatchInfo(nodeId: string, dispatches: DispatchRecord[]): string {
    const nodeDispatches = dispatches.filter((d) => d.nodeId === nodeId);
    if (nodeDispatches.length === 0) return '';
    const active = nodeDispatches.find((d) => d.status === 'running' || d.status === 'dispatched');
    if (active) return ` [${active.id}, ${active.status}]`;
    const latest = nodeDispatches[nodeDispatches.length - 1];
    return ` [${latest.id}, ${latest.status}]`;
}

/**
 * Format the workflow tree recursively for display.
 * Produces indented lines with status icons.
 */
function formatNodeTree(
    node: WorkflowNode,
    states: Record<string, NodeState>,
    dispatches: DispatchRecord[],
    indent: number = 0,
): string[] {
    const lines: string[] = [];
    const prefix = '  '.repeat(indent);
    const nodeState = states[node.id];
    const status = nodeState?.status ?? 'pending';
    const icon = statusIcon(status);
    const retryInfo = nodeState?.retryCount ? ` (retry ${nodeState.retryCount})` : '';

    switch (node.type) {
        case 'task': {
            const dispatchInfo = getNodeDispatchInfo(node.id, dispatches);
            lines.push(`${prefix}${icon} ${node.id} (task, ${node.role}) — ${status}${retryInfo}${dispatchInfo}`);
            break;
        }
        case 'sequence': {
            lines.push(`${prefix}${icon} ${node.id} (sequence) — ${status}`);
            for (const child of node.children) {
                lines.push(...formatNodeTree(child, states, dispatches, indent + 1));
            }
            break;
        }
        case 'parallel': {
            lines.push(`${prefix}${icon} ${node.id} (parallel, ${node.failStrategy}) — ${status}`);
            for (const child of node.children) {
                lines.push(...formatNodeTree(child, states, dispatches, indent + 1));
            }
            break;
        }
        case 'gate': {
            const condSummary = node.conditions
                .map((c) => {
                    if (c.type === 'artifact_exists') return `${c.artifact}?`;
                    if (c.type === 'artifact_approved') return `${c.artifact}✓?`;
                    return `${c.artifact}.${c.field}`;
                })
                .join(', ');
            lines.push(`${prefix}${icon} ${node.id} (gate: ${condSummary}) — ${status}`);
            // Show pass path
            lines.push(...formatNodeTree(node.pass, states, dispatches, indent + 1));
            // Show fail path if it's an inline node (not goto)
            if ('type' in node.fail) {
                lines.push(`${prefix}  ↳ fail:`);
                lines.push(...formatNodeTree(node.fail, states, dispatches, indent + 2));
            } else {
                // Goto target
                const maxR = node.fail.maxRetries != null ? `, max ${node.fail.maxRetries}` : '';
                const exhaust = node.fail.onExhausted ? ` → ${node.fail.onExhausted}` : '';
                lines.push(`${prefix}  ↳ fail: goto ${node.fail.goto}${maxR}${exhaust}`);
            }
            break;
        }
    }

    return lines;
}

// ─── Dispatch & Session Formatting ───

/** Format a dispatch record for display */
function formatDispatch(d: DispatchRecord, sessions: SessionRecord[]): string {
    const statusIcn =
        d.status === 'completed'
            ? '✓'
            : d.status === 'running'
              ? '→'
              : d.status === 'failed'
                ? '✗'
                : d.status === 'cancelled'
                  ? '—'
                  : '○';
    const session = sessions.find((s) => s.id === d.sessionId);
    const sessionInfo = session?.agentSessionId ? ` session:${session.agentSessionId}` : '';
    const note = d.note ? ` (${d.note})` : '';
    const nodeInfo = d.nodeId ? ` node:${d.nodeId}` : '';
    const brief = d.taskBrief.length > 60 ? d.taskBrief.slice(0, 57) + '...' : d.taskBrief;
    return `  ${statusIcn} ${d.id}  ${d.role.padEnd(12)} [${d.status}]  ${brief}${nodeInfo}${sessionInfo}${note}`;
}

/** Format a session record for display */
function formatSession(s: SessionRecord): string {
    const agentInfo = s.agentSessionId ? `agent:${s.agentSessionId}` : 'no agent ID';
    const label = s.label ? ` (${s.label})` : '';
    const agentType = s.agentType ? ` via ${s.agentType}` : '';
    return `  ${s.id}  ${s.role.padEnd(12)} [${s.status}]  ${agentInfo}${agentType}${label}`;
}

// ─── Step Progress Formatting ───

/**
 * Format step progress for a sequential artifact.
 * Returns lines like:
 *   Steps: [✓] 需求结构化 → [✓] 完整性校验 → [→] PRD 文档草稿 → [ ] PRD 最终版
 */
function formatStepProgress(
    artifactDef: ArtifactDefinition,
    stepState: ArtifactStepState | undefined,
): string {
    const steps = artifactDef.steps!;
    const completedIds = stepState ? getCompletedStepIds(stepState) : new Set<string>();
    const finalized = stepState?.finalized ?? false;

    if (finalized) {
        return `  Steps: all completed ✓ (finalized)`;
    }

    let firstIncomplete = steps.length;
    for (let i = 0; i < steps.length; i++) {
        if (!completedIds.has(steps[i].id)) {
            firstIncomplete = i;
            break;
        }
    }

    const parts = steps.map((s, i) => {
        if (completedIds.has(s.id)) return `[✓] ${s.name}`;
        if (i === firstIncomplete) return `[→] ${s.name}`;
        return `[ ] ${s.name}`;
    });

    return `  Steps: ${parts.join(' → ')}`;
}

// ─── Artifact Formatting ───

/** Format artifacts section — written artifacts + in-progress step artifacts */
function formatArtifacts(
    existingDocs: string[],
    artifactDefs: Record<string, ArtifactDefinition>,
    reviews: Record<string, ReviewState>,
    stepsData: Record<string, ArtifactStepState>,
): string {
    const lines: string[] = [];

    // Written artifacts
    if (existingDocs.length > 0) {
        for (const d of existingDocs) {
            const review = reviews[d];
            const reviewTag = review ? ` [${review.status}]` : '';
            const artifactDef = artifactDefs[d];
            const hasSteps = artifactDef?.steps?.length;
            let line = `- ${d}${reviewTag}`;
            if (hasSteps) {
                line += '\n' + formatStepProgress(artifactDef, stepsData[d]);
            }
            lines.push(line);
        }
    }

    // In-progress artifacts (steps started but not yet finalized/written)
    const inProgressIds = Object.keys(stepsData).filter((id) => !existingDocs.includes(id));
    for (const docId of inProgressIds) {
        const artifactDef = artifactDefs[docId];
        if (!artifactDef?.steps?.length) continue;
        const stepState = stepsData[docId];
        const completedCount = stepState?.completedSteps.length ?? 0;
        if (completedCount === 0) continue;
        lines.push(
            `- ${docId} (in progress, ${completedCount}/${artifactDef.steps.length} steps)\n` +
                formatStepProgress(artifactDef, stepState),
        );
    }

    return lines.length > 0 ? lines.join('\n') : '(none yet)';
}

// ─── Project List ───

/** Build project list summary (when project_name is not provided) */
async function buildProjectList(): Promise<string> {
    const projectNames = await listProjects();

    if (projectNames.length === 0) {
        return [
            '# Harmonia Projects',
            '',
            '(无已注册项目)',
            '',
            '使用 project_init(project_name, project_dir) 创建新项目。',
        ].join('\n');
    }

    const rows: string[] = [];
    for (const name of projectNames) {
        try {
            const entry = await getProject(name);
            if (!entry || !entry.activeContext) {
                rows.push(`| ${name} | ${entry?.dir ?? '?'} | (无活跃上下文) | - | - |`);
                continue;
            }
            const resolved = resolveContextDir(name, entry.activeContext);
            if (!resolved) {
                rows.push(`| ${name} | ${entry.dir} | (上下文异常) | - | - |`);
                continue;
            }
            const state = await readState(name, resolved.number, resolved.dir);
            const updated = state.updatedAt.split('T')[0];
            const contextDisplay = entry.activeContext;
            // Determine workflow progress from node states
            const nodeCount = Object.keys(state.nodes).length;
            const completedCount = Object.values(state.nodes).filter((n) => n.status === 'completed').length;
            rows.push(
                `| ${name} | ${state.projectDir} | ${state.workflow} | ${contextDisplay} (${completedCount}/${nodeCount}) | ${updated} |`,
            );
        } catch {
            rows.push(`| ${name} | (无法读取状态) | - | - | - |`);
        }
    }

    return [
        '# Harmonia Projects',
        '',
        `共 ${projectNames.length} 个项目:`,
        '',
        '| 项目 | 目录 | 工作流 | 上下文 (进度) | 更新时间 |',
        '|------|------|--------|---------------|----------|',
        ...rows,
        '',
        '使用 project_status(project_name) 查看项目详情。',
    ].join('\n');
}

// ─── Tool Registration ───

export function registerGetProjectStatus(server: McpServer, builtinDir: string, customDir: string): void {
    server.tool(
        'project_status',
        '查看项目状态。不传 project_name 则返回所有项目的摘要列表；传入 project_name 则返回该项目的详细状态（节点树、文档、dispatch、session、下一步建议）。',
        {
            project_name: z.string().optional().describe('项目名称。不传则返回所有项目的摘要列表。'),
        },
        async ({ project_name }) => {
            // List mode — no project_name
            if (!project_name) {
                const text = await buildProjectList();
                return { content: [{ type: 'text' as const, text }] };
            }

            // Detail mode — specific project
            try {
                // Resolve active context
                const ctx = await resolveActive(project_name);
                if (isError(ctx)) {
                    // Check if project exists but has no active context
                    const entry = await getProject(project_name);
                    if (entry && !entry.activeContext) {
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
                                        `项目已注册但尚未开始迭代或补丁。请调用 iteration_start(project_name="${project_name}") 开始第一次迭代，或 patch_start 开始补丁。`,
                                    ].join('\n'),
                                },
                            ],
                        };
                    }
                    return ctx;
                }

                const { wf, state } = await loadWorkflowForContext(builtinDir, customDir, project_name, ctx);
                const docs = await listDocs(project_name, ctx.number, ctx.dir);
                const reviews = await readReviews(project_name, ctx.number, ctx.dir);
                const dispatches = await readDispatches(project_name, ctx.number, ctx.dir);
                const sessions = await readSessions(project_name, ctx.number, ctx.dir);
                const stepsData = await readSteps(project_name, ctx.number, ctx.dir);
                const issues = await readIssues(project_name);

                // ── Workflow Tree ──
                const treeLines = formatNodeTree(wf.definition.root, state.nodes, dispatches);

                // Floating nodes (if any have been activated)
                const floatingLines: string[] = [];
                if (wf.definition.floatingNodes) {
                    for (const fn of wf.definition.floatingNodes) {
                        const fnState = state.nodes[fn.id];
                        if (fnState && fnState.status !== 'pending') {
                            floatingLines.push(
                                `  ${statusIcon(fnState.status)} ${fn.id} (floating, ${fn.role}) — ${fnState.status}`,
                            );
                        }
                    }
                }

                // ── Artifacts ──
                const artifactsSection = formatArtifacts(docs, wf.artifactDefinitions, reviews, stepsData);

                // ── Pending Reviews ──
                const pendingReviews = Object.values(reviews).filter((r) => r.status === 'pending');
                const pendingSection =
                    pendingReviews.length > 0
                        ? pendingReviews
                              .map((r) => `- ${r.artifactId} (submitted: ${r.submittedAt.split('T')[0]})`)
                              .join('\n')
                        : '(none)';

                // ── Sessions ──
                const activeSessions = sessions.filter((s) => s.status !== 'closed');
                const sessionsSection =
                    activeSessions.length > 0 ? activeSessions.map((s) => formatSession(s)).join('\n') : '(none)';

                // ── Dispatches ──
                const recentDispatches = dispatches.slice(-10); // Show last 10
                const dispatchesSection =
                    recentDispatches.length > 0
                        ? recentDispatches.map((d) => formatDispatch(d, sessions)).join('\n')
                        : '(none)';

                // ── Issues ──
                const openIssues = issues.filter((i) => i.status === 'open');
                const closedIssues = issues.filter((i) => i.status === 'closed');
                const issuesSummary =
                    issues.length > 0
                        ? [
                              `Total: ${issues.length} (${openIssues.length} open, ${closedIssues.length} closed)`,
                              ...openIssues.map((i) => {
                                  const resolvedBy = i.resolvedBy
                                      ? ` → ${i.resolvedBy.type}-${i.resolvedBy.number}`
                                      : '';
                                  return `  [OPEN] ${i.id}: ${i.title} (iter-${i.iteration}, ${i.source})${resolvedBy}`;
                              }),
                          ].join('\n')
                        : '(none)';

                // ── Engine Next Action ──
                const engineResult = await processWorkflowEvent(
                    builtinDir,
                    customDir,
                    project_name,
                    ctx,
                    { type: 'query_status' },
                );
                const nextActionText = formatNextAction(engineResult.nextAction);

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: [
                                `# Project Status: ${state.projectName}`,
                                ``,
                                `Source directory: ${state.projectDir}`,
                                `Workflow: ${state.workflow}`,
                                `Active context: ${ctx.activeContext} (${ctx.type} #${ctx.number})`,
                                `Iterations: ${ctx.entry.currentIteration} / ${ctx.entry.totalIterations}`,
                                `Patches: ${ctx.entry.currentPatch} / ${ctx.entry.totalPatches}`,
                                `Created: ${state.createdAt}`,
                                `Updated: ${state.updatedAt}`,
                                ``,
                                `## Workflow Tree`,
                                ...treeLines,
                                ...(floatingLines.length > 0 ? ['', '### Floating Nodes', ...floatingLines] : []),
                                ``,
                                `## Sessions`,
                                sessionsSection,
                                ``,
                                `## Dispatches`,
                                dispatchesSection,
                                dispatches.length > 10 ? `  (showing last 10 of ${dispatches.length})` : '',
                                ``,
                                `## Issues`,
                                issuesSummary,
                                ``,
                                `## Pending Reviews`,
                                pendingSection,
                                ``,
                                `## Artifacts`,
                                artifactsSection,
                                ``,
                                `## Next Action`,
                                nextActionText || '(no action needed)',
                            ]
                                .filter((line) => line !== undefined)
                                .join('\n'),
                        },
                    ],
                };
            } catch (err) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `项目 "${project_name}" 状态读取失败: ${err instanceof Error ? err.message : String(err)}`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    );
}
