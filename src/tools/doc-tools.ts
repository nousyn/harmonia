/**
 * MCP Tools: doc_write / doc_read / doc_list
 * Read and write project documents under <data_dir>/<project_name>/docs/
 *
 * doc_write validates content against document schemas and checks review
 * configuration. If validation fails, the write is rejected with specific
 * error details. If review is required, the document is submitted for
 * user approval.
 *
 * Sequential mode (P3): When a document has `steps` defined in workflow.json
 * and the project scale is >= medium, doc_write requires a `step` parameter.
 * Each step is validated independently, and the final step automatically
 * writes the formal document and triggers the review flow.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { writeDoc, readDoc, listDocs, writeStepArtifact } from '../core/docs.js';
import { readState } from '../core/state.js';
import { loadWorkflow } from '../core/workflow.js';
import { getMergedOverrides, resolveDocReview } from '../core/overrides.js';
import { submitForReview } from '../core/reviews.js';
import { loadDocSchema, validateDoc, formatValidationErrors } from '../core/schema.js';
import { getDocStepState, getCompletedStepIds, recordStepCompletion, markFinalized } from '../core/steps.js';
import { resolveActive, isError } from './utils.js';
import { getProject, resolveContextDir } from '../core/registry.js';
import type { DocDefinition, DocStepDefinition, ProjectScale } from '../core/types.js';

/** Scales that activate sequential mode (medium and above) */
const SEQUENTIAL_SCALES: Set<ProjectScale> = new Set(['medium', 'large']);

/**
 * Check if sequential mode is active for a given doc definition and scale.
 * Returns false when scale is null (not yet set).
 */
function isSequentialActive(docDef: DocDefinition, scale: ProjectScale | null): boolean {
    return scale !== null && !!docDef.steps?.length && SEQUENTIAL_SCALES.has(scale);
}

