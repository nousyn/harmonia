/**
 * MCP Tool: iteration_start
 * Start a new iteration for a registered project.
 *
 * Creates the iteration directory (iter-N/), initializes state.json
 * with node-based workflow state, and updates the registry.
 *
 * After initialization, starts the workflow engine to activate the root
 * node and returns the initial nextAction.
 *
 * Guards:
 * - Project must be registered (use project_init first)
 * - If a current iteration exists, workflow must be completed (or use force)
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProject, startIteration, getIterationDir, resolveContextDir } from '../core/registry.js';
import { loadWorkflow } from '../core/plugin.js';
import { initWorkflowState, readState } from '../core/state.js';
import { startWorkflow } from '../core/workflow-engine.js';
import { persistState } from '../core/state.js';
import { formatNextAction } from './engine-helpers.js';
import type { EngineContext, GateContext } from '../core/workflow-engine.js';

export function registerIterationStart(server: McpServer, builtinDir: string, customDir: string): void {
    server.tool(
        'iteration_start',
        'Start a new iteration for a registered project. Creates iteration directory, initializes state, and updates registry. Call this after project_init to begin the first iteration, or after completing the workflow to start a new iteration.',
        {
            project_name: z.string().describe('项目名称'),
            force: z.boolean().optional().describe('强制开始新迭代，即使当前迭代未完成 (default: false)'),
        },
        async ({ project_name, force }) => {
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

                // Guard: if there's a current iteration, check if the workflow root is completed
                if (entry.currentIteration > 0 && !force) {
                    try {
                        const currentIterDir = entry.activeContext
                            ? resolveContextDir(project_name, `iter-${entry.currentIteration}`)?.dir
                            : undefined;
                        const currentState = await readState(project_name, entry.currentIteration, currentIterDir);
                        // Check if any node is still active or pending (workflow not done)
                        const incompleteNodes = Object.values(currentState.nodes).filter(
                            (n) => n.status === 'active' || n.status === 'pending',
                        );
                        if (incompleteNodes.length > 0) {
                            const summary = incompleteNodes
                                .slice(0, 5)
                                .map((n) => `${n.id} (${n.status})`)
                                .join(', ');
                            const moreText =
                                incompleteNodes.length > 5 ? ` ...及其他 ${incompleteNodes.length - 5} 个节点` : '';
                            return {
                                content: [
                                    {
                                        type: 'text' as const,
                                        text: [
                                            `当前迭代 (iter-${entry.currentIteration}) 工作流尚未完成。`,
                                            `未完成节点: ${summary}${moreText}`,
                                            ``,
                                            `请先完成当前迭代的工作流，或使用 force=true 强制开始新迭代。`,
                                        ].join('\n'),
                                    },
                                ],
                                isError: true,
                            };
                        }
                    } catch {
                        // State file doesn't exist — might be a corrupted iteration, allow proceeding
                    }
                }

                // Start new iteration (creates directory, updates registry)
                const newIteration = await startIteration(project_name);

                // Load workflow and initialize state
                const wf = await loadWorkflow(builtinDir, customDir, entry.workflow);
                const newIterDir = getIterationDir(project_name, newIteration);
                const state = await initWorkflowState(
                    project_name,
                    entry.dir,
                    wf,
                    newIteration,
                    'iteration',
                    newIterDir,
                );

                // Start the workflow engine — activates root node and returns initial nextAction
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
                await persistState(project_name, newIteration, result.state, newIterDir);

                const nextActionText = formatNextAction(result.nextAction);

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: [
                                `迭代 ${newIteration} 已开始。`,
                                ``,
                                `项目: ${project_name}`,
                                `源代码目录: ${entry.dir}`,
                                `工作流: ${wf.definition.name}`,
                                `可用角色: ${Object.keys(wf.roles).join(', ')}`,
                                ``,
                                nextActionText,
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
