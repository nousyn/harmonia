/**
 * MCP Tool: project_status
 * Read the current project status with rich context for PM decision-making.
 * Includes phase progress, documents, pending reviews, dispatch records,
 * active sessions, and intelligent next-step suggestions.
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
): string[] {
    const suggestions: string[] = [];
    const currentPhaseDef = wf.definition.phases.find((p) => p.id === state.currentPhase);

    if (!currentPhaseDef) return ['Unknown phase — check project state.'];

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

    // Check which phase outputs are still missing
    // Skip external outputs (e.g. "code"), docs that are "skip", and "optional" docs at the current scale
    const missingOutputs = currentPhaseDef.outputs.filter((o) => {
        const docDef = wf.definition.docs[o];
        if (docDef?.external) return false;
        const scaleVal = docDef?.scale[state.scale];
        if (scaleVal === 'skip' || scaleVal === 'optional') return false;
        return !existingDocs.includes(o);
    });

    if (missingOutputs.length > 0) {
        // Only suggest dispatching if there are no active dispatches already covering this
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
        // All outputs exist, no pending reviews, no active dispatches — can advance
        suggestions.push(
            `All outputs for "${currentPhaseDef.name}" are complete. Advance with: phase_update(project_name, "${state.currentPhase}", "completed")`,
        );
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

    // If no suggestions yet, provide a generic one
    if (suggestions.length === 0) {
        suggestions.push(`Continue working on the "${currentPhaseDef.name}" phase.`);
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

    // Find the first incomplete step
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

export function registerGetProjectStatus(server: McpServer, workflowsDir: string): void {
    server.tool(
        'project_status',
        'Get the current project status including phase progress, documents, pending reviews, dispatch records, active sessions, and next-step suggestions.',
        {
            project_name: z.string().describe('Project name'),
        },
        async ({ project_name }) => {
            try {
                const state = await readState(project_name);
                const wf = await loadWorkflow(workflowsDir, state.workflow);
                const docs = await listDocs(project_name);
                const reviews = await readReviews(project_name);
                const overrides = await getMergedOverrides(project_name);
                const dispatches = await readDispatches(project_name);
                const sessions = await readSessions(project_name);
                const stepsData = await readSteps(project_name);

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
                                  const hasSteps = docDef?.steps?.length && SEQUENTIAL_SCALES.has(state.scale);
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

                // Derive next steps (now dispatch-aware)
                const nextSteps = deriveNextSteps(state, wf, docs, pendingReviews, dispatches, sessions);

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: [
                                `# Project Status: ${state.projectName}`,
                                ``,
                                `Source directory: ${state.projectDir}`,
                                `Workflow: ${state.workflow}`,
                                `Scale: ${state.scale}`,
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
                                currentPhaseDef?.outputs
                                    ? `Expected outputs: ${currentPhaseDef.outputs
                                          .filter((o) => {
                                              const d = wf.definition.docs[o];
                                              if (!d) return true;
                                              const sv = d.scale[state.scale];
                                              return sv !== 'skip' && sv !== 'optional';
                                          })
                                          .join(', ')}`
                                    : '',
                                ``,
                                `## Sessions`,
                                sessionsSection,
                                ``,
                                `## Dispatches`,
                                dispatchesSection,
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
            } catch {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: 'Project not initialized. Use project_init to get started.',
                        },
                    ],
                    isError: true,
                };
            }
        },
    );
}
