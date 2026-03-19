/**
 * MCP Tool: artifact_approve / review_list
 * Approve or reject an artifact that is pending review.
 *
 * After approval, triggers engine event `artifact_approved` to evaluate gates.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveReview, getPendingReviews } from '../core/reviews.js';
import { resolveActive, isError } from './utils.js';
import { processWorkflowEvent, formatNextAction } from './engine-helpers.js';

export function registerApproveArtifact(server: McpServer, workflowsDir: string): void {
    server.tool(
        'artifact_approve',
        'Approve or reject an artifact pending review. Call this after the user has reviewed the artifact and confirmed (or requested changes).',
        {
            project_name: z.string().describe('Project name'),
            artifact_id: z.string().describe('Artifact ID to approve/reject'),
            approved: z.boolean().describe('true = approved, false = rejected (needs revision)'),
            comment: z.string().optional().describe('Optional comment — user feedback or reason for rejection'),
        },
        async ({ project_name, artifact_id, approved, comment }) => {
            try {
                const ctx = await resolveActive(project_name);
                if (isError(ctx)) return ctx;

                const status = approved ? 'approved' : 'rejected';
                await resolveReview(project_name, ctx.number, artifact_id, status, comment, ctx.dir);

                if (approved) {
                    // Trigger engine event: artifact_approved
                    const engineResult = await processWorkflowEvent(workflowsDir, project_name, ctx, {
                        type: 'artifact_approved',
                        artifactId: artifact_id,
                    });

                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Artifact "${artifact_id}" approved.` + formatNextAction(engineResult.nextAction),
                            },
                        ],
                    };
                } else {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: [
                                    `Artifact "${artifact_id}" rejected.`,
                                    comment ? `User feedback: ${comment}` : '',
                                    `Please revise the artifact based on the feedback and call artifact_write again.`,
                                ].join('\n'),
                            },
                        ],
                    };
                }
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

    server.tool(
        'review_list',
        'List all artifacts currently pending user review.',
        {
            project_name: z.string().describe('Project name'),
        },
        async ({ project_name }) => {
            const ctx = await resolveActive(project_name);
            if (isError(ctx)) return ctx;

            const pending = await getPendingReviews(project_name, ctx.number, ctx.dir);

            if (pending.length === 0) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: 'No artifacts pending review.',
                        },
                    ],
                };
            }

            const list = pending.map((r) => `- ${r.artifactId} (submitted: ${r.submittedAt})`).join('\n');

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Artifacts pending review:\n${list}`,
                    },
                ],
            };
        },
    );
}
