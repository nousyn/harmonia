/**
 * MCP Tool: artifact_schema
 *
 * Query artifact structure requirements and writing guidance before writing.
 * Returns human-readable schema guidance including required sections/fields,
 * content boundaries, format requirements, and step-by-step constraints.
 *
 * Primarily used by coordinator (who is not dispatched and thus doesn't receive
 * Artifact Requirements automatically via role_dispatch).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadDocSchema, formatSchemaGuidance, isRequired } from '../core/schema.js';
import type { StepSchemaEntry } from '../core/schema.js';
import { loadWorkflowForContext } from './engine-helpers.js';
import { resolveActive, isError } from './utils.js';

export function registerArtifactSchema(server: McpServer, builtinDir: string, customDir: string): void {
    server.tool(
        'artifact_schema',
        'Query artifact structure requirements and writing guidance. Call this before writing an artifact to understand required sections, content boundaries, and format constraints.',
        {
            project_name: z.string().describe('Project name'),
            artifact_id: z
                .string()
                .describe('Artifact ID (e.g. prd, user-stories, fsd, prototype, tech-design, task-breakdown, etc.)'),
            step: z
                .string()
                .optional()
                .describe(
                    "Step ID (e.g. requirements, draft, final). If specified, returns only that step's schema. If omitted, returns the full artifact schema including all steps.",
                ),
        },
        async ({ project_name, artifact_id, step }) => {
            try {
                const ctx = await resolveActive(project_name);
                if (isError(ctx)) return ctx;

                const { wf, state } = await loadWorkflowForContext(builtinDir, customDir, project_name, ctx);

                // Validate artifact_id exists in workflow
                const artifactDef = wf.artifactDefinitions[artifact_id];
                if (!artifactDef) {
                    const available = Object.keys(wf.artifactDefinitions).join(', ');
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Artifact "${artifact_id}" not found in workflow. Available: ${available}`,
                            },
                        ],
                        isError: true,
                    };
                }

                // If a specific step is requested, return only that step's schema
                if (step) {
                    // Validate step exists in artifact definition
                    if (!artifactDef.steps || !artifactDef.steps.find((s) => s.id === step)) {
                        const availableSteps = artifactDef.steps?.map((s) => s.id).join(', ') ?? '(无分步)';
                        return {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: `Step "${step}" not found for artifact "${artifact_id}". Available steps: ${availableSteps}`,
                                },
                            ],
                            isError: true,
                        };
                    }

                    const stepSchema = await loadDocSchema(builtinDir, customDir, state.workflow, `${artifact_id}.${step}`);
                    const stepDefFound = artifactDef.steps.find((s) => s.id === step)!;

                    const lines: string[] = [];
                    lines.push(`## Step 要求: ${artifact_id}.${step}（${stepDefFound.name}）`);
                    lines.push('');
                    lines.push(`格式: ${stepDefFound.format === 'json' ? 'JSON' : 'Markdown'}`);
                    lines.push(`描述: ${stepDefFound.description}`);

                    if (stepSchema) {
                        if (stepSchema.guidance) {
                            lines.push(`内容指引: ${stepSchema.guidance}`);
                        }
                        if (stepSchema.minLength) {
                            lines.push(`最小长度: ${stepSchema.minLength} 字符`);
                        }
                        if (stepSchema.jsonFields) {
                            const reqFields = stepSchema.jsonFields.filter((f) => isRequired(f.required));
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
                            const reqSections = stepSchema.sections.filter((s) => isRequired(s.required));
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

                // Full artifact schema
                const schema = await loadDocSchema(builtinDir, customDir, state.workflow, artifact_id);

                // Load step schemas if artifact has steps
                let stepSchemas: StepSchemaEntry[] | undefined;
                if (artifactDef.steps && artifactDef.steps.length > 0) {
                    stepSchemas = [];
                    for (const s of artifactDef.steps) {
                        const stepSchema = await loadDocSchema(
                            builtinDir,
                            customDir,
                            state.workflow,
                            `${artifact_id}.${s.id}`,
                        );
                        stepSchemas.push({ step: s, schema: stepSchema });
                    }
                }

                if (!schema && (!stepSchemas || stepSchemas.every((s) => !s.schema))) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Artifact "${artifact_id}" 无 schema 定义。`,
                            },
                        ],
                    };
                }

                const guidance = formatSchemaGuidance(artifact_id, artifactDef, schema, stepSchemas);

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
