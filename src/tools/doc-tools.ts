/**
 * MCP Tools: write_doc / read_doc / list_docs
 * Read and write project documents under ~/.harmonia/<project_name>/docs/
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { writeDoc, readDoc, listDocs } from '../core/docs.js';

export function registerDocTools(server: McpServer): void {
    server.tool(
        'write_doc',
        'Write or update a project document in ~/.harmonia/<project_name>/docs/. Use the doc IDs defined in the workflow (e.g. prd, user-stories, tech-design, task-breakdown, etc.).',
        {
            project_name: z.string().describe('Project name'),
            doc_id: z
                .string()
                .describe(
                    'Document ID (e.g. prd, user-stories, fsd, tech-design, task-breakdown, test-plan, test-report, etc.)',
                ),
            content: z.string().describe('Markdown content of the document'),
        },
        async ({ project_name, doc_id, content }) => {
            const filePath = await writeDoc(project_name, doc_id, content);
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
        'Read a project document from ~/.harmonia/<project_name>/docs/.',
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
        'List all project documents in ~/.harmonia/<project_name>/docs/.',
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
