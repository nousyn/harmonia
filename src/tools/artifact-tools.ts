/**
 * MCP Tools: artifact_write / artifact_read / artifact_list
 * Read and write project artifacts under <data_dir>/<project_name>/artifacts/
 *
 * artifact_write validates content against artifact schemas and checks review
 * configuration. If validation fails, the write is rejected with specific
 * error details. If review is required, the artifact is submitted for
 * user approval.
 *
 * Sequential mode: When an artifact has `steps` defined in workflow.json,
 * artifact_write requires a `step` parameter. Each step is validated
 * independently, and the final step automatically writes the formal
 * artifact and triggers the review flow.
 *
 * After writing, triggers engine event `artifact_written` to evaluate gates.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { writeArtifact, readArtifact, listArtifacts, writeStepArtifact } from '../core/artifacts.js';
import { readState } from '../core/state.js';
import { loadWorkflow } from '../core/plugin.js';
import { getMergedOverrides, resolveArtifactReview } from '../core/overrides.js';
import { submitForReview } from '../core/reviews.js';
import { loadArtifactSchema, validateArtifact, formatValidationErrors } from '../core/schema.js';
import { getArtifactStepState, getCompletedStepIds, recordStepCompletion, markFinalized } from '../core/steps.js';
import { resolveActive, isError } from './utils.js';
import { processWorkflowEvent, loadWorkflowForContext, formatNextAction } from './engine-helpers.js';
import { getProject, resolveContextDir } from '../core/registry.js';
import type { ArtifactDefinition, ArtifactStepDefinition } from '../core/types.js';

/**
 * Check if sequential mode is active for a given artifact definition.
 * Sequential mode is active whenever the artifact has steps defined.
 */
function isSequentialActive(artifactDef: ArtifactDefinition): boolean {
    return !!artifactDef.steps?.length;
}

