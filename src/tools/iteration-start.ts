/**
 * MCP Tool: iteration_start
 * Start a new iteration for a registered project.
 *
 * Creates the iteration directory (iter-N/), initializes state.json,
 * and updates the registry with the new iteration number.
 *
 * Guards:
 * - Project must be registered (use project_init first)
 * - If a current iteration exists, all phases must be completed (or use force)
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProject, startIteration, getIterationDir, resolveContextDir } from '../core/registry.js';
import { loadWorkflow } from '../core/workflow.js';
import { initProjectState, readState } from '../core/state.js';

export function registerIterationStart(server: McpServer, builtinDir: string, customDir: string): void {
    server.tool(
        'iteration_start',
        'Start a new iteration for a registered project. Creates iteration directory, initializes state, and updates registry. Call this after project_init to begin the first iteration, or after completing all phases to start a new iteration.',
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

                // Guard: if there's a current iteration, check if all phases are completed
                if (entry.currentIteration > 0 && !force) {
                    try {
                        // Resolve the current iteration's context dir
                        const currentIterDir = entry.activeContext
                            ? resolveContextDir(project_name, `iter-${entry.currentIteration}`)?.dir
                            : undefined;
                        const currentState = await readState(project_name, entry.currentIteration, currentIterDir);
                        const incompletePhases = currentState.phases.filter(
                            (p) => p.status !== 'completed' && p.status !== 'skipped',
                        );
                        if (incompletePhases.length > 0) {
                            const phaseList = incompletePhases.map((p) => `${p.id} (${p.status})`).join(', ');
                            return {
                                content: [
                                    {
                                        type: 'text' as const,
                                        text: [
                                            `当前迭代 (iter-${entry.currentIteration}) 尚有未完成的阶段: ${phaseList}`,
                                            ``,
                                            `请先完成当前迭代的所有阶段，或使用 force=true 强制开始新迭代。`,
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
                const state = await initProjectState(
                    project_name,
                    entry.dir,
                    wf,
                    newIteration,
                    'iteration',
                    newIterDir,
                );

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
                                `规模: (未设定)`,
                                `当前阶段: ${state.currentPhase}`,
                                ``,
                                `下一步: 与用户沟通需求，编写 PRD，PRD 审批通过后调用 project_set_scale 设定项目规模。`,
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
