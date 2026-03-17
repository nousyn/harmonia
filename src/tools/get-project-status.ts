/**
 * MCP Tool: project_status
 * Read the current project status with rich context for PM decision-making.
 * Includes phase progress, documents, pending reviews, dispatch records,
 * active sessions, and intelligent next-step suggestions.
 *
 * When called without project_name, returns a summary list of all projects.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readState } from '../core/state.js';
import { loadWorkflow } from '../core/workflow.js';
import { listDocs } from '../core/docs.js';
import { readReviews } from '../core/reviews.js';
import { getMergedOverrides } from '../core/overrides.js';
import { readDispatches, readSessions } from '../core/dispatch.js';
import { readSteps, getCompletedStepIds } from '../core/steps.js';
import { listProjects, getProject, resolveContextDir } from '../core/registry.js';
import { readIssues } from '../core/issues.js';
import type {
    DispatchRecord,
    DocDefinition,
    DocReviewState,
    DocStepState,
    LoadedWorkflow,
    PhaseDefinition,
    ProjectScale,
    ProjectState,
    SessionRecord,
} from '../core/types.js';

/**
 * Derive next-step suggestions based on current project state, including dispatch awareness.
 */
function deriveNextSteps(
    state: ProjectState,
    wf: LoadedWorkflow,
    existingDocs: string[],
    pendingReviews: DocReviewState[],
    dispatches: DispatchRecord[],
    sessions: SessionRecord[],
    openIssueCount: number,
): string[] {
    const suggestions: string[] = [];
    const currentPhaseDef = wf.definition.phases.find((p) => p.id === state.currentPhase);

    if (!currentPhaseDef) return ['Unknown phase — check project state.'];

    // If scale is not set, that's the most important next step
    if (state.scale === null) {
        // Check if PRD exists and is approved
        const hasPrdApproved = pendingReviews.length === 0; // simplified check
        suggestions.push(`项目规模 (scale) 尚未设定。请先完成 PRD 编写和审批，然后调用 project_set_scale 设定规模。`);
    }

    // If there are pending reviews, those block progress
    if (pendingReviews.length > 0) {
        const docNames = pendingReviews.map((r) => r.docId).join(', ');
        suggestions.push(
            `Review pending documents: ${docNames}. Present them to the user and call doc_approve after user feedback.`,
        );
    }

    // Check dispatch states — find dispatches that need attention
    const activeDispatches = dispatches.filter((d) => d.status === 'dispatched' || d.status === 'running');
    const dispatchedNotRunning = dispatches.filter((d) => d.status === 'dispatched');
    const runningDispatches = dispatches.filter((d) => d.status === 'running');
    const failedDispatches = dispatches.filter((d) => d.status === 'failed');

    if (dispatchedNotRunning.length > 0) {
        for (const d of dispatchedNotRunning) {
            suggestions.push(
                `Dispatch ${d.id} (${d.role}) is created but not yet launched. Launch the agent and call dispatch_report to register it.`,
            );
        }
    }

    if (runningDispatches.length > 0) {
        for (const d of runningDispatches) {
            const session = sessions.find((s) => s.id === d.sessionId);
            const agentInfo = session?.agentSessionId ? ` (agent session: ${session.agentSessionId})` : '';
            suggestions.push(
                `Dispatch ${d.id} (${d.role}) is running${agentInfo}. Check if the agent has finished, then call dispatch_report with status="completed" or "failed".`,
            );
        }
    }

    if (failedDispatches.length > 0) {
        for (const d of failedDispatches) {
            const reason = d.note ? ` Reason: ${d.note}` : '';
            suggestions.push(
                `Dispatch ${d.id} (${d.role}) failed.${reason} Consider re-dispatching with role_dispatch.`,
            );
        }
    }

    // Check which phase outputs are still missing (only when scale is set)
    if (state.scale !== null) {
        const scale = state.scale;
        const missingOutputs = currentPhaseDef.outputs.filter((o) => {
            const docDef = wf.definition.docs[o];
            if (docDef?.external) return false;
            const scaleVal = docDef?.scale[scale];
            if (scaleVal === 'skip' || scaleVal === 'optional') return false;
            return !existingDocs.includes(o);
        });

        if (missingOutputs.length > 0) {
            const alreadyDispatched = activeDispatches.length > 0;
            const nonPmRoles = currentPhaseDef.roles.filter((r) => r !== 'pm');

            if (nonPmRoles.length > 0 && !alreadyDispatched) {
                suggestions.push(
                    `Dispatch ${nonPmRoles.join(', ')} to produce: ${missingOutputs.join(', ')}. Use role_dispatch to prepare task data.`,
                );
            } else if (nonPmRoles.length === 0) {
                suggestions.push(`Produce remaining documents: ${missingOutputs.join(', ')}. Use doc_write for each.`);
            }
        } else if (pendingReviews.length === 0 && activeDispatches.length === 0) {
            suggestions.push(
                `All outputs for "${currentPhaseDef.name}" are complete. Advance with: phase_update(project_name, "${state.currentPhase}", "completed")`,
            );
        }
    }

    // Check for lost sessions
    const lostSessions = sessions.filter((s) => s.status === 'lost');
    if (lostSessions.length > 0) {
        for (const s of lostSessions) {
            suggestions.push(
                `Session ${s.id} (${s.role}) is marked as lost. The agent may have crashed. Consider re-dispatching this role.`,
            );
        }
    }

    if (suggestions.length === 0) {
        // Check if ALL phases are completed → recommend iteration_start for next iteration
        const allPhasesCompleted = state.phases.every((p) => p.status === 'completed' || p.status === 'skipped');
        if (allPhasesCompleted) {
            suggestions.push(
                `本次${state.type === 'patch' ? '补丁' : '迭代'}所有阶段已完成。如需开始新一轮迭代，请调用 iteration_start(project_name="${state.projectName}")。`,
            );
        } else {
            suggestions.push(`Continue working on the "${currentPhaseDef.name}" phase.`);
        }
    }

    // Always mention open issues if there are any
    if (openIssueCount > 0) {
        suggestions.push(
            `有 ${openIssueCount} 个未关闭的 issue。可调用 patch_start 开始补丁修复，或 issue_list 查看详情。`,
        );
    }

    return suggestions;
}

