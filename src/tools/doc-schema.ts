/**
 * MCP Tool: doc_schema
 *
 * Query document structure requirements and writing guidance before writing.
 * Returns human-readable schema guidance including required sections/fields,
 * content boundaries, format requirements, and step-by-step constraints.
 *
 * Primarily used by PM (who is not dispatched and thus doesn't receive
 * Document Requirements automatically via role_dispatch).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadWorkflow } from '../core/workflow.js';
import { readState } from '../core/state.js';
import { loadDocSchema, formatSchemaGuidance } from '../core/schema.js';
import type { StepSchemaEntry } from '../core/schema.js';
import { resolveActive, isError } from './utils.js';

export function registerDocSchema(server: McpServer, builtinDir: string, customDir: string): void {
    server.tool(
        'doc_schema',
        'Query document structure requirements and writing guidance. Call this before writing a document to understand required sections, content boundaries, and format constraints. Returns guidance filtered by current project scale.',
        {
            project_name: z.string().describe('Project name'),
            doc_id: z
                .string()
                .describe('Document ID (e.g. prd, user-stories, fsd, prototype, tech-design, task-breakdown, etc.)'),
            step: z
                .string()
                .optional()
                .describe(
                    "Step ID (e.g. requirements, draft, final). If specified, returns only that step's schema. If omitted, returns the full document schema including all steps.",
                ),
        },
        async ({ project_name, doc_id, step }) => {
            try {
                const ctx = await resolveActive(project_name);
                if (isError(ctx)) return ctx;

                const state = await readState(project_name, ctx.number, ctx.dir);
                const wf = await loadWorkflow(builtinDir, customDir, state.workflow);

                // Validate doc_id exists in workflow
                const docDef = wf.definition.docs[doc_id];
                if (!docDef) {
                    const available = Object.keys(wf.definition.docs).join(', ');
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Document "${doc_id}" not found in workflow. Available: ${available}`,
                            },
                        ],
                        isError: true,
                    };
                }

                // Scale must be set for meaningful guidance
                if (!state.scale) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: '项目规模尚未设定，无法提供精确的文档要求。请先调用 project_set_scale 设定规模。',
                            },
                        ],
                        isError: true,
                    };
                }

                const scale = state.scale;

                // If a specific step is requested, return only that step's schema
                if (step) {
                    // Validate step exists in doc definition
                    if (!docDef.steps || !docDef.steps.find((s) => s.id === step)) {
                        const availableSteps = docDef.steps?.map((s) => s.id).join(', ') ?? '(无分步)';
                        return {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: `Step "${step}" not found for document "${doc_id}". Available steps: ${availableSteps}`,
                                },
                            ],
                            isError: true,
                        };
                    }

                    const stepSchema = await loadDocSchema(builtinDir, customDir, state.workflow, `${doc_id}.${step}`);
                    const stepDef = docDef.steps.find((s) => s.id === step)!;

                    const lines: string[] = [];
                    lines.push(`## Step 要求: ${doc_id}.${step}（${stepDef.name}）`);
                    lines.push('');
                    lines.push(`格式: ${stepDef.format === 'json' ? 'JSON' : 'Markdown'}`);
                    lines.push(`描述: ${stepDef.description}`);

                    if (stepSchema) {
                        if (stepSchema.guidance) {
                            lines.push(`内容指引: ${stepSchema.guidance}`);
                        }
                        if (stepSchema.minLength) {
                            lines.push(`最小长度: ${stepSchema.minLength} 字符`);
                        }
                        if (stepSchema.jsonFields) {
                            const reqFields = stepSchema.jsonFields.filter((f) => f.required[scale]);
                            if (reqFields.length > 0) {
                                lines.push('');
                                lines.push('### 必需 JSON 字段');
                                for (const field of reqFields) {
                                    let desc = `- ${field.field}`;
                                    if (field.type) desc += ` (${field.type})`;
                                    if (field.minItems) desc += `, ≥${field.minItems} 项`;
                                    lines.push(desc);
                                }
                            }
                        }
                        if (stepSchema.sections) {
                            const reqSections = stepSchema.sections.filter((s) => s.required[scale]);
                            if (reqSections.length > 0) {
                                lines.push('');
                                lines.push('### 必需章节');
                                for (const section of reqSections) {
                                    const heading = section.heading.replace(/^#+\s*/, '');
                                    lines.push(`- ${heading}`);
                                }
                            }
                        }
                    } else {
                        lines.push('');
                        lines.push('（此 step 无 schema 约束）');
                    }

                    return {
                        content: [{ type: 'text' as const, text: lines.join('\n') }],
                    };
                }

                // Full document schema
                const schema = await loadDocSchema(builtinDir, customDir, state.workflow, doc_id);

                // Load step schemas if doc has steps
                let stepSchemas: StepSchemaEntry[] | undefined;
                if (docDef.steps && docDef.steps.length > 0) {
                    stepSchemas = [];
                    for (const s of docDef.steps) {
                        const stepSchema = await loadDocSchema(
                            builtinDir,
                            customDir,
                            state.workflow,
                            `${doc_id}.${s.id}`,
                        );
                        stepSchemas.push({ step: s, schema: stepSchema });
                    }
                }

                if (!schema && (!stepSchemas || stepSchemas.every((s) => !s.schema))) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `文档 "${doc_id}" 无 schema 定义。`,
                            },
                        ],
                    };
                }

                const guidance = formatSchemaGuidance(doc_id, docDef, schema, scale, stepSchemas);

                return {
                    content: [{ type: 'text' as const, text: guidance }],
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
