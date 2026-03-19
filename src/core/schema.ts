/**
 * Artifact schema loader and validator.
 *
 * Loads schema definitions from the resolved workflow directory's schemas/ subdirectory
 * and validates artifact content against them before writing.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactSchema, ArtifactSchemaSection } from './types.js';
import { resolveWorkflowDir } from './plugin.js';

// ─── Schema Loading ───

/**
 * Load an artifact schema from the workflow's schemas directory.
 * Returns undefined if no schema file exists for this artifact_id.
 *
 * For step schemas, pass a composite id like "prd.requirements".
 */
export async function loadArtifactSchema(
    workflowsDir: string,
    workflowName: string,
    artifactId: string,
): Promise<ArtifactSchema | undefined> {
    const workflowDir = await resolveWorkflowDir(workflowsDir, workflowName);
    const schemaPath = join(workflowDir, 'schemas', `${artifactId}.json`);
    try {
        const raw = await readFile(schemaPath, 'utf-8');
        return JSON.parse(raw) as ArtifactSchema;
    } catch {
        return undefined;
    }
}

// ─── Validation ───

export interface ArtifactValidationError {
    /** Error type */
    type:
        | 'missing_section'
        | 'missing_html_tag'
        | 'content_too_short'
        | 'empty_content'
        | 'missing_json_field'
        | 'invalid_json'
        | 'wrong_json_type'
        | 'json_array_too_short';
    /** Human-readable message */
    message: string;
}

export interface ValidationResult {
    valid: boolean;
    errors: ArtifactValidationError[];
}

/**
 * Normalize a heading string for comparison.
 * Strips leading #'s and whitespace, lowercases.
 */
