/**
 * Tests for P3 Sequential mode.
 * 1. JSON validation in schema.ts (isJson path) — already written above
 * 2. doc_write sequential orchestration via MCP tool calls
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { validateDoc } from '../src/core/schema.js';
import type { DocSchema } from '../src/core/types.js';
import * as registry from '../src/core/registry.js';
import { registerDocTools } from '../src/tools/doc-tools.js';

// ─── JSON Validation (schema.ts isJson path) ───

describe('validateDoc — JSON mode', () => {
    const jsonSchema: DocSchema = {
        jsonFields: [
            { field: 'features', required: { small: true, medium: true, large: true }, type: 'array', minItems: 1 },
            { field: 'constraints', required: { small: false, medium: true, large: true }, type: 'array' },
            { field: 'scope', required: { small: true, medium: true, large: true }, type: 'string' },
            { field: 'priorities', required: { small: false, medium: true, large: true }, type: 'object' },
        ],
    };

    it('should pass with valid JSON and all required fields', () => {
        const content = JSON.stringify({
            features: ['auth', 'dashboard'],
            constraints: ['budget < 50k'],
            scope: 'MVP release',
            priorities: { auth: 'P0' },
        });
        const result = validateDoc(content, jsonSchema, 'medium', false, true);
        expect(result.valid).toBe(true);
    });

    it('should fail on invalid JSON', () => {
        const result = validateDoc('{ broken json }', jsonSchema, 'medium', false, true);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.type === 'invalid_json')).toBe(true);
    });

    it('should fail when required field is missing', () => {
        const content = JSON.stringify({ features: ['auth'], scope: 'test' });
        const result = validateDoc(content, jsonSchema, 'medium', false, true);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.type === 'missing_json_field' && e.message.includes('constraints'))).toBe(
            true,
        );
        expect(result.errors.some((e) => e.type === 'missing_json_field' && e.message.includes('priorities'))).toBe(
            true,
        );
    });

    it('should skip optional fields for small scale', () => {
        const content = JSON.stringify({ features: ['auth'], scope: 'small mvp' });
        const result = validateDoc(content, jsonSchema, 'small', false, true);
        expect(result.valid).toBe(true);
    });

    it('should fail on wrong type', () => {
        const content = JSON.stringify({ features: 'should be array', scope: 'test' });
        const result = validateDoc(content, jsonSchema, 'small', false, true);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.type === 'wrong_json_type')).toBe(true);
    });

    it('should fail on array minItems violation', () => {
        const content = JSON.stringify({ features: [], scope: 'test' });
        const result = validateDoc(content, jsonSchema, 'small', false, true);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.type === 'json_array_too_short')).toBe(true);
    });

    it('should not check markdown sections in JSON mode', () => {
        const mixedSchema: DocSchema = {
            sections: [{ heading: '## Required', required: { small: true, medium: true, large: true } }],
            jsonFields: [{ field: 'data', required: { small: true, medium: true, large: true }, type: 'string' }],
        };
        const result = validateDoc(JSON.stringify({ data: 'hello' }), mixedSchema, 'medium', false, true);
        expect(result.valid).toBe(true);
    });

    it('should still check minLength in JSON mode', () => {
        const s: DocSchema = {
            jsonFields: [{ field: 'x', required: { small: true, medium: true, large: true }, type: 'string' }],
            minLength: 500,
        };
        const result = validateDoc(JSON.stringify({ x: 'short' }), s, 'medium', false, true);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.type === 'content_too_short')).toBe(true);
    });
});

// ─── doc_write Sequential Orchestration (via MCP tool calls) ───

describe('doc_write — sequential mode', () => {
    let tempDir: string;
    let workflowsDir: string;
    let projectDir: string;
    let client: Client;
    let server: McpServer;

    // Valid step content helpers
    const reqJson = JSON.stringify({
        features: ['auth', 'login'],
        constraints: ['budget'],
        scope: 'MVP',
        priorities: { auth: 'P0' },
    });
    const checkJson = JSON.stringify({ coverage: { auth: true }, missing: [], conflicts: [], verdict: 'pass' });
    const draftMd = [
        '# PRD',
        '',
        '## 项目概述',
        '这是一个测试项目的 PRD 文档草稿，包含所有必需的章节信息。',
        '',
        '## 功能需求',
        '1. 用户认证功能',
        '2. 登录功能',
        '',
        '这里需要更多内容来满足最小长度要求。'.repeat(5),
    ].join('\n');
    const finalMd = [
        '# PRD',
        '',
        '## 项目概述',
        '这是一个完整的测试项目 PRD 文档，详细描述了项目的所有需求。',
        '',
        '## 功能需求',
        '1. 用户认证：支持多种认证方式',
        '2. 用户登录：安全的登录流程',
        '',
        '## 非功能需求',
        '- 性能要求：响应时间 < 200ms',
        '',
        '## 验收标准',
        '- 所有功能测试通过',
        '- 代码覆盖率 > 80%',
        '',
        '这里需要更多内容来满足最小长度要求，所以增加一些填充文字。'.repeat(5),
    ].join('\n');

    async function callTool(name: string, args: Record<string, unknown>) {
        const result = await client.callTool({ name, arguments: args });
        const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
        return { text, isError: result.isError ?? false };
    }

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'harmonia-seq-test-'));
        projectDir = join(tempDir, 'test-project');
        workflowsDir = join(tempDir, 'workflows');

        // Setup project data dir
        await mkdir(projectDir, { recursive: true });
        vi.spyOn(registry, 'getProjectDataDir').mockReturnValue(projectDir);
        vi.spyOn(registry, 'getGlobalDir').mockReturnValue(tempDir);

        // Write state.json (medium scale to activate sequential mode)
        await writeFile(
            join(projectDir, 'state.json'),
            JSON.stringify({
                projectName: 'test-project',
                projectDir: '/tmp/src',
                workflow: 'dev',
                scale: 'medium',
                currentPhase: 'requirements',
                phases: [{ id: 'requirements', status: 'in_progress' }],
                createdAt: '2026-01-01T00:00:00Z',
                updatedAt: '2026-01-01T00:00:00Z',
            }),
        );

        // Copy real workflow.json and schemas
        const realWorkflows = join(import.meta.dirname, '..', 'workflows');
        const wfDir = join(workflowsDir, 'dev');
        const schemasDir = join(wfDir, 'schemas');
        const rolesDir = join(wfDir, 'roles');
        await mkdir(schemasDir, { recursive: true });
        await mkdir(rolesDir, { recursive: true });

        // Copy workflow.json
        const wfContent = await readFile(join(realWorkflows, 'dev', 'workflow.json'), 'utf-8');
        await writeFile(join(wfDir, 'workflow.json'), wfContent);

        // Copy schema files we need
        for (const f of [
            'prd.json',
            'prd.requirements.json',
            'prd.completeness-check.json',
            'prd.draft.json',
            'prd.final.json',
        ]) {
            try {
                const c = await readFile(join(realWorkflows, 'dev', 'schemas', f), 'utf-8');
                await writeFile(join(schemasDir, f), c);
            } catch {
                /* skip if not exists */
            }
        }

        // Write a dummy role file (workflow loader needs at least one)
        const realRolesDir = join(realWorkflows, 'dev', 'roles');
        const { readdir } = await import('node:fs/promises');
        const roleFiles = await readdir(realRolesDir);
        for (const rf of roleFiles) {
            const rc = await readFile(join(realRolesDir, rf), 'utf-8');
            await writeFile(join(rolesDir, rf), rc);
        }

        // Setup MCP server + client
        server = new McpServer({ name: 'test', version: '0.0.1' });
        registerDocTools(server, workflowsDir);
        client = new Client({ name: 'test-client', version: '0.0.1' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await client.connect(clientTransport);
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(tempDir, { recursive: true, force: true });
    });

    // --- Tests follow in next part ---

    it('should require step parameter for medium scale doc with steps', async () => {
        const { text, isError } = await callTool('doc_write', {
            project_name: 'test-project',
            doc_id: 'prd',
            content: 'some content',
        });
        expect(isError).toBe(true);
        expect(text).toContain('分步写入');
        expect(text).toContain('step');
    });

    it('should reject unknown step ID', async () => {
        const { text, isError } = await callTool('doc_write', {
            project_name: 'test-project',
            doc_id: 'prd',
            content: 'x',
            step: 'nonexistent',
        });
        expect(isError).toBe(true);
        expect(text).toContain('未知的步骤');
    });

    it('should reject step when prerequisites not met', async () => {
        // Try to write step 2 without completing step 1
        const { text, isError } = await callTool('doc_write', {
            project_name: 'test-project',
            doc_id: 'prd',
            content: checkJson,
            step: 'completeness-check',
        });
        expect(isError).toBe(true);
        expect(text).toContain('前置步骤');
        expect(text).toContain('requirements');
    });

    it('should accept valid first step and return progress', async () => {
        const { text, isError } = await callTool('doc_write', {
            project_name: 'test-project',
            doc_id: 'prd',
            content: reqJson,
            step: 'requirements',
        });
        expect(isError).toBeFalsy();
        expect(text).toContain('requirements');
        expect(text).toContain('完成');
        expect(text).toContain('completeness-check');
    });

    it('should write step artifact file to disk', async () => {
        await callTool('doc_write', {
            project_name: 'test-project',
            doc_id: 'prd',
            content: reqJson,
            step: 'requirements',
        });
        const artifactPath = join(projectDir, 'docs', 'prd.requirements.json');
        const content = await readFile(artifactPath, 'utf-8');
        expect(JSON.parse(content)).toHaveProperty('features');
    });

    it('should reject step with invalid JSON schema', async () => {
        // requirements step expects array field "features" — give it a string
        const badJson = JSON.stringify({ features: 'not-array', scope: 'test' });
        const { text, isError } = await callTool('doc_write', {
            project_name: 'test-project',
            doc_id: 'prd',
            content: badJson,
            step: 'requirements',
        });
        expect(isError).toBe(true);
        expect(text).toContain('校验失败');
    });

    it('should complete all steps and write formal doc', async () => {
        // Step 1
        const r1 = await callTool('doc_write', {
            project_name: 'test-project',
            doc_id: 'prd',
            content: reqJson,
            step: 'requirements',
        });
        expect(r1.isError).toBeFalsy();

        // Step 2
        const r2 = await callTool('doc_write', {
            project_name: 'test-project',
            doc_id: 'prd',
            content: checkJson,
            step: 'completeness-check',
        });
        expect(r2.isError).toBeFalsy();

        // Step 3
        const r3 = await callTool('doc_write', {
            project_name: 'test-project',
            doc_id: 'prd',
            content: draftMd,
            step: 'draft',
        });
        expect(r3.isError).toBeFalsy();

        // Step 4 (final) — should trigger auto-merge + review
        const r4 = await callTool('doc_write', {
            project_name: 'test-project',
            doc_id: 'prd',
            content: finalMd,
            step: 'final',
        });
        expect(r4.isError).toBeFalsy();
        expect(r4.text).toContain('所有步骤完成');
        expect(r4.text).toContain('REVIEW REQUIRED');

        // Formal doc should exist
        const formalDoc = await readFile(join(projectDir, 'docs', 'prd.md'), 'utf-8');
        expect(formalDoc).toContain('项目概述');

        // steps.json should show finalized
        const stepsData = JSON.parse(await readFile(join(projectDir, 'steps.json'), 'utf-8'));
        expect(stepsData.docs.prd.finalized).toBe(true);

        // reviews.json should exist
        const reviewsData = JSON.parse(await readFile(join(projectDir, 'reviews.json'), 'utf-8'));
        expect(reviewsData.docs.prd.status).toBe('pending');
    });

    it('should rollback subsequent steps on overwrite', async () => {
        // Complete steps 1, 2, 3
        await callTool('doc_write', {
            project_name: 'test-project',
            doc_id: 'prd',
            content: reqJson,
            step: 'requirements',
        });
        await callTool('doc_write', {
            project_name: 'test-project',
            doc_id: 'prd',
            content: checkJson,
            step: 'completeness-check',
        });
        await callTool('doc_write', { project_name: 'test-project', doc_id: 'prd', content: draftMd, step: 'draft' });

        // Overwrite step 1 — should rollback steps 2 and 3
        const newReqJson = JSON.stringify({
            features: ['auth', 'login', 'signup'],
            constraints: ['none'],
            scope: 'V2',
            priorities: { auth: 'P0' },
        });
        const r = await callTool('doc_write', {
            project_name: 'test-project',
            doc_id: 'prd',
            content: newReqJson,
            step: 'requirements',
        });
        expect(r.isError).toBeFalsy();

        // Now step 2 should be required again — verify by checking steps.json
        const stepsData = JSON.parse(await readFile(join(projectDir, 'steps.json'), 'utf-8'));
        expect(stepsData.docs.prd.completedSteps).toHaveLength(1);
        expect(stepsData.docs.prd.completedSteps[0].stepId).toBe('requirements');

        // Trying step 3 directly should fail (step 2 not done)
        const r3 = await callTool('doc_write', {
            project_name: 'test-project',
            doc_id: 'prd',
            content: draftMd,
            step: 'draft',
        });
        expect(r3.isError).toBe(true);
        expect(r3.text).toContain('前置步骤');
    });

    it('should skip sequential mode for small scale', async () => {
        // Rewrite state.json with small scale
        await writeFile(
            join(projectDir, 'state.json'),
            JSON.stringify({
                projectName: 'test-project',
                projectDir: '/tmp/src',
                workflow: 'dev',
                scale: 'small',
                currentPhase: 'requirements',
                phases: [{ id: 'requirements', status: 'in_progress' }],
                createdAt: '2026-01-01T00:00:00Z',
                updatedAt: '2026-01-01T00:00:00Z',
            }),
        );

        // Write PRD without step — should succeed (normal mode)
        // prd.json at small scale requires: 项目概述, 功能需求, 验收标准 + minLength 200
        // prd has review: true → success shows REVIEW REQUIRED
        const content = [
            '# PRD',
            '',
            '## 项目概述',
            '一个小型测试项目，用于验证 sequential mode 在 small 规模下不会激活。这是项目的完整概述描述。',
            '',
            '## 功能需求',
            '1. 基本功能：用户注册和账号管理系统',
            '2. 基本功能：用户登录和身份验证功能',
            '3. 高级功能：数据导出与报表生成模块',
            '',
            '## 验收标准',
            '- 所有功能测试通过，单元测试覆盖率达到 80% 以上',
            '- 代码审查通过，无严重缺陷和安全漏洞',
            '- 性能测试满足响应时间要求（< 500ms）',
        ].join('\n');
        const { text, isError } = await callTool('doc_write', {
            project_name: 'test-project',
            doc_id: 'prd',
            content,
        });
        expect(isError).toBeFalsy();
        expect(text).toContain('REVIEW REQUIRED');
    });

    it('should reject final step when formal doc validation fails', async () => {
        // Complete steps 1, 2, 3
        await callTool('doc_write', {
            project_name: 'test-project',
            doc_id: 'prd',
            content: reqJson,
            step: 'requirements',
        });
        await callTool('doc_write', {
            project_name: 'test-project',
            doc_id: 'prd',
            content: checkJson,
            step: 'completeness-check',
        });
        await callTool('doc_write', { project_name: 'test-project', doc_id: 'prd', content: draftMd, step: 'draft' });

        // Step 4 with content that fails step schema (prd.final.json) — missing sections + too short
        const badFinal = '# PRD\n\n## 项目概述\nShort content without required sections.';
        const { text, isError } = await callTool('doc_write', {
            project_name: 'test-project',
            doc_id: 'prd',
            content: badFinal,
            step: 'final',
        });
        expect(isError).toBe(true);
        expect(text).toContain('校验失败');
        expect(text).toContain('功能需求');
    });
});
