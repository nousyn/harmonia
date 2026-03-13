/**
 * MCP Tool: get_project_status
 * Read the current project status with rich context for PM decision-making.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readState } from '../core/state.js';
import { loadWorkflow } from '../core/workflow.js';
import { listDocs } from '../core/docs.js';
import { readReviews } from '../core/reviews.js';
import { getMergedOverrides, resolveDocReview } from '../core/overrides.js';
import type { DocReviewState, LoadedWorkflow, PhaseDefinition, PhaseState, ProjectState } from '../core/types.js';

/**
 * Derive next-step suggestions based on current project state.
 */
function deriveNextSteps(
    state: ProjectState,
    wf: LoadedWorkflow,
    existingDocs: string[],
    pendingReviews: DocReviewState[],
): string[] {
    const suggestions: string[] = [];
    const currentPhaseDef = wf.definition.phases.find((p) => p.id === state.currentPhase);

    if (!currentPhaseDef) return ['Unknown phase — check project state.'];

    // If there are pending reviews, those block progress
    if (pendingReviews.length > 0) {
        const docNames = pendingReviews.map((r) => r.docId).join(', ');
        suggestions.push(
            `Review pending documents: ${docNames}. Present them to the user and call approve_doc after user feedback.`,
        );
    }

    // Check which phase outputs are still missing
    const missingOutputs = currentPhaseDef.outputs.filter((o) => !existingDocs.includes(o));

    if (missingOutputs.length > 0) {
        const currentPhaseState = state.phases.find((p) => p.id === state.currentPhase);

        // If current phase has specific roles (not PM), suggest dispatching
        const nonPmRoles = currentPhaseDef.roles.filter((r) => r !== 'pm');
        if (nonPmRoles.length > 0) {
            suggestions.push(
                `Dispatch ${nonPmRoles.join(', ')} to produce: ${missingOutputs.join(', ')}. Use dispatch_role to prepare task data.`,
            );
        } else {
            suggestions.push(`Produce remaining documents: ${missingOutputs.join(', ')}. Use write_doc for each.`);
        }
    } else if (pendingReviews.length === 0) {
        // All outputs exist, no pending reviews — can advance
        suggestions.push(
            `All outputs for "${currentPhaseDef.name}" are complete. Advance with: update_phase(project_name, "${state.currentPhase}", "completed")`,
        );
    }

    // If no suggestions yet, provide a generic one
    if (suggestions.length === 0) {
        suggestions.push(`Continue working on the "${currentPhaseDef.name}" phase.`);
    }

    return suggestions;
}

export function registerGetProjectStatus(server: McpServer, workflowsDir: string): void {
    server.tool(
        'get_project_status',
        'Get the current project status including phase progress, documents, pending reviews, and next-step suggestions.',
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
                const approvedDocs = Object.values(reviews)
                    .filter((r) => r.status === 'approved')
                    .map((r) => r.docId);
                const rejectedDocs = Object.values(reviews)
                    .filter((r) => r.status === 'rejected')
                    .map((r) => r.docId);

                // Docs that don't have review state (either no review required or not yet submitted)
                const docsWithoutReview = docs.filter((d) => !reviews[d]);

                // Build pending reviews section
                const pendingSection =
                    pendingReviews.length > 0
                        ? pendingReviews
                              .map((r) => `- ${r.docId} (submitted: ${r.submittedAt.split('T')[0]})`)
                              .join('\n')
                        : '(none)';

                // Build documents section with status
                const docsSection =
                    docs.length > 0
                        ? docs
                              .map((d) => {
                                  const review = reviews[d];
                                  if (!review) return `- ${d}`;
                                  return `- ${d} [${review.status}]`;
                              })
                              .join('\n')
                        : '(none yet)';

                // Derive next steps
                const nextSteps = deriveNextSteps(state, wf, docs, pendingReviews);

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
                                    ? `Expected outputs: ${currentPhaseDef.outputs.join(', ')}`
                                    : '',
                                ``,
                                `## Pending Reviews`,
                                pendingSection,
                                ``,
                                `## Documents`,
                                docsSection,
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