function normalizeHeading(heading: string): string {
    return heading
        .replace(/^#+\s*/, '')
        .trim()
        .toLowerCase();
}

/**
 * Extract the heading level (number of #) from a heading string.
 */
function headingLevel(heading: string): number {
    const match = heading.match(/^(#+)/);
    return match ? match[1].length : 0;
}

/**
 * Extract all headings from markdown content.
 * Returns array of raw heading lines (e.g. "## 项目概述").
 */
function extractHeadings(content: string): string[] {
    const lines = content.split('\n');
    return lines.filter((line) => /^#{1,6}\s+/.test(line.trim()));
}

/**
 * Check if a required section is present in the document headings.
 * Matches primary heading or any alias, with level-aware + normalized comparison.
 */
function sectionPresent(section: ArtifactSchemaSection, headings: string[]): boolean {
    const candidates = [section.heading, ...(section.aliases ?? [])];
    const level = headingLevel(section.heading);

    for (const candidate of candidates) {
        const candidateNorm = normalizeHeading(candidate);
        const candidateLevel = headingLevel(candidate) || level;

        for (const h of headings) {
            if (headingLevel(h) === candidateLevel && normalizeHeading(h) === candidateNorm) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Validate artifact content against a schema.
 *
 * @param content  - Artifact content (markdown, HTML, or JSON)
 * @param schema   - Schema definition
 * @param isHtml   - Whether the artifact is HTML format
 * @param isJson   - Whether the artifact is JSON format (for step artifacts)
 */
export function validateArtifact(
    content: string,
    schema: ArtifactSchema,
    isHtml: boolean = false,
    isJson: boolean = false,
): ValidationResult {
    const errors: ArtifactValidationError[] = [];

    // Empty content check
    const trimmed = content.trim();
    if (!trimmed) {
        return {
            valid: false,
            errors: [{ type: 'empty_content', message: '文档内容为空' }],
        };
    }

    // Minimum length check
    if (schema.minLength && trimmed.length < schema.minLength) {
        errors.push({
            type: 'content_too_short',
            message: `文档内容过短（${trimmed.length} 字符），最少需要 ${schema.minLength} 字符`,
        });
    }

    // Markdown section checks
    if (schema.sections && !isHtml && !isJson) {
        const headings = extractHeadings(content);

        for (const section of schema.sections) {
            if (section.required && !sectionPresent(section, headings)) {
                const aliasList = section.aliases?.length ? `（或: ${section.aliases.join(', ')}）` : '';
                errors.push({
                    type: 'missing_section',
                    message: `缺少必需章节: ${section.heading}${aliasList}`,
                });
            }
        }
    }

    // HTML tag checks
    if (schema.htmlTags && isHtml) {
        for (const tag of schema.htmlTags) {
            // Check for opening tag (case-insensitive)
            const regex = new RegExp(`<${tag}[\\s>]`, 'i');
            if (!regex.test(content)) {
                errors.push({
                    type: 'missing_html_tag',
                    message: `缺少必需的 HTML 标签: <${tag}>`,
                });
            }
        }
    }

    // JSON field checks
    if (schema.jsonFields && isJson) {
        let parsed: Record<string, unknown> | null = null;
        try {
            parsed = JSON.parse(content) as Record<string, unknown>;
        } catch {
            errors.push({
                type: 'invalid_json',
                message: '内容不是合法的 JSON 格式',
            });
        }

        if (parsed) {
            for (const fieldDef of schema.jsonFields) {
                if (!fieldDef.required) continue;

                const value = parsed[fieldDef.field];

                if (value === undefined || value === null) {
                    errors.push({
                        type: 'missing_json_field',
                        message: `缺少必需的 JSON 字段: "${fieldDef.field}"`,
                    });
                    continue;
                }

                // Type check
                if (fieldDef.type) {
                    const actualType = Array.isArray(value) ? 'array' : typeof value;
                    if (actualType !== fieldDef.type) {
                        errors.push({
                            type: 'wrong_json_type',
                            message: `字段 "${fieldDef.field}" 类型错误: 期望 ${fieldDef.type}，实际 ${actualType}`,
                        });
                        continue;
                    }
                }

                // Array minItems check
                if (fieldDef.minItems && Array.isArray(value) && value.length < fieldDef.minItems) {
                    errors.push({
                        type: 'json_array_too_short',
                        message: `字段 "${fieldDef.field}" 数组元素过少: 最少 ${fieldDef.minItems} 个，实际 ${value.length} 个`,
                    });
                }
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}

// ─── Schema Guidance ───

/**
 * Step schema entry for formatSchemaGuidance.
 * Each entry pairs a step definition with its loaded schema (if any).
 */
export interface StepSchemaEntry {
    step: { id: string; name: string; format: 'json' | 'md'; description: string };
    schema: ArtifactSchema | undefined;
}

/**
 * Format an artifact schema into human-readable writing guidance.
 *
 * Used by:
 * - role_dispatch: inject Artifact Requirements into the dispatch data package
 * - artifact_schema tool: return guidance on demand for coordinator
 *
 * @param artifactId    Artifact ID (e.g. "prd", "tech-design")
 * @param artifactDef   Artifact definition from workflow.json
 * @param schema        Main artifact schema (may be undefined if no schema file exists)
 * @param stepSchemas   Step schemas (only relevant when artifact has steps)
 */
export function formatSchemaGuidance(
    artifactId: string,
    artifactDef: { name: string; format?: 'md' | 'html' | 'json' },
    schema: ArtifactSchema | undefined,
    stepSchemas?: StepSchemaEntry[],
): string {
    const lines: string[] = [];

    lines.push(`## 文档要求: ${artifactDef.name} (${artifactId})`);
    lines.push('');

    // Format
    const format = artifactDef.format === 'html' ? 'HTML' : artifactDef.format === 'json' ? 'JSON' : 'Markdown';
    lines.push(`格式: ${format}`);

    // Min length
    if (schema?.minLength) {
        lines.push(`最小长度: ${schema.minLength} 字符`);
    }

    // Guidance
    if (schema?.guidance) {
        lines.push(`内容指引: ${schema.guidance}`);
    }

    // Required sections (markdown docs)
    if (schema?.sections) {
        const required = schema.sections.filter((s) => s.required);
        if (required.length > 0) {
            lines.push('');
            lines.push('### 必需章节');
            for (const section of required) {
                // Strip leading ## from heading for display
                const heading = section.heading.replace(/^#+\s*/, '');
                lines.push(`- ${heading}`);
            }
        }
    }

    // Required HTML tags
    if (schema?.htmlTags && schema.htmlTags.length > 0) {
        lines.push('');
        lines.push('### 必需 HTML 标签');
        for (const tag of schema.htmlTags) {
            lines.push(`- <${tag}>`);
        }
    }

    // Required JSON fields (for top-level JSON docs without steps)
    if (schema?.jsonFields) {
        const required = schema.jsonFields.filter((f) => f.required);
        if (required.length > 0) {
            lines.push('');
            lines.push('### 必需 JSON 字段');
            for (const field of required) {
                let desc = `- ${field.field}`;
                if (field.type) desc += ` (${field.type})`;
                if (field.minItems) desc += `, ≥${field.minItems} 项`;
                lines.push(desc);
            }
        }
    }

    // Step schemas
    if (stepSchemas && stepSchemas.length > 0) {
        lines.push('');
        lines.push('### 分步写入');
        for (let i = 0; i < stepSchemas.length; i++) {
            const { step, schema: stepSchema } = stepSchemas[i];
            const formatLabel = step.format === 'json' ? 'JSON 格式' : 'Markdown 格式';
            lines.push(`${i + 1}. ${step.id}（${step.name}）— ${formatLabel}`);

            if (stepSchema) {
                // Step-level required JSON fields
                if (stepSchema.jsonFields) {
                    const reqFields = stepSchema.jsonFields.filter((f) => f.required);
                    if (reqFields.length > 0) {
                        const fieldDescs = reqFields.map((f) => {
                            let d = f.field;
                            if (f.type) d += ` (${f.type})`;
                            if (f.minItems) d += `, ≥${f.minItems} 项`;
                            return d;
                        });
                        lines.push(`   必需字段: ${fieldDescs.join(', ')}`);
                    }
                }

                // Step-level required sections
                if (stepSchema.sections) {
                    const reqSections = stepSchema.sections.filter((s) => s.required);
                    if (reqSections.length > 0) {
                        const sectionNames = reqSections.map((s) => s.heading.replace(/^#+\s*/, ''));
                        lines.push(`   必需章节: ${sectionNames.join(', ')}`);
                    }
                }

                // Step-level min length
                if (stepSchema.minLength) {
                    lines.push(`   最小长度: ${stepSchema.minLength} 字符`);
                }

                // Step-level guidance
                if (stepSchema.guidance) {
                    lines.push(`   指引: ${stepSchema.guidance}`);
                }
            }
        }
    }

    return lines.join('\n');
}

/**
 * Format validation errors into a human-readable string for tool response.
 */
export function formatValidationErrors(errors: ArtifactValidationError[]): string {
    const lines = ['文档校验失败，请修正后重新提交：', ''];
    for (const err of errors) {
        lines.push(`- ${err.message}`);
    }
    return lines.join('\n');
}
