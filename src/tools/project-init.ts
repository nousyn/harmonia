/**
 * MCP Tool: project_init
 * Register a new Harmonia project in the global registry.
 *
 * This tool ONLY registers the project — it does NOT create iteration directories
 * or initialize state. After registration, call `iteration_start` to begin the
 * first iteration.
 *
 * Supports an optional `workflow` parameter. When multiple workflows are
 * available and none is specified, returns an error with the available list
 * so the agent can re-call with a specific choice.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadWorkflow, listWorkflows } from '../core/workflow.js';
import { registerProject, getProject } from '../core/registry.js';

export function registerProjectInit(server: McpServer, builtinDir: string, customDir: string): void {
    server.tool(
        'project_init',
        'Register a new Harmonia project. Creates the project entry in the global registry and the project source directory. Does NOT start an iteration — call iteration_start after registration to begin the first iteration.',
        {
            project_name: z
                .string()
                .regex(
                    /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
                    'project_name 只允许小写字母、数字和短横线，且不能以短横线开头或结尾',
                )
                .min(2, 'project_name 至少 2 个字符')
                .max(64, 'project_name 最多 64 个字符')
                .describe('唯一的项目名称（只允许小写字母、数字和短横线，如 my-app）'),
            project_dir: z
                .string()
                .refine((s) => s.startsWith('/'), { message: 'project_dir 必须是绝对路径（以 / 开头）' })
                .describe('项目源代码目录的绝对路径（如不存在会自动创建）'),
            workflow: z
                .string()
                .optional()
                .describe('工作流名称（如 dev）。只有一个可用工作流时自动选中；多个时必须指定。'),
        },
        async ({ project_name, project_dir, workflow }) => {
            // Check if already registered
            const existing = await getProject(project_name);
            if (existing) {
                const iterInfo =
                    existing.currentIteration > 0
                        ? `当前迭代: iter-${existing.currentIteration} (共 ${existing.totalIterations} 轮)`
                        : '尚未开始迭代';

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: [
                                `项目 "${project_name}" 已注册。`,
                                ``,
                                `源代码目录: ${existing.dir}`,
                                `工作流: ${existing.workflow}`,
                                `${iterInfo}`,
                                ``,
                                existing.currentIteration > 0
                                    ? `如需查看当前状态，请调用 project_status(project_name="${project_name}")。`
                                    : `请调用 iteration_start(project_name="${project_name}") 开始第一轮迭代。`,
                                existing.currentIteration > 0
                                    ? `如需开始新一轮迭代，请调用 iteration_start(project_name="${project_name}")。`
                                    : '',
                            ]
                                .filter(Boolean)
                                .join('\n'),
                        },
                    ],
                };
            }

            // Resolve workflow name
            const available = await listWorkflows(builtinDir, customDir);

            if (available.length === 0) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: '没有可用的工作流。请检查 Harmonia 安装是否完整，或在自定义工作流目录中创建工作流。',
                        },
                    ],
                    isError: true,
                };
            }

            let workflowName: string;

            if (workflow) {
                // Explicit workflow specified — validate it exists
                if (!available.includes(workflow)) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `工作流 "${workflow}" 不存在。可用的工作流: ${available.join(', ')}`,
                            },
                        ],
                        isError: true,
                    };
                }
                workflowName = workflow;
            } else if (available.length === 1) {
                // Only one workflow — auto-select
                workflowName = available[0];
            } else {
                // Multiple workflows — require explicit choice
                // Load descriptions for each workflow to help the agent decide
                const descriptions: string[] = [];
                for (const name of available) {
                    try {
                        const wf = await loadWorkflow(builtinDir, customDir, name);
                        descriptions.push(`- ${name}: ${wf.definition.description}`);
                    } catch {
                        descriptions.push(`- ${name}: (无法加载描述)`);
                    }
                }

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: [
                                `有 ${available.length} 个可用工作流，请指定 workflow 参数:`,
                                '',
                                ...descriptions,
                                '',
                                `示例: project_init(project_name="${project_name}", project_dir="${project_dir}", workflow="dev")`,
                            ].join('\n'),
                        },
                    ],
                    isError: true,
                };
            }

            // Load workflow definition (validate it loads correctly)
            const wf = await loadWorkflow(builtinDir, customDir, workflowName);

            // Register project (creates global data dir + project source dir)
            await registerProject(project_name, project_dir, workflowName);

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: [
                            `项目 "${project_name}" 注册成功。`,
                            ``,
                            `源代码目录: ${project_dir}`,
                            `工作流: ${wf.definition.name} (${wf.definition.description})`,
                            `可用角色: ${Object.keys(wf.roles).join(', ')}`,
                            ``,
                            `下一步: 调用 iteration_start(project_name="${project_name}") 开始第一轮迭代。`,
                        ].join('\n'),
                    },
                ],
            };
        },
    );
}
