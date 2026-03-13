/**
 * MCP Tools: write_doc / read_doc / list_docs
 * Read and write project documents under <data_dir>/<project_name>/docs/
 *
 * write_doc checks review configuration and auto-submits for review if needed.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { writeDoc, readDoc, listDocs } from '../core/docs.js';
import { readState } from '../core/state.js';
import { loadWorkflow } from '../core/workflow.js';
import { getMergedOverrides, resolveDocReview } from '../core/overrides.js';
import { submitForReview } from '../core/reviews.js';

export function registerDocTools(server: McpServer, workflowsDir: string): void {
    server.tool(
        'write_doc',
        'Write or update a project document. Automatically checks review configuration — if review is required, the document is submitted for user approval and you MUST present it to the user for confirmation before proceeding.',
        {
            project_name: z.string().describe('Project name'),
            doc_id: z
                .string()
                .describe('Document ID (e.g. prd, user-stories, fsd, prototype, tech-design, task-breakdown, etc.)'),
            content: z.string().describe('Document content (markdown or HTML depending on doc type)'),
        },
        async ({ project_name, doc_id, content }) => {
            // Load workflow to get doc definition (format, review defaults)
            const state = await readState(project_name);
            const wf = await loadWorkflow(workflowsDir, state.workflow);
            const docDef = wf.definition.docs[doc_id];

            // Write the document with correct extension
            const filePath = await writeDoc(project_name, doc_id, content, docDef);

            // Check if review is required
            const overrides = await getMergedOverrides(project_name);
            const needsReview = docDef ? resolveDocReview(doc_id, docDef, overrides) : false;

            if (needsReview) {
                await submitForReview(project_name, doc_id);
                const docName = docDef?.name ?? doc_id;
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: [
                                `Document "${doc_id}" (${docName}) written to ${filePath}`,
                                ``,
                                `** REVIEW REQUIRED **`,
                                `This document requires user approval before the workflow can proceed.`,
                                `Please present the document content to the user and ask for their confirmation.`,
                                `After user approval, call approve_doc with project_name="${project_name}" and doc_id="${doc_id}".`,
                                `If the user requests changes, revise the document and call write_doc again.`,
                            ].join('\n'),
                        },
                    ],
                };
            }

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Document "${doc_id}" written to ${filePath}`,
                    },
                ],
            };
        },
    );

    server.tool(
        'read_doc',
        'Read a project document from the project docs directory.',
        {
            project_name: z.string().describe('Project name'),
            doc_id: z.string().describe('Document ID to read'),
        },
        async ({ project_name, doc_id }) => {
            try {
                const docContent = await readDoc(project_name, doc_id);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: docContent,
                        },
                    ],
                };
            } catch {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Document "${doc_id}" not found. Use list_docs to see available documents.`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    );

    server.tool(
        'list_docs',
        'List all project documents in the project docs directory.',
        {
            project_name: z.string().describe('Project name'),
        },
        async ({ project_name }) => {
            const docs = await listDocs(project_name);
            return {
                content: [
                    {
                        type: 'text' as const,
                        text:
                            docs.length > 0
                                ? `Documents:\n${docs.map((d) => `- ${d}`).join('\n')}`
                                : 'No documents found. Initialize a project first with project_init.',
                    },
                ],
            };
        },
    );
}
