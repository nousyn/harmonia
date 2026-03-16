/**
 * MCP Tool: project_init
 * Initialize a new Harmonia project with global registry and data directory.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadWorkflow } from '../core/workflow.js';
import { initProjectState, readState } from '../core/state.js';
import { registerProject, getProject } from '../core/registry.js';

export function registerProjectInit(server: McpServer, workflowsDir: string): void {
    server.tool(
        'project_init',
        "Initialize a new Harmonia project. Registers the project in the global data directory, creates data directories for documents/state, and creates the project source directory if it doesn't exist. Scale is NOT set here — use project_set_scale after PRD approval.",
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
        },
        async ({ project_name, project_dir }) => {
            // Check if already initialized
            const existing = await getProject(project_name);
            if (existing) {
                const state = await readState(project_name);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Project "${project_name}" already exists.\n\nSource directory: ${existing.dir}\n\nCurrent state:\n${JSON.stringify(state, null, 2)}`,
                        },
                    ],
                };
            }

            // Load workflow definition (default: dev)
            const workflowName = 'dev';
            const wf = await loadWorkflow(workflowsDir, workflowName);

            // Register project (creates global data dirs + project source dir)
            await registerProject(project_name, project_dir, workflowName);

            // Initialize project state (scale = null)
            const state = await initProjectState(project_name, project_dir, wf);

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: [
                            `项目 "${project_name}" 初始化成功。`,
                            ``,
                            `源代码目录: ${project_dir}`,
                            `工作流: ${wf.definition.name} (${wf.definition.description})`,
                            `规模: (未设定)`,
                            `当前阶段: ${state.currentPhase}`,
                            `可用角色: ${Object.keys(wf.roles).join(', ')}`,
                            ``,
                            `下一步: 与用户沟通需求，编写 PRD，PRD 审批通过后调用 project_set_scale 设定项目规模。`,
                        ].join('\n'),
                    },
                ],
            };
        },
    );
}
