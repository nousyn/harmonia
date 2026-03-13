/**
 * MCP Tool: approve_doc
 * Approve or reject a document that is pending review.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveReview, getPendingReviews } from '../core/reviews.js';

export function registerApproveDoc(server: McpServer): void {
    server.tool(
        'approve_doc',
        'Approve or reject a document pending review. Call this after the user has reviewed the document and confirmed (or requested changes).',
        {
            project_name: z.string().describe('Project name'),
            doc_id: z.string().describe('Document ID to approve/reject'),
            approved: z.boolean().describe('true = approved, false = rejected (needs revision)'),
            comment: z.string().optional().describe('Optional comment — user feedback or reason for rejection'),
        },
        async ({ project_name, doc_id, approved, comment }) => {
            try {
                const status = approved ? 'approved' : 'rejected';
                const review = await resolveReview(project_name, doc_id, status, comment);

                if (approved) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Document "${doc_id}" approved. You may proceed with the workflow.`,
                            },
                        ],
                    };
                } else {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: [
                                    `Document "${doc_id}" rejected.`,
                                    comment ? `User feedback: ${comment}` : '',
                                    `Please revise the document based on the feedback and call write_doc again.`,
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
        'list_pending_reviews',
        'List all documents currently pending user review.',
        {
            project_name: z.string().describe('Project name'),
        },
        async ({ project_name }) => {
            const pending = await getPendingReviews(project_name);

            if (pending.length === 0) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: 'No documents pending review.',
                        },
                    ],
                };
            }

            const list = pending.map((r) => `- ${r.docId} (submitted: ${r.submittedAt})`).join('\n');

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Documents pending review:\n${list}`,
                    },
                ],
            };
        },
    );
}
