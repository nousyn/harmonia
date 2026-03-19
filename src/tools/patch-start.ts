/**
 * MCP Tool: patch_start
 * Start a new patch for a registered project.
 *
 * Creates the patch directory (patch-N/), initializes state.json with
 * node-based workflow state, type=patch.
 * Optionally links to an issue via issue_id.
 *
 * After initialization, starts the workflow engine and returns initial nextAction.
 *
 * Guards:
 * - Project must be registered (use project_init first)
 * - At least one iteration must have been started (patches fix existing work)
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProject, startPatch, getPatchDir } from '../core/registry.js';
import { loadWorkflow } from '../core/plugin.js';
import { initWorkflowState, persistState } from '../core/state.js';
import { startWorkflow } from '../core/workflow-engine.js';
import { formatNextAction } from './engine-helpers.js';
import type { EngineContext, GateContext } from '../core/workflow-engine.js';

export function registerPatchStart(server: McpServer, workflowsDir: string): void {
    server.tool(
        'patch_start',
        'Start a new patch for a registered project. Patches are lightweight fix cycles for bug fixes and small improvements. Use this for resolving issues found during testing or from user feedback.',
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
                const wf = await loadWorkflow(workflowsDir, entry.workflow);
                const patchDir = getPatchDir(project_name, newPatch);
                const state = await initWorkflowState(project_name, entry.dir, wf, newPatch, 'patch', patchDir);

                // Persist patch metadata (issue_id, description)
                if (issue_id || description) {
                    state.meta = {
                        ...(description ? { description } : {}),
                        ...(issue_id ? { issueId: issue_id } : {}),
                    };
                    await persistState(project_name, newPatch, state, patchDir);
                }

                // Start the workflow engine
                const emptyGate: GateContext = {
                    artifactExists: () => false,
                    artifactApproved: () => false,
                    artifactField: () => undefined,
                };
                const engineCtx: EngineContext = {
                    gate: emptyGate,
                    getRolePrompt: (role: string) => {
                        const roleDef = wf.roles[role];
                        return roleDef?.prompt ?? `Role "${role}" prompt not found`;
                    },
                    getInputArtifacts: () => [],
                };

                const result = startWorkflow(wf.definition, state, engineCtx);
                await persistState(project_name, newPatch, result.state, patchDir);

                const nextActionText = formatNextAction(result.nextAction);
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
                                descLine,
                                issueLine,
                                ``,
                                nextActionText,
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