/**
 * Format a dispatch record for display.
 */
function formatDispatch(d: DispatchRecord, sessions: SessionRecord[]): string {
    const statusIcon =
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
    const brief = d.taskBrief.length > 60 ? d.taskBrief.slice(0, 57) + '...' : d.taskBrief;
    return `  ${statusIcon} ${d.id}  ${d.role.padEnd(12)} [${d.status}]  ${brief}${sessionInfo}${note}`;
}

/**
 * Format a session record for display.
 */
function formatSession(s: SessionRecord): string {
    const agentInfo = s.agentSessionId ? `agent:${s.agentSessionId}` : 'no agent ID';
    const label = s.label ? ` (${s.label})` : '';
    const agentType = s.agentType ? ` via ${s.agentType}` : '';
    return `  ${s.id}  ${s.role.padEnd(12)} [${s.status}]  ${agentInfo}${agentType}${label}`;
}

/** Scales that activate sequential mode */
const SEQUENTIAL_SCALES: Set<ProjectScale> = new Set(['medium', 'large']);

/**
 * Format step progress for a sequential document.
 * Returns lines like:
 *   Steps: [✓] 需求结构化 → [✓] 完整性校验 → [→] PRD 文档草稿 → [ ] PRD 最终版
 */
function formatStepProgress(docDef: DocDefinition, stepState: DocStepState | undefined): string {
    const steps = docDef.steps!;
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

/**
 * Build the project list summary (when project_name is not provided).
 */
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
                rows.push(`| ${name} | ${entry?.dir ?? '?'} | (无活跃上下文) | - | - | - |`);
                continue;
            }
            const resolved = resolveContextDir(name, entry.activeContext);
            if (!resolved) {
                rows.push(`| ${name} | ${entry.dir} | (上下文异常) | - | - | - |`);
                continue;
            }
            const state = await readState(name, resolved.number, resolved.dir);
            const scaleDisplay = state.scale ?? '(未设定)';
            const updated = state.updatedAt.split('T')[0];
            const contextDisplay = entry.activeContext;
            rows.push(
                `| ${name} | ${state.projectDir} | ${state.currentPhase} | ${scaleDisplay} | ${contextDisplay} | ${updated} |`,
            );
        } catch {
            rows.push(`| ${name} | (无法读取状态) | - | - | - | - |`);
        }
    }

    return [
        '# Harmonia Projects',
        '',
        `共 ${projectNames.length} 个项目:`,
        '',
        '| 项目 | 目录 | 阶段 | 规模 | 上下文 | 更新时间 |',
        '|------|------|------|------|--------|----------|',
        ...rows,
        '',
        '使用 project_status(project_name) 查看项目详情。',
    ].join('\n');
}

