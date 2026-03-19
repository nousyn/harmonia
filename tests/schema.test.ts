import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateArtifact, loadArtifactSchema, formatValidationErrors } from '../src/core/schema.js';
import type { ArtifactSchema } from '../src/core/types.js';

// ─── validateArtifact tests ───

describe('validateArtifact', () => {
    const prdSchema: ArtifactSchema = {
        sections: [
            {
                heading: '## 项目概述',
                required: true,
                aliases: ['## Project Overview', '## 概述'],
            },
            {
                heading: '## 功能需求',
                required: true,
                aliases: ['## Functional Requirements'],
            },
            {
                heading: '## 非功能需求',
                required: true,
                aliases: ['## Non-Functional Requirements'],
            },
        ],
        minLength: 100,
    };

    it('should pass validation when all required sections present', () => {
        const content = [
            '# PRD',
            '',
            '## 项目概述',
            '这是一个测试项目，用于验证 schema 校验功能。',
            '',
            '## 功能需求',
            '1. 功能一：用户注册',
            '2. 功能二：用户登录',
            '',
            '## 非功能需求',
            '- 性能：响应时间 < 200ms',
            '',
            '这里有更多内容来满足最小长度要求...',
        ].join('\n');

        const result = validateArtifact(content, prdSchema);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it('should fail when required sections are missing', () => {
        const content = [
            '# PRD',
            '',
            '## 项目概述',
            '这是一个测试项目。这里需要更多的内容来满足最小长度的要求，所以写多一些文字在这里。',
            '',
            '其他内容...',
            '更多填充内容来满足长度要求...',
        ].join('\n');

        const result = validateArtifact(content, prdSchema);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.type === 'missing_section' && e.message.includes('功能需求'))).toBe(true);
        expect(result.errors.some((e) => e.type === 'missing_section' && e.message.includes('非功能需求'))).toBe(true);
    });

    it('should accept aliases for section headings', () => {
        const content = [
            '# PRD',
            '',
            '## Project Overview',
            'A test project for schema validation.',
            '',
            '## Functional Requirements',
            '1. Feature A',
            '2. Feature B',
            '',
            '## Non-Functional Requirements',
            '- Performance: < 200ms response time',
            '',
            'More content here to meet the minimum length requirement for the schema validator...',
        ].join('\n');

        const result = validateArtifact(content, prdSchema);
        expect(result.valid).toBe(true);
    });

    it('should skip non-required sections', () => {
        const optionalSchema: ArtifactSchema = {
            sections: [
                {
                    heading: '## 项目概述',
                    required: true,
                    aliases: ['## Project Overview', '## 概述'],
                },
                {
                    heading: '## 功能需求',
                    required: true,
                    aliases: ['## Functional Requirements'],
                },
                {
                    heading: '## 非功能需求',
                    required: false,
                    aliases: ['## Non-Functional Requirements'],
                },
            ],
            minLength: 100,
        };

        const content = [
            '# PRD',
            '',
            '## 项目概述',
            '这是一个小型测试项目，主要用于验证文档 schema 校验功能是否能够正确地根据项目规模跳过可选的章节。',
            '',
            '## 功能需求',
            '1. 简单功能：用户可以创建和管理文档',
            '2. 另一个功能：支持多种文档格式的导出',
        ].join('\n');

        // 非功能需求 is not required, so it should be skipped
        const result = validateArtifact(content, optionalSchema);
        expect(result.valid).toBe(true);
    });

    it('should fail on empty content', () => {
        const result = validateArtifact('', prdSchema);
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].type).toBe('empty_content');
    });

    it('should fail on whitespace-only content', () => {
        const result = validateArtifact('   \n\n  \t  ', prdSchema);
        expect(result.valid).toBe(false);
        expect(result.errors[0].type).toBe('empty_content');
    });

    it('should fail when content is too short', () => {
        const content = '## 项目概述\n## 功能需求\nShort.';
        const result = validateArtifact(content, prdSchema);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.type === 'content_too_short')).toBe(true);
    });

    // ─── HTML validation ───

    it('should validate HTML tags', () => {
        const htmlSchema: ArtifactSchema = {
            htmlTags: ['html', 'body'],
            minLength: 50,
        };

        const validHtml =
            '<html>\n<head><title>Prototype</title></head>\n<body>\n<h1>Hello</h1>\n<p>Content here</p>\n</body>\n</html>';
        const result = validateArtifact(validHtml, htmlSchema, true);
        expect(result.valid).toBe(true);
    });

    it('should fail when required HTML tags are missing', () => {
        const htmlSchema: ArtifactSchema = {
            htmlTags: ['html', 'body', 'nav'],
            minLength: 50,
        };

        const html =
            '<html>\n<head><title>Test</title></head>\n<body>\n<h1>Hello</h1>\n<p>No nav here</p>\n</body>\n</html>';
        const result = validateArtifact(html, htmlSchema, true);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.type === 'missing_html_tag' && e.message.includes('<nav>'))).toBe(true);
    });

    it('should not check markdown sections for HTML documents', () => {
        const schema: ArtifactSchema = {
            sections: [
                {
                    heading: '## 项目概述',
                    required: true,
                },
            ],
            htmlTags: ['html', 'body'],
            minLength: 50,
        };

        const html =
            '<html>\n<head><title>Test</title></head>\n<body>\n<h1>No markdown headings</h1>\n</body>\n</html>';
        const result = validateArtifact(html, schema, true);
        expect(result.valid).toBe(true);
    });

    // ─── Heading level matching ───

    it('should match heading levels correctly', () => {
        const schema: ArtifactSchema = {
            sections: [
                {
                    heading: '## 设计',
                    required: true,
                },
            ],
        };

        // ### 设计 should NOT match ## 设计 (different level)
        const content = '### 设计\n内容内容内容...';
        const result = validateArtifact(content, schema);
        expect(result.valid).toBe(false);
    });

    it('should match headings case-insensitively', () => {
        const schema: ArtifactSchema = {
            sections: [
                {
                    heading: '## API Design',
                    required: true,
                    aliases: ['## Api design'],
                },
            ],
        };

        const content = '## api design\nSome content here...';
        const result = validateArtifact(content, schema);
        expect(result.valid).toBe(true);
    });
});

