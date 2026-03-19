import { describe, it, expect } from 'vitest';
import { formatSchemaGuidance } from '../src/core/schema.js';
import type { StepSchemaEntry } from '../src/core/schema.js';
import type { ArtifactSchema } from '../src/core/types.js';

describe('formatSchemaGuidance', () => {
    // ─── Basic output ───

    it('should include doc name and ID in header', () => {
        const result = formatSchemaGuidance('prd', { name: '需求文档' }, undefined);
        expect(result).toContain('## 文档要求: 需求文档 (prd)');
    });

    it('should show Markdown format by default', () => {
        const result = formatSchemaGuidance('prd', { name: '需求文档' }, undefined);
        expect(result).toContain('格式: Markdown');
    });

    it('should show HTML format when specified', () => {
        const result = formatSchemaGuidance('prototype', { name: '高保真原型', format: 'html' }, undefined);
        expect(result).toContain('格式: HTML');
    });

    // ─── Schema fields ───

    it('should show minLength when present', () => {
        const schema: ArtifactSchema = { minLength: 200 };
        const result = formatSchemaGuidance('prd', { name: '需求文档' }, schema);
        expect(result).toContain('最小长度: 200 字符');
    });

    it('should show guidance when present', () => {
        const schema: ArtifactSchema = {
            guidance: 'PRD 描述产品需求（做什么），不涉及技术实现（怎么做）。',
        };
        const result = formatSchemaGuidance('prd', { name: '需求文档' }, schema);
        expect(result).toContain('内容指引: PRD 描述产品需求（做什么），不涉及技术实现（怎么做）。');
    });

    it('should not show guidance when absent', () => {
        const schema: ArtifactSchema = { minLength: 100 };
        const result = formatSchemaGuidance('prd', { name: '需求文档' }, schema);
        expect(result).not.toContain('内容指引');
    });

    // ─── Section filtering ───

    it('should list required sections', () => {
        const schema: ArtifactSchema = {
            sections: [
                {
                    heading: '## 项目概述',
                    required: true,
                },
                {
                    heading: '## 非功能需求',
                    required: false,
                },
                {
                    heading: '## 约束与假设',
                    required: true,
                },
            ],
        };

        const result = formatSchemaGuidance('prd', { name: '需求文档' }, schema);
        expect(result).toContain('- 项目概述');
        expect(result).not.toContain('- 非功能需求');
        expect(result).toContain('- 约束与假设');
    });

    it('should strip heading markers from section names', () => {
        const schema: ArtifactSchema = {
            sections: [
                {
                    heading: '## 项目概述',
                    required: true,
                },
            ],
        };

        const result = formatSchemaGuidance('prd', { name: '需求文档' }, schema);
        expect(result).toContain('- 项目概述');
        expect(result).not.toContain('- ## 项目概述');
    });

    // ─── HTML tags ───

    it('should list required HTML tags', () => {
        const schema: ArtifactSchema = {
            htmlTags: ['html', 'body', 'nav'],
        };
        const result = formatSchemaGuidance('prototype', { name: '高保真原型', format: 'html' }, schema);
        expect(result).toContain('### 必需 HTML 标签');
        expect(result).toContain('- <html>');
        expect(result).toContain('- <body>');
        expect(result).toContain('- <nav>');
    });

    // ─── JSON fields ───

    it('should list required JSON fields', () => {
        const schema: ArtifactSchema = {
            jsonFields: [
                { field: 'features', required: true, type: 'array', minItems: 1 },
                { field: 'constraints', required: false, type: 'array' },
                { field: 'scope', required: true, type: 'string' },
            ],
        };

        const result = formatSchemaGuidance('prd.requirements', { name: '需求结构化' }, schema);
        expect(result).toContain('- features (array), ≥1 项');
        expect(result).toContain('- scope (string)');
        expect(result).not.toContain('- constraints');
    });

    // ─── Step schemas ───

    it('should show step schemas', () => {
        const schema: ArtifactSchema = {
            minLength: 200,
            guidance: 'PRD 描述产品需求。',
        };

        const stepSchemas: StepSchemaEntry[] = [
            {
                step: { id: 'requirements', name: '需求结构化', format: 'json', description: '结构化需求' },
                schema: {
                    jsonFields: [
                        {
                            field: 'features',
                            required: true,
                            type: 'array',
                            minItems: 1,
                        },
                    ],
                    guidance: '只提取需求信息，不做技术分析。',
                },
            },
            {
                step: { id: 'draft', name: 'PRD 草稿', format: 'md', description: '生成草稿' },
                schema: {
                    sections: [
                        {
                            heading: '## 项目概述',
                            required: true,
                        },
                    ],
                    minLength: 150,
                },
            },
        ];

        const result = formatSchemaGuidance('prd', { name: '需求文档' }, schema, stepSchemas);

        expect(result).toContain('分步写入');
        expect(result).toContain('1. requirements（需求结构化）— JSON 格式');
        expect(result).toContain('必需字段: features (array), ≥1 项');
        expect(result).toContain('指引: 只提取需求信息，不做技术分析。');
        expect(result).toContain('2. draft（PRD 草稿）— Markdown 格式');
        expect(result).toContain('必需章节: 项目概述');
        expect(result).toContain('最小长度: 150 字符');
    });

    it('should show step schemas with no schema for step', () => {
        const stepSchemas: StepSchemaEntry[] = [
            {
                step: { id: 'analysis', name: '架构分析', format: 'json', description: '分析' },
                schema: undefined,
            },
        ];

        const result = formatSchemaGuidance('tech-design', { name: '技术方案' }, undefined, stepSchemas);
        expect(result).toContain('分步写入');
        expect(result).toContain('1. analysis（架构分析）— JSON 格式');
    });

    it('should handle step with no schema gracefully', () => {
        const stepSchemas: StepSchemaEntry[] = [
            {
                step: { id: 'custom', name: '自定义步骤', format: 'md', description: '描述' },
                schema: undefined,
            },
        ];

        const result = formatSchemaGuidance('test-doc', { name: '测试文档' }, undefined, stepSchemas);
        expect(result).toContain('1. custom（自定义步骤）— Markdown 格式');
        // Should not crash, just no sub-fields listed
        expect(result).not.toContain('必需字段');
        expect(result).not.toContain('必需章节');
    });

    // ─── Edge cases ───

    it('should handle undefined schema gracefully', () => {
        const result = formatSchemaGuidance('test-doc', { name: '测试文档' }, undefined);
        expect(result).toContain('## 文档要求: 测试文档 (test-doc)');
        expect(result).toContain('格式: Markdown');
        expect(result).not.toContain('最小长度');
        expect(result).not.toContain('内容指引');
        expect(result).not.toContain('必需章节');
    });

    it('should handle schema with no required sections', () => {
        const schema: ArtifactSchema = {
            sections: [
                {
                    heading: '## 高级功能',
                    required: false,
                },
            ],
        };

        const result = formatSchemaGuidance('doc', { name: '文档' }, schema);
        // No "必需章节" header when nothing is required
        expect(result).not.toContain('### 必需章节');
    });

    it('should handle empty step schemas array', () => {
        const result = formatSchemaGuidance('doc', { name: '文档' }, undefined, []);
        expect(result).not.toContain('分步写入');
    });
});
