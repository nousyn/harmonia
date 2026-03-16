import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateDoc, loadDocSchema, formatValidationErrors } from '../src/core/schema.js';
import type { DocSchema } from '../src/core/types.js';

// ─── validateDoc tests ───

describe('validateDoc', () => {
    const prdSchema: DocSchema = {
        sections: [
            {
                heading: '## 项目概述',
                required: { small: true, medium: true, large: true },
                aliases: ['## Project Overview', '## 概述'],
            },
            {
                heading: '## 功能需求',
                required: { small: true, medium: true, large: true },
                aliases: ['## Functional Requirements'],
            },
            {
                heading: '## 非功能需求',
                required: { small: false, medium: true, large: true },
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

        const result = validateDoc(content, prdSchema, 'medium');
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

        const result = validateDoc(content, prdSchema, 'medium');
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

        const result = validateDoc(content, prdSchema, 'large');
        expect(result.valid).toBe(true);
    });

    it('should skip optional sections for small scale', () => {
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

        // small scale: 非功能需求 is not required
        const result = validateDoc(content, prdSchema, 'small');
        expect(result.valid).toBe(true);
    });

    it('should fail on empty content', () => {
        const result = validateDoc('', prdSchema, 'medium');
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].type).toBe('empty_content');
    });

    it('should fail on whitespace-only content', () => {
        const result = validateDoc('   \n\n  \t  ', prdSchema, 'medium');
        expect(result.valid).toBe(false);
        expect(result.errors[0].type).toBe('empty_content');
    });

    it('should fail when content is too short', () => {
        const content = '## 项目概述\n## 功能需求\nShort.';
        const result = validateDoc(content, prdSchema, 'small');
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.type === 'content_too_short')).toBe(true);
    });

    // ─── HTML validation ───

    it('should validate HTML tags', () => {
        const htmlSchema: DocSchema = {
            htmlTags: ['html', 'body'],
            minLength: 50,
        };

        const validHtml =
            '<html>\n<head><title>Prototype</title></head>\n<body>\n<h1>Hello</h1>\n<p>Content here</p>\n</body>\n</html>';
        const result = validateDoc(validHtml, htmlSchema, 'medium', true);
        expect(result.valid).toBe(true);
    });

    it('should fail when required HTML tags are missing', () => {
        const htmlSchema: DocSchema = {
            htmlTags: ['html', 'body', 'nav'],
            minLength: 50,
        };

        const html =
            '<html>\n<head><title>Test</title></head>\n<body>\n<h1>Hello</h1>\n<p>No nav here</p>\n</body>\n</html>';
        const result = validateDoc(html, htmlSchema, 'medium', true);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.type === 'missing_html_tag' && e.message.includes('<nav>'))).toBe(true);
    });

    it('should not check markdown sections for HTML documents', () => {
        const schema: DocSchema = {
            sections: [
                {
                    heading: '## 项目概述',
                    required: { small: true, medium: true, large: true },
                },
            ],
            htmlTags: ['html', 'body'],
            minLength: 50,
        };

        const html =
            '<html>\n<head><title>Test</title></head>\n<body>\n<h1>No markdown headings</h1>\n</body>\n</html>';
        const result = validateDoc(html, schema, 'medium', true);
        expect(result.valid).toBe(true);
    });

    // ─── Heading level matching ───

    it('should match heading levels correctly', () => {
        const schema: DocSchema = {
            sections: [
                {
                    heading: '## 设计',
                    required: { small: true, medium: true, large: true },
                },
            ],
        };

        // ### 设计 should NOT match ## 设计 (different level)
        const content = '### 设计\n内容内容内容...';
        const result = validateDoc(content, schema, 'small');
        expect(result.valid).toBe(false);
    });

    it('should match headings case-insensitively', () => {
        const schema: DocSchema = {
            sections: [
                {
                    heading: '## API Design',
                    required: { small: true, medium: true, large: true },
                    aliases: ['## Api design'],
                },
            ],
        };

        const content = '## api design\nSome content here...';
        const result = validateDoc(content, schema, 'small');
        expect(result.valid).toBe(true);
    });
});

// ─── loadDocSchema tests ───

describe('loadDocSchema', () => {
    let tempDir: string;
    const NO_CUSTOM_DIR = '/nonexistent-custom-workflows';

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
        const schema: DocSchema = {
            sections: [
                {
                    heading: '## Test',
                    required: { small: true, medium: true, large: true },
                },
            ],
            minLength: 50,
        };
        await writeFile(join(tempDir, 'dev', 'schemas', 'test-doc.json'), JSON.stringify(schema));

        const loaded = await loadDocSchema(tempDir, NO_CUSTOM_DIR, 'dev', 'test-doc');
        expect(loaded).toEqual(schema);
    });

    it('should return undefined for non-existent schema', async () => {
        const loaded = await loadDocSchema(tempDir, NO_CUSTOM_DIR, 'dev', 'nonexistent');
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
