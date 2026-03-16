/**
 * MCP Tool: project_set_scale
 * Set the project scale after PRD approval. Scale is immutable once set.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readState, setScale } from '../core/state.js';
import { loadWorkflow } from '../core/workflow.js';
import { readReviews } from '../core/reviews.js';
import type { ProjectScale } from '../core/types.js';

export function registerSetScale(server: McpServer, builtinDir: string, customDir: string): void {
    server.tool(
        'project_set_scale',
        'Set the project scale after PRD approval. Scale determines which documents are required (full/lite/skip) and enables sequential mode for medium/large projects. Scale is immutable once set — if requirements change significantly, redo the PRD.',
        {
            project_name: z.string().describe('项目名称'),
            scale: z.enum(['small', 'medium', 'large']).describe('项目规模 (small/medium/large)'),
        },
        async ({ project_name, scale }) => {
            try {
                // Check project exists
                const state = await readState(project_name);

                // Guard: scale already set
                if (state.scale !== null) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Scale 已设定为 "${state.scale}"，不可更改。如需调整规模，请重新评估 PRD。`,
                            },
                        ],
                        isError: true,
                    };
                }

                // Guard: PRD must be approved
                const reviews = await readReviews(project_name);
                const prdReview = reviews['prd'];
                if (!prdReview || prdReview.status !== 'approved') {
                    const prdStatus = prdReview ? prdReview.status : '未提交';
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `无法设定 scale：PRD 尚未审批通过（当前状态: ${prdStatus}）。请先完成 PRD 编写和审批，再设定项目规模。`,
                            },
                        ],
                        isError: true,
                    };
                }

                // Set scale
                const updated = await setScale(project_name, scale as ProjectScale);

                // Build doc list based on scale
                const wf = await loadWorkflow(builtinDir, customDir, state.workflow);
                const requiredDocs = Object.entries(wf.definition.docs)
                    .filter(([, doc]) => {
                        const s = doc.scale[scale];
                        return s === 'full' || s === 'lite';
                    })
                    .map(([id, doc]) => `- ${doc.name} (${id})`)
                    .join('\n');

                const optionalDocs = Object.entries(wf.definition.docs)
                    .filter(([, doc]) => doc.scale[scale] === 'optional')
                    .map(([id, doc]) => `- ${doc.name} (${id})`)
                    .join('\n');

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: [
                                `项目 "${project_name}" 规模已设定为 "${scale}"。`,
                                ``,
                                `必需文档:`,
                                requiredDocs || '(无)',
                                optionalDocs ? `\n可选文档:\n${optionalDocs}` : '',
                                ``,
                                `当前阶段: ${updated.currentPhase}`,
                                scale !== 'small'
                                    ? `\n注意: ${scale} 规模项目的 PRD、tech-design、task-breakdown 等文档将启用分步写入模式。`
                                    : '',
                            ].join('\n'),
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
