/**
 * Document schema loader and validator.
 *
 * Loads schema definitions from workflows/<name>/schemas/<docId>.json
 * and validates document content against them before writing.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DocSchema, DocSchemaSection, ProjectScale } from './types.js';

// ─── Schema Loading ───

/**
 * Load a document schema from the workflow's schemas directory.
 * Returns undefined if no schema file exists for this doc_id.
 *
 * For step schemas, pass a composite id like "prd.requirements".
 */
export async function loadDocSchema(
    workflowsDir: string,
    workflowName: string,
    docId: string,
): Promise<DocSchema | undefined> {
    const schemaPath = join(workflowsDir, workflowName, 'schemas', `${docId}.json`);
    try {
        const raw = await readFile(schemaPath, 'utf-8');
        return JSON.parse(raw) as DocSchema;
    } catch {
        return undefined;
    }
}

// ─── Validation ───

export interface ValidationError {
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
    errors: ValidationError[];
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
function sectionPresent(section: DocSchemaSection, headings: string[]): boolean {
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
 * Validate document content against a schema.
 *
 * @param content  - Document content (markdown, HTML, or JSON)
 * @param schema   - Schema definition
 * @param scale    - Project scale (affects which sections are required)
 * @param isHtml   - Whether the document is HTML format
 * @param isJson   - Whether the document is JSON format (for step artifacts)
 */
export function validateDoc(
    content: string,
    schema: DocSchema,
    scale: ProjectScale,
    isHtml: boolean = false,
    isJson: boolean = false,
): ValidationResult {
    const errors: ValidationError[] = [];

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
            const isRequired = section.required[scale];
            if (isRequired && !sectionPresent(section, headings)) {
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
                const isRequired = fieldDef.required[scale];
                if (!isRequired) continue;

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

/**
 * Format validation errors into a human-readable string for tool response.
 */
export function formatValidationErrors(errors: ValidationError[]): string {
    const lines = ['文档校验失败，请修正后重新提交：', ''];
    for (const err of errors) {
        lines.push(`- ${err.message}`);
    }
    return lines.join('\n');
}