export function registerDocTools(server: McpServer, builtinDir: string, customDir: string): void {
    server.tool(
        'doc_write',
        'Write or update a project document. For documents with sequential steps (PRD, tech-design, task-breakdown) at medium/large scale, you MUST specify the step parameter. Automatically checks review configuration — if review is required, the document is submitted for user approval.',
        {
            project_name: z.string().describe('Project name'),
            doc_id: z
                .string()
                .describe('Document ID (e.g. prd, user-stories, fsd, prototype, tech-design, task-breakdown, etc.)'),
            content: z.string().describe('Document content (markdown, HTML, or JSON depending on doc type and step)'),
            step: z
                .string()
                .optional()
                .describe(
                    'Sequential step ID (required for docs with steps at medium/large scale). Use project_status to see available steps.',
                ),
        },
        async ({ project_name, doc_id, content, step }) => {
            const ctx = await resolveActive(project_name);
            if (isError(ctx)) return ctx;

            // Load workflow to get doc definition (format, review defaults)
            const state = await readState(project_name, ctx.number, ctx.dir);
            const wf = await loadWorkflow(builtinDir, customDir, state.workflow);
            const docDef = wf.definition.docs[doc_id];
            const isHtml = docDef?.format === 'html';

            // Guard: doc_id must be defined in workflow
            if (!docDef) {
                const validIds = Object.keys(wf.definition.docs)
                    .filter((id) => !wf.definition.docs[id].external)
                    .join(', ');
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `文档类型 "${doc_id}" 未在工作流中定义。可用的文档类型: ${validIds}`,
                        },
                    ],
                    isError: true,
                };
            }

            // Guard: reject external doc types (should be produced outside doc_write)
            if (docDef.external) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `文档 "${doc_id}" 是外部产出类型，不应通过 doc_write 写入。`,
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
                            text: '文档内容为空，请提供实际内容后重新提交。',
                        },
                    ],
                    isError: true,
                };
            }

            // ─── Sequential Mode ───
            if (isSequentialActive(docDef, state.scale)) {
                return handleSequentialWrite(
                    builtinDir,
                    customDir,
                    state.workflow,
                    project_name,
                    ctx.number,
                    doc_id,
                    content,
                    step,
                    docDef,
                    state.scale as ProjectScale,
                    ctx.dir,
                );
            }

            // ─── Normal Mode (no steps or small scale) ───

            // If step was passed but sequential is not active, warn but proceed
            if (step) {
                // Ignore step parameter for non-sequential docs
            }

            // Schema validation — reject write if content doesn't meet requirements
            const schema = await loadDocSchema(builtinDir, customDir, state.workflow, doc_id);
            if (schema) {
                const result = validateDoc(content, schema, state.scale, isHtml);
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

            // Write the document with correct extension
            const filePath = await writeDoc(project_name, ctx.number, doc_id, content, docDef, ctx.dir);

            // Check if review is required
            const overrides = await getMergedOverrides(project_name);
            const needsReview = docDef ? resolveDocReview(doc_id, docDef, overrides) : false;

            if (needsReview) {
                await submitForReview(project_name, ctx.number, doc_id, ctx.dir);
                const docName = docDef?.name ?? doc_id;
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: [
                                `Document "${doc_id}" (${docName}) written to ${filePath}`,
                                ``,
                                `** REVIEW REQUIRED **`,
                                `This document requires user approval before the workflow can proceed.`,
                                `Please present the document content to the user and ask for their confirmation.`,
                                `After user approval, call doc_approve with project_name="${project_name}" and doc_id="${doc_id}".`,
                                `If the user requests changes, revise the document and call doc_write again.`,
                            ].join('\n'),
                        },
                    ],
                };
            }

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
        'doc_read',
        'Read a project document. By default reads from the active context. Use the optional `context` parameter (e.g. "iter-1", "patch-2") to read from a different context.',
        {
            project_name: z.string().describe('Project name'),
            doc_id: z.string().describe('Document ID to read'),
            context: z
                .string()
                .optional()
                .describe('Context to read from (e.g. "iter-1", "patch-2"). Defaults to active context.'),
        },
        async ({ project_name, doc_id, context }) => {
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

                const docContent = await readDoc(project_name, contextNumber, doc_id, contextDir);
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
                            text: `Document "${doc_id}" not found. Use doc_list to see available documents.`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    );

    server.tool(
        'doc_list',
        'List all project documents. By default lists from the active context. Use the optional `context` parameter (e.g. "iter-1", "patch-2") to list from a different context.',
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

            const docs = await listDocs(project_name, contextNumber, contextDir);
            return {
                content: [
                    {
                        type: 'text' as const,
                        text:
                            docs.length > 0
                                ? `Documents (${contextLabel}):\n${docs.map((d) => `- ${d}`).join('\n')}`
                                : `No documents found for ${contextLabel}.`,
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
    iteration: number,
    docId: string,
    content: string,
    step: string | undefined,
    docDef: DocDefinition,
    scale: ProjectScale,
    contextDir: string,
): Promise<ToolResult> {
    const steps = docDef.steps!;
    const stepIds = steps.map((s) => s.id);
    const stepNames = steps.map((s) => `${s.id} (${s.name})`).join(', ');

    // Guard: step parameter is required in sequential mode
    if (!step) {
        return {
            content: [
                {
                    type: 'text' as const,
                    text: [
                        `文档 "${docId}" 在 ${scale} 规模项目中需要分步写入。`,
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
    const stepState = await getDocStepState(projectName, iteration, docId, contextDir);
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
    const stepSchemaId = `${docId}.${step}`;
    const stepSchema = await loadDocSchema(builtinDir, customDir, workflowName, stepSchemaId);
    if (stepSchema) {
        const result = validateDoc(content, stepSchema, scale, false, isJson);
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
        iteration,
        docId,
        step,
        content,
        stepDef.format,
        contextDir,
    );

    // Record step completion (handles rollback if overwriting)
    await recordStepCompletion(projectName, iteration, docId, step, artifactPath, stepIds, contextDir);

    const isLastStep = stepIndex === steps.length - 1;

    if (isLastStep) {
        // Auto-merge: validate against final doc schema, write formal doc, trigger review
        return handleFinalStep(
            builtinDir,
            customDir,
            workflowName,
            projectName,
            iteration,
            docId,
            content,
            docDef,
            scale,
            stepDef,
            contextDir,
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
                    `请调用 doc_write(project_name="${projectName}", doc_id="${docId}", step="${nextStep.id}", content=...)`,
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
    iteration: number,
    docId: string,
    content: string,
    docDef: DocDefinition,
    scale: ProjectScale,
    stepDef: DocStepDefinition,
    contextDir: string,
): Promise<ToolResult> {
    const isHtml = docDef.format === 'html';

    // Validate against the final document schema (e.g. prd.json)
    const finalSchema = await loadDocSchema(builtinDir, customDir, workflowName, docId);
    if (finalSchema) {
        const isJson = stepDef.format === 'json';
        const result = validateDoc(content, finalSchema, scale, isHtml, isJson);
        if (!result.valid) {
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: [
                            '最终文档校验失败:',
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

    // Write the formal document
    const filePath = await writeDoc(projectName, iteration, docId, content, docDef, contextDir);

    // Mark as finalized
    await markFinalized(projectName, iteration, docId, contextDir);

    // Check if review is required
    const overrides = await getMergedOverrides(projectName);
    const needsReview = resolveDocReview(docId, docDef, overrides);

    if (needsReview) {
        await submitForReview(projectName, iteration, docId, contextDir);
        const docName = docDef.name ?? docId;
        return {
            content: [
                {
                    type: 'text' as const,
                    text: [
                        `所有步骤完成！文档 "${docId}" (${docName}) 已写入 ${filePath}`,
                        ``,
                        `** REVIEW REQUIRED **`,
                        `This document requires user approval before the workflow can proceed.`,
                        `Please present the document content to the user and ask for their confirmation.`,
                        `After user approval, call doc_approve with project_name="${projectName}" and doc_id="${docId}".`,
                        `If the user requests changes, revise the document and call doc_write again with the appropriate step.`,
                    ].join('\n'),
                },
            ],
        };
    }

    return {
        content: [
            {
                type: 'text' as const,
                text: `所有步骤完成！文档 "${docId}" 已写入 ${filePath}`,
            },
        ],
    };
}
