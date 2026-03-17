/**
 * MCP Tool: patch_start
 * Start a new patch for a registered project.
 *
 * Creates the patch directory (patch-N/), initializes state.json with
 * clarify/design phases skipped, scale=small, type=patch.
 * Optionally links to an issue via issue_id.
 *
 * Guards:
 * - Project must be registered (use project_init first)
 * - At least one iteration must have been started (patches fix existing work)
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProject, startPatch, getPatchDir } from '../core/registry.js';
import { loadWorkflow } from '../core/workflow.js';
import { initProjectState } from '../core/state.js';

export function registerPatchStart(server: McpServer, builtinDir: string, customDir: string): void {
    server.tool(
        'patch_start',
        'Start a new patch for a registered project. Patches are lightweight fix cycles — clarify and design phases are skipped, scale is fixed to small. Use this for bug fixes, small improvements, or resolving issues.',
        {
            project_name: z.string().describe('项目名称'),
            description: z.string().optional().describe('补丁描述（简要说明修复内容）'),
            issue_id: z.string().optional().describe('关联的 issue ID（如果是修复某个 issue）'),
        },
        async ({ project_name, description, issue_id }) => {
            try {
                // Guard: project must be registered
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

                // Guard: at least one iteration must exist (patches fix existing work)
                if (entry.totalIterations === 0) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: [
                                    `项目 "${project_name}" 尚未有任何迭代。`,
                                    `补丁用于修复已有工作，请先调用 iteration_start 开始第一轮迭代。`,
                                ].join('\n'),
                            },
                        ],
                        isError: true,
                    };
                }

                // Start new patch (creates directory, updates registry)
                const newPatch = await startPatch(project_name);

                // Load workflow and initialize state in patch mode
                const wf = await loadWorkflow(builtinDir, customDir, entry.workflow);
                const patchDir = getPatchDir(project_name, newPatch);
                const state = await initProjectState(project_name, entry.dir, wf, newPatch, 'patch', patchDir);

                const descLine = description ? `描述: ${description}` : '';
                const issueLine = issue_id ? `关联 issue: ${issue_id}` : '';

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: [
                                `补丁 patch-${newPatch} 已开始。`,
                                ``,
                                `项目: ${project_name}`,
                                `源代码目录: ${entry.dir}`,
                                `工作流: ${wf.definition.name}`,
                                `规模: small (固定)`,
                                `当前阶段: ${state.currentPhase}`,
                                `跳过阶段: clarify, design`,
                                descLine,
                                issueLine,
                                ``,
                                `下一步: 开始开发。使用 role_dispatch 分配开发者，或直接使用 doc_write 编写文档。`,
                            ]
                                .filter(Boolean)
                                .join('\n'),
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
