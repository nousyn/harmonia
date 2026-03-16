/**
 * MCP Tool: phase_update
 * Advance or update the status of a project phase.
 *
 * Guards (when completing a phase with force!=true):
 * - Prior phases must all be completed
 * - Required doc outputs must exist
 * - Docs requiring review must be approved
 * - No active (dispatched/running) dispatches in the phase
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readState, updatePhaseStatus } from '../core/state.js';
import { loadWorkflow } from '../core/workflow.js';
import { listDocs } from '../core/docs.js';
import { readReviews } from '../core/reviews.js';
import { readDispatches } from '../core/dispatch.js';
import { getMergedOverrides, resolveDocReview } from '../core/overrides.js';

export function registerUpdatePhase(server: McpServer, builtinDir: string, customDir: string): void {
    server.tool(
        'phase_update',
        'Update the status of a project phase. When a phase is completed, the next phase is automatically started. Completing a phase checks that all required doc outputs exist.',
        {
            project_name: z.string().describe('Project name'),
            phase_id: z.string().describe('Phase ID to update (e.g. clarify, design, develop, test, deliver)'),
            status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).describe('New status for the phase'),
            blocked_reason: z.string().optional().describe("Reason for blocking (required when status is 'blocked')"),
            force: z.boolean().optional().describe('Force completion even if outputs are missing (default: false)'),
        },
        async ({ project_name, phase_id, status, blocked_reason, force }) => {
            try {
                // ── Completion guards ──
                if (status === 'completed' && !force) {
                    const currentState = await readState(project_name);
                    const wf = await loadWorkflow(builtinDir, customDir, currentState.workflow);
                    const existingDocs = await listDocs(project_name);

                    const phaseDef = wf.definition.phases.find((p) => p.id === phase_id);
                    const phaseIndex = wf.definition.phases.findIndex((p) => p.id === phase_id);
                    const guardErrors: string[] = [];

                    // Guard 0: Scale must be set before completing any phase
                    if (currentState.scale === null) {
                        guardErrors.push('Scale 尚未设定。请先调用 project_set_scale 设定项目规模。');
                    }

                    // Guard 1: Prior phases must all be completed
                    if (phaseIndex > 0) {
                        const priorPhases = wf.definition.phases.slice(0, phaseIndex);
                        const incompletePriors = priorPhases.filter((pp) => {
                            const ps = currentState.phases.find((s) => s.id === pp.id);
                            return !ps || ps.status !== 'completed';
                        });
                        if (incompletePriors.length > 0) {
                            guardErrors.push(`前序阶段未完成: ${incompletePriors.map((p) => p.id).join(', ')}`);
                        }
                    }

                    // Guard 2 & 3 require scale to be set
                    if (currentState.scale !== null && phaseDef) {
                        const scale = currentState.scale;

                        // Guard 2: Required doc outputs must exist
                        const missingDocOutputs = phaseDef.outputs.filter((o) => {
                            const docDef = wf.definition.docs[o];
                            if (!docDef) return false;
                            if (docDef.external) return false;
                            const scaleVal = docDef.scale[scale];
                            if (scaleVal === 'skip' || scaleVal === 'optional') return false;
                            return !existingDocs.includes(o);
                        });

                        if (missingDocOutputs.length > 0) {
                            guardErrors.push(`缺少必需文档产出: ${missingDocOutputs.join(', ')}`);
                        }

                        // Guard 3: Docs requiring review must be approved
                        const overrides = await getMergedOverrides(project_name);
                        const reviews = await readReviews(project_name);

                        const unapprovedDocs = phaseDef.outputs.filter((o) => {
                            const docDef = wf.definition.docs[o];
                            if (!docDef) return false;
                            if (docDef.external) return false;
                            const scaleVal = docDef.scale[scale];
                            if (scaleVal === 'skip' || scaleVal === 'optional') return false;
                            const needsReview = resolveDocReview(o, docDef, overrides);
                            if (!needsReview) return false;
                            const reviewState = reviews[o];
                            return !reviewState || reviewState.status !== 'approved';
                        });

                        if (unapprovedDocs.length > 0) {
                            guardErrors.push(`文档待审核或未通过: ${unapprovedDocs.join(', ')}`);
                        }
                    }

                    // Guard 4: No active dispatches
                    const dispatches = await readDispatches(project_name);
                    const activeDispatches = dispatches.filter(
                        (d) => d.status === 'dispatched' || d.status === 'running',
                    );
                    if (activeDispatches.length > 0) {
                        const activeList = activeDispatches.map((d) => `${d.id} (${d.role}, ${d.status})`).join(', ');
                        guardErrors.push(`存在进行中的 dispatch: ${activeList}`);
                    }

                    if (guardErrors.length > 0) {
                        return {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: [
                                        `无法完成阶段 "${phase_id}"：`,
                                        '',
                                        ...guardErrors.map((e) => `- ${e}`),
                                        '',
                                        '请先解决以上问题，或使用 force=true 强制完成。',
                                    ].join('\n'),
                                },
                            ],
                            isError: true,
                        };
                    }
                }

                const state = await updatePhaseStatus(project_name, phase_id, status, blocked_reason);

                const phasesSummary = state.phases
                    .map((p) => {
                        const marker = p.id === state.currentPhase ? ' <-- current' : '';
                        return `  ${p.id}: ${p.status}${p.blockedReason ? ` (${p.blockedReason})` : ''}${marker}`;
                    })
                    .join('\n');

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Phase "${phase_id}" updated to "${status}".\n\nProject phases:\n${phasesSummary}`,
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