// ─── loadArtifactSchema tests ───

describe('loadArtifactSchema', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'harmonia-schema-test-'));
        await mkdir(join(tempDir, 'dev', 'schemas'), { recursive: true });
        // resolveWorkflowDir checks for workflow.json existence
        await writeFile(join(tempDir, 'dev', 'workflow.json'), JSON.stringify({ name: 'dev', description: 'test' }));
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    it('should load a schema file', async () => {
        const schema: ArtifactSchema = {
            sections: [
                {
                    heading: '## Test',
                    required: true,
                },
            ],
            minLength: 50,
        };
        await writeFile(join(tempDir, 'dev', 'schemas', 'test-doc.json'), JSON.stringify(schema));

        const loaded = await loadArtifactSchema(tempDir, 'dev', 'test-doc');
        expect(loaded).toEqual(schema);
    });

    it('should return undefined for non-existent schema', async () => {
        const loaded = await loadArtifactSchema(tempDir, 'dev', 'nonexistent');
        expect(loaded).toBeUndefined();
    });
});

// ─── formatValidationErrors tests ───

describe('formatValidationErrors', () => {
    it('should format error list', () => {
        const result = formatValidationErrors([
            { type: 'missing_section', message: '缺少必需章节: ## 功能需求' },
            { type: 'content_too_short', message: '文档内容过短（50 字符），最少需要 100 字符' },
        ]);

        expect(result).toContain('文档校验失败');
        expect(result).toContain('缺少必需章节: ## 功能需求');
        expect(result).toContain('文档内容过短');
    });
});