export function registerGetProjectStatus(server: McpServer, builtinDir: string, customDir: string): void {
    server.tool(
        'project_status',
        '查看项目状态。不传 project_name 则返回所有项目的摘要列表；传入 project_name 则返回该项目的详细状态（阶段、文档、dispatch、session、下一步建议）。',
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
                // Resolve project entry
                const entry = await getProject(project_name);
                if (!entry) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `项目 "${project_name}" 未注册。使用 project_status() 查看所有项目，或 project_init 创建新项目。`,
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
                                    `项目已注册但尚未开始迭代或补丁。请调用 iteration_start(project_name="${project_name}") 开始第一次迭代，或 patch_start 开始补丁。`,
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
                                text: `项目 "${project_name}" 的 activeContext "${entry.activeContext}" 无法解析。数据可能已损坏。`,
                            },
                        ],
                        isError: true,
                    };
                }

                const contextDir = resolved.dir;
                const contextNumber = resolved.number;
                const state = await readState(project_name, contextNumber, contextDir);
                const wf = await loadWorkflow(builtinDir, customDir, state.workflow);
                const docs = await listDocs(project_name, contextNumber, contextDir);
                const reviews = await readReviews(project_name, contextNumber, contextDir);
                const overrides = await getMergedOverrides(project_name);
                const dispatches = await readDispatches(project_name, contextNumber, contextDir);
                const sessions = await readSessions(project_name, contextNumber, contextDir);
                const stepsData = await readSteps(project_name, contextNumber, contextDir);
                const issues = await readIssues(project_name);

                const scaleDisplay = state.scale ?? '(未设定)';

                // Phase summary
                const phasesSummary = state.phases
                    .map((p) => {
                        const def = wf.definition.phases.find((pd) => pd.id === p.id);
                        const marker = p.id === state.currentPhase ? ' <-- current' : '';
                        const name = def ? ` (${def.name})` : '';
                        return `  ${p.id}${name}: ${p.status}${p.blockedReason ? ` [blocked: ${p.blockedReason}]` : ''}${marker}`;
                    })
                    .join('\n');

                const currentPhaseDef = wf.definition.phases.find((p) => p.id === state.currentPhase);

                // Categorize documents
                const pendingReviews = Object.values(reviews).filter((r) => r.status === 'pending');

                // Build pending reviews section
                const pendingSection =
                    pendingReviews.length > 0
                        ? pendingReviews
                              .map((r) => `- ${r.docId} (submitted: ${r.submittedAt.split('T')[0]})`)
                              .join('\n')
                        : '(none)';

                // Build documents section with status and step progress
                const docsSection =
                    docs.length > 0
                        ? docs
                              .map((d) => {
                                  const review = reviews[d];
                                  const reviewTag = review ? ` [${review.status}]` : '';
                                  const docDef = wf.definition.docs[d];
                                  const hasSteps =
                                      docDef?.steps?.length &&
                                      state.scale !== null &&
                                      SEQUENTIAL_SCALES.has(state.scale);
                                  let line = `- ${d}${reviewTag}`;
                                  if (hasSteps) {
                                      line += '\n' + formatStepProgress(docDef, stepsData[d]);
                                  }
                                  return line;
                              })
                              .join('\n')
                        : '(none yet)';

                // Show step progress for docs not yet written but with active steps
                const inProgressStepDocs = Object.keys(stepsData).filter((docId) => !docs.includes(docId));
                const inProgressSection = inProgressStepDocs
                    .map((docId) => {
                        const docDef = wf.definition.docs[docId];
                        if (!docDef?.steps?.length) return null;
                        const stepState = stepsData[docId];
                        const completedCount = stepState?.completedSteps.length ?? 0;
                        if (completedCount === 0) return null;
                        return (
                            `- ${docId} (in progress, ${completedCount}/${docDef.steps.length} steps)\n` +
                            formatStepProgress(docDef, stepState)
                        );
                    })
                    .filter(Boolean)
                    .join('\n');

                // Build sessions section
                const activeSessions = sessions.filter((s) => s.status !== 'closed');
                const sessionsSection =
                    activeSessions.length > 0 ? activeSessions.map((s) => formatSession(s)).join('\n') : '(none)';

                // Build dispatches section
                const dispatchesSection =
                    dispatches.length > 0 ? dispatches.map((d) => formatDispatch(d, sessions)).join('\n') : '(none)';

                // Build issues section
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

                // Expected outputs — only when scale is set
                let expectedOutputsLine = '';
                if (currentPhaseDef?.outputs && state.scale !== null) {
                    const scale = state.scale;
                    const filtered = currentPhaseDef.outputs.filter((o) => {
                        const d = wf.definition.docs[o];
                        if (!d) return true;
                        const sv = d.scale[scale];
                        return sv !== 'skip' && sv !== 'optional';
                    });
                    expectedOutputsLine = `Expected outputs: ${filtered.join(', ')}`;
                } else if (currentPhaseDef?.outputs) {
                    expectedOutputsLine = `Expected outputs: (需先设定 scale 才能确定)`;
                }

                // Derive next steps (now dispatch-aware)
                const nextSteps = deriveNextSteps(
                    state,
                    wf,
                    docs,
                    pendingReviews,
                    dispatches,
                    sessions,
                    openIssues.length,
                );

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: [
                                `# Project Status: ${state.projectName}`,
                                ``,
                                `Source directory: ${state.projectDir}`,
                                `Workflow: ${state.workflow}`,
                                `Scale: ${scaleDisplay}`,
                                `Active context: ${entry.activeContext} (${resolved.type} #${contextNumber})`,
                                `Iterations: ${entry.currentIteration} / ${entry.totalIterations}`,
                                `Patches: ${entry.currentPatch} / ${entry.totalPatches}`,
                                `Created: ${state.createdAt}`,
                                `Updated: ${state.updatedAt}`,
                                ``,
                                `## Phases`,
                                phasesSummary,
                                ``,
                                `## Current Phase`,
                                currentPhaseDef
                                    ? `${currentPhaseDef.name} (${currentPhaseDef.id}): ${currentPhaseDef.description}`
                                    : 'Unknown',
                                currentPhaseDef?.roles ? `Roles: ${currentPhaseDef.roles.join(', ')}` : '',
                                expectedOutputsLine,
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
                                `## Documents`,
                                docsSection,
                                ...(inProgressSection ? [``, `## In-Progress Steps`, inProgressSection] : []),
                                ``,
                                `## Next Steps`,
                                nextSteps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
                            ].join('\n'),
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
