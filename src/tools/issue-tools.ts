/**
 * MCP Tools: issue_create / issue_update / issue_list
 * Issue tracking for Harmonia projects.
 *
 * Issues are project-level (not per-iteration/patch). They track problems
 * discovered during testing or user feedback, and can be linked to
 * the patch or iteration that resolves them.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProject } from '../core/registry.js';
import { createIssue, updateIssue, listIssues } from '../core/issues.js';
import type { Issue } from '../core/types.js';

function formatIssue(issue: Issue): string {
    const resolvedBy = issue.resolvedBy ? ` → resolved by ${issue.resolvedBy.type}-${issue.resolvedBy.number}` : '';
    const closed = issue.closedAt ? ` (closed: ${issue.closedAt.split('T')[0]})` : '';
    return [
        `[${issue.status.toUpperCase()}] ${issue.id}: ${issue.title}`,
        `  Source: ${issue.source} | Iteration: ${issue.iteration} | Created: ${issue.createdAt.split('T')[0]}${resolvedBy}${closed}`,
        `  ${issue.description}`,
    ].join('\n');
}

export function registerIssueTools(server: McpServer): void {
    // ─── issue_create ───
    server.tool(
        'issue_create',
        'Create a new issue for a project. Issues track problems found during testing or user feedback.',
        {
            project_name: z.string().describe('项目名称'),
            title: z.string().describe('Issue 标题（简短描述）'),
            description: z.string().describe('Issue 详细描述'),
            source: z
                .enum(['test', 'user-feedback'])
                .describe('Issue 来源: test（测试发现）或 user-feedback（用户反馈）'),
            iteration: z.number().int().positive().describe('关联的迭代编号（在哪个迭代中发现的）'),
        },
        async ({ project_name, title, description, source, iteration }) => {
            const entry = await getProject(project_name);
            if (!entry) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `项目 "${project_name}" 未注册。请先调用 project_init 注册项目。`,
                        },
                    ],
                    isError: true,
                };
            }

            const issue = await createIssue(project_name, title, description, source, iteration);

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: [
                            `Issue 已创建: ${issue.id}`,
                            ``,
                            formatIssue(issue),
                            ``,
                            `如需修复此 issue，可调用 patch_start(project_name="${project_name}", issue_id="${issue.id}") 开始补丁。`,
                        ].join('\n'),
                    },
                ],
            };
        },
    );

    // ─── issue_update ───
    server.tool(
        'issue_update',
        'Update an existing issue. Can change status and link to the resolving patch/iteration.',
        {
            project_name: z.string().describe('项目名称'),
            issue_id: z.string().describe('Issue ID (e.g. issue-1)'),
            status: z.enum(['open', 'closed']).optional().describe('新状态'),
            resolved_by_type: z.enum(['iteration', 'patch']).optional().describe('解决该 issue 的上下文类型'),
            resolved_by_number: z.number().int().positive().optional().describe('解决该 issue 的上下文编号'),
        },
        async ({ project_name, issue_id, status, resolved_by_type, resolved_by_number }) => {
            const entry = await getProject(project_name);
            if (!entry) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `项目 "${project_name}" 未注册。`,
                        },
                    ],
                    isError: true,
                };
            }

            const updates: Parameters<typeof updateIssue>[2] = {};

            if (status !== undefined) {
                updates.status = status;
            }

            if (resolved_by_type && resolved_by_number) {
                updates.resolvedBy = {
                    type: resolved_by_type,
                    number: resolved_by_number,
                };
            }

            try {
                const issue = await updateIssue(project_name, issue_id, updates);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: [`Issue 已更新:`, ``, formatIssue(issue)].join('\n'),
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

    // ─── issue_list ───
    server.tool(
        'issue_list',
        'List issues for a project with optional filters.',
        {
            project_name: z.string().describe('项目名称'),
            status: z.enum(['open', 'closed']).optional().describe('按状态筛选'),
            source: z.enum(['test', 'user-feedback']).optional().describe('按来源筛选'),
            iteration: z.number().int().positive().optional().describe('按迭代编号筛选'),
        },
        async ({ project_name, status, source, iteration }) => {
            const entry = await getProject(project_name);
            if (!entry) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `项目 "${project_name}" 未注册。`,
                        },
                    ],
                    isError: true,
                };
            }

            const filters: Parameters<typeof listIssues>[1] = {};
            if (status) filters.status = status;
            if (source) filters.source = source;
            if (iteration !== undefined) filters.iteration = iteration;

            const issues = await listIssues(project_name, Object.keys(filters).length > 0 ? filters : undefined);

            if (issues.length === 0) {
                const filterDesc = Object.keys(filters).length > 0 ? '（符合筛选条件的）' : '';
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `项目 "${project_name}" 暂无${filterDesc} issue。`,
                        },
                    ],
                };
            }

            const openCount = issues.filter((i) => i.status === 'open').length;
            const closedCount = issues.filter((i) => i.status === 'closed').length;

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: [
                            `# Issues — ${project_name}`,
                            ``,
                            `共 ${issues.length} 个 issue（${openCount} open, ${closedCount} closed）`,
                            ``,
                            ...issues.map((i) => formatIssue(i)),
                        ].join('\n'),
                    },
                ],
            };
        },
    );
}