export function registerArtifactTools(server: McpServer, builtinDir: string, customDir: string): void {
    server.tool(
        'artifact_write',
        'Write or update a project artifact. For artifacts with sequential steps (PRD, tech-design, task-breakdown), you MUST specify the step parameter. Automatically checks review configuration — if review is required, the artifact is submitted for user approval.',
        {
            project_name: z.string().describe('Project name'),
            artifact_id: z
                .string()
                .describe('Artifact ID (e.g. prd, user-stories, fsd, prototype, tech-design, task-breakdown, etc.)'),
            content: z
                .string()
                .describe('Artifact content (markdown, HTML, or JSON depending on artifact type and step)'),
            step: z
                .string()
                .optional()
                .describe(
                    'Sequential step ID (required for artifacts with steps). Use project_status to see available steps.',
                ),
        },
        async ({ project_name, artifact_id, content, step }) => {
            const ctx = await resolveActive(project_name);
            if (isError(ctx)) return ctx;

            // Load workflow to get artifact definition (format, review defaults)
            const { wf, state } = await loadWorkflowForContext(builtinDir, customDir, project_name, ctx);
            const artifactDef = wf.artifactDefinitions[artifact_id];
            const isHtml = artifactDef?.format === 'html';

            // Guard: artifact_id must be defined in workflow
            if (!artifactDef) {
                const validIds = Object.keys(wf.artifactDefinitions)
                    .filter((id) => !wf.artifactDefinitions[id].external)
                    .join(', ');
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Artifact "${artifact_id}" 未在工作流中定义。可用的 artifact 类型: ${validIds}`,
                        },
                    ],
                    isError: true,
                };
            }

            // Guard: reject external artifact types (should be produced outside artifact_write)
            if (artifactDef.external) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Artifact "${artifact_id}" 是外部产出类型，不应通过 artifact_write 写入。`,
                        },
                    ],
                    isError: true,
                };
            }

            // Guard: empty content
            if (!content.trim()) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: 'Artifact 内容为空，请提供实际内容后重新提交。',
                        },
                    ],
                    isError: true,
                };
            }

            // ─── Sequential Mode ───
            if (isSequentialActive(artifactDef)) {
                return handleSequentialWrite(
                    builtinDir,
                    customDir,
                    state.workflow,
                    project_name,
                    ctx,
                    artifact_id,
                    content,
                    step,
                    artifactDef,
                );
            }

            // ─── Normal Mode (no steps) ───

            // Schema validation — reject write if content doesn't meet requirements
            const schema = await loadArtifactSchema(builtinDir, customDir, state.workflow, artifact_id);
            if (schema) {
                const result = validateArtifact(content, schema, isHtml);
                if (!result.valid) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: formatValidationErrors(result.errors),
                            },
                        ],
                        isError: true,
                    };
                }
            }

            // Write the artifact with correct extension
            const filePath = await writeArtifact(project_name, ctx.number, artifact_id, content, artifactDef, ctx.dir);

            // Trigger engine event: artifact_written
            const engineResult = await processWorkflowEvent(builtinDir, customDir, project_name, ctx, {
                type: 'artifact_written',
                artifactId: artifact_id,
            });

            // Check if review is required
            const overrides = await getMergedOverrides(project_name);
            const needsReview = resolveArtifactReview(artifact_id, artifactDef, overrides);

            if (needsReview) {
                await submitForReview(project_name, ctx.number, artifact_id, ctx.dir);
                const artifactName = artifactDef.name ?? artifact_id;
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: [
                                `Artifact "${artifact_id}" (${artifactName}) written to ${filePath}`,
                                ``,
                                `** REVIEW REQUIRED **`,
                                `This artifact requires user approval before the workflow can proceed.`,
                                `Please present the artifact content to the user and ask for their confirmation.`,
                                `After user approval, call artifact_approve with project_name="${project_name}" and artifact_id="${artifact_id}".`,
                                `If the user requests changes, revise the artifact and call artifact_write again.`,
                                formatNextAction(engineResult.nextAction),
                            ].join('\n'),
                        },
                    ],
                };
            }

            return {
                content: [
                    {
                        type: 'text' as const,
                        text:
                            `Artifact "${artifact_id}" written to ${filePath}` +
                            formatNextAction(engineResult.nextAction),
                    },
                ],
            };
        },
    );

    server.tool(
        'artifact_read',
        'Read a project artifact. By default reads from the active context. Use the optional `context` parameter (e.g. "iter-1", "patch-2") to read from a different context.',
        {
            project_name: z.string().describe('Project name'),
            artifact_id: z.string().describe('Artifact ID to read'),
            context: z
                .string()
                .optional()
                .describe('Context to read from (e.g. "iter-1", "patch-2"). Defaults to active context.'),
        },
        async ({ project_name, artifact_id, context }) => {
            try {
                let contextNumber: number;
                let contextDir: string;

                if (context) {
                    // Cross-context read: resolve the specified context
                    const entry = await getProject(project_name);
                    if (!entry) {
                        return {
                            content: [{ type: 'text' as const, text: `项目 "${project_name}" 未注册。` }],
                            isError: true,
                        };
                    }
                    const resolved = resolveContextDir(project_name, context);
                    if (!resolved) {
                        return {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: `无法解析上下文 "${context}"。格式示例: iter-1, patch-2`,
                                },
                            ],
                            isError: true,
                        };
                    }
                    contextNumber = resolved.number;
                    contextDir = resolved.dir;
                } else {
                    // Default: active context
                    const ctx = await resolveActive(project_name);
                    if (isError(ctx)) return ctx;
                    contextNumber = ctx.number;
                    contextDir = ctx.dir;
                }

                const artifactContent = await readArtifact(project_name, contextNumber, artifact_id, contextDir);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: artifactContent,
                        },
                    ],
                };
            } catch {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Artifact "${artifact_id}" not found. Use artifact_list to see available artifacts.`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    );

    server.tool(
        'artifact_list',
        'List all project artifacts. By default lists from the active context. Use the optional `context` parameter (e.g. "iter-1", "patch-2") to list from a different context.',
        {
            project_name: z.string().describe('Project name'),
            context: z
                .string()
                .optional()
                .describe('Context to list from (e.g. "iter-1", "patch-2"). Defaults to active context.'),
        },
        async ({ project_name, context }) => {
            let contextNumber: number;
            let contextDir: string;
            let contextLabel: string;

            if (context) {
                const entry = await getProject(project_name);
                if (!entry) {
                    return {
                        content: [{ type: 'text' as const, text: `项目 "${project_name}" 未注册。` }],
                        isError: true,
                    };
                }
                const resolved = resolveContextDir(project_name, context);
                if (!resolved) {
                    return {
                        content: [
                            { type: 'text' as const, text: `无法解析上下文 "${context}"。格式示例: iter-1, patch-2` },
                        ],
                        isError: true,
                    };
                }
                contextNumber = resolved.number;
                contextDir = resolved.dir;
                contextLabel = context;
            } else {
                const ctx = await resolveActive(project_name);
                if (isError(ctx)) return ctx;
                contextNumber = ctx.number;
                contextDir = ctx.dir;
                contextLabel = ctx.activeContext;
            }

            const artifacts = await listArtifacts(project_name, contextNumber, contextDir);
            return {
                content: [
                    {
                        type: 'text' as const,
                        text:
                            artifacts.length > 0
                                ? `Artifacts (${contextLabel}):\n${artifacts.map((d) => `- ${d}`).join('\n')}`
                                : `No artifacts found for ${contextLabel}.`,
                    },
                ],
            };
        },
    );
}

// ─── Sequential Write Handler ───

type ToolResult = {
    content: { type: 'text'; text: string }[];
    isError?: boolean;
};

async function handleSequentialWrite(
    builtinDir: string,
    customDir: string,
    workflowName: string,
    projectName: string,
    ctx: import('./utils.js').ResolvedContext,
    artifactId: string,
    content: string,
    step: string | undefined,
    artifactDef: ArtifactDefinition,
): Promise<ToolResult> {
    const steps = artifactDef.steps!;
    const stepIds = steps.map((s) => s.id);
    const stepNames = steps.map((s) => `${s.id} (${s.name})`).join(', ');

    // Guard: step parameter is required in sequential mode
    if (!step) {
        return {
            content: [
                {
                    type: 'text' as const,
                    text: [
                        `Artifact "${artifactId}" 需要分步写入。`,
                        `请指定 step 参数。可用的步骤: ${stepNames}`,
                        ``,
                        `步骤说明:`,
                        ...steps.map((s, i) => `  ${i + 1}. ${s.id} — ${s.description}`),
                    ].join('\n'),
                },
            ],
            isError: true,
        };
    }

    // Guard: step must be valid
    const stepDef = steps.find((s) => s.id === step);
    if (!stepDef) {
        return {
            content: [
                {
                    type: 'text' as const,
                    text: `未知的步骤 "${step}"。可用的步骤: ${stepNames}`,
                },
            ],
            isError: true,
        };
    }

    const stepIndex = stepIds.indexOf(step);
    const stepState = await getArtifactStepState(projectName, ctx.number, artifactId, ctx.dir);
    const completedIds = getCompletedStepIds(stepState);

    // Guard: prerequisite steps must be completed (hard enforcement)
    for (let i = 0; i < stepIndex; i++) {
        if (!completedIds.has(stepIds[i])) {
            const missingStep = steps[i];
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `无法写入步骤 "${step}"：前置步骤 "${missingStep.id}" (${missingStep.name}) 尚未完成。请先完成该步骤。`,
                    },
                ],
                isError: true,
            };
        }
    }

    // Step schema validation
    const isJson = stepDef.format === 'json';
    const stepSchemaId = `${artifactId}.${step}`;
    const stepSchema = await loadArtifactSchema(builtinDir, customDir, workflowName, stepSchemaId);
    if (stepSchema) {
        const result = validateArtifact(content, stepSchema, false, isJson);
        if (!result.valid) {
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: formatValidationErrors(result.errors),
                    },
                ],
                isError: true,
            };
        }
    }

    // Write the step artifact
    const artifactPath = await writeStepArtifact(
        projectName,
        ctx.number,
        artifactId,
        step,
        content,
        stepDef.format,
        ctx.dir,
    );

    // Record step completion (handles rollback if overwriting)
    await recordStepCompletion(projectName, ctx.number, artifactId, step, artifactPath, stepIds, ctx.dir);

    const isLastStep = stepIndex === steps.length - 1;

    if (isLastStep) {
        // Auto-merge: validate against final artifact schema, write formal artifact, trigger review
        return handleFinalStep(
            builtinDir,
            customDir,
            workflowName,
            projectName,
            ctx,
            artifactId,
            content,
            artifactDef,
            stepDef,
        );
    }

    // Not the last step — return progress info
    const nextStep = steps[stepIndex + 1];
    return {
        content: [
            {
                type: 'text' as const,
                text: [
                    `步骤 "${step}" (${stepDef.name}) 完成，产物已写入 ${artifactPath}`,
                    ``,
                    `下一步: ${nextStep.id} — ${nextStep.description}`,
                    `请调用 artifact_write(project_name="${projectName}", artifact_id="${artifactId}", step="${nextStep.id}", content=...)`,
                ].join('\n'),
            },
        ],
    };
}

async function handleFinalStep(
    builtinDir: string,
    customDir: string,
    workflowName: string,
    projectName: string,
    ctx: import('./utils.js').ResolvedContext,
    artifactId: string,
    content: string,
    artifactDef: ArtifactDefinition,
    stepDef: ArtifactStepDefinition,
): Promise<ToolResult> {
    const isHtml = artifactDef.format === 'html';

    // Validate against the final artifact schema (e.g. prd.json)
    const finalSchema = await loadArtifactSchema(builtinDir, customDir, workflowName, artifactId);
    if (finalSchema) {
        const isJson = artifactDef.format === 'json';
        const result = validateArtifact(content, finalSchema, isHtml, isJson);
        if (!result.valid) {
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: [
                            '最终 artifact 校验失败:',
                            formatValidationErrors(result.errors),
                            '',
                            `请修正后重新提交步骤 "${stepDef.id}"。`,
                        ].join('\n'),
                    },
                ],
                isError: true,
            };
        }
    }

    // Write the formal artifact
    const filePath = await writeArtifact(projectName, ctx.number, artifactId, content, artifactDef, ctx.dir);

    // Mark as finalized
    await markFinalized(projectName, ctx.number, artifactId, ctx.dir);

    // Trigger engine event: artifact_written
    const engineResult = await processWorkflowEvent(builtinDir, customDir, projectName, ctx, {
        type: 'artifact_written',
        artifactId,
    });

    // Check if review is required
    const overrides = await getMergedOverrides(projectName);
    const needsReview = resolveArtifactReview(artifactId, artifactDef, overrides);

    if (needsReview) {
        await submitForReview(projectName, ctx.number, artifactId, ctx.dir);
        const artifactName = artifactDef.name ?? artifactId;
        return {
            content: [
                {
                    type: 'text' as const,
                    text: [
                        `所有步骤完成！Artifact "${artifactId}" (${artifactName}) 已写入 ${filePath}`,
                        ``,
                        `** REVIEW REQUIRED **`,
                        `This artifact requires user approval before the workflow can proceed.`,
                        `Please present the artifact content to the user and ask for their confirmation.`,
                        `After user approval, call artifact_approve with project_name="${projectName}" and artifact_id="${artifactId}".`,
                        `If the user requests changes, revise the artifact and call artifact_write again with the appropriate step.`,
                        formatNextAction(engineResult.nextAction),
                    ].join('\n'),
                },
            ],
        };
    }

    return {
        content: [
            {
                type: 'text' as const,
                text:
                    `所有步骤完成！Artifact "${artifactId}" 已写入 ${filePath}` +
                    formatNextAction(engineResult.nextAction),
            },
        ],
    };
}
