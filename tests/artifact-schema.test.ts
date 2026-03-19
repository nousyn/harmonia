/**
 * Tests for the artifact_schema MCP tool.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as registry from '../src/core/registry.js';
import { registerArtifactSchema } from '../src/tools/artifact-schema.js';

describe('artifact_schema tool', () => {
    let tempDir: string;
    let workflowsDir: string;
    let noCustomDir: string;
    let iterDir: string;
    let client: Client;
    let server: McpServer;

    const ITER = 1;

    async function callTool(name: string, args: Record<string, unknown>) {
        const result = await client.callTool({ name, arguments: args });
        const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
        return { text, isError: result.isError ?? false };
    }

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'harmonia-doc-schema-test-'));
        const projectDir = join(tempDir, 'test-project');
        iterDir = join(projectDir, `iter-${ITER}`);
        workflowsDir = join(tempDir, 'workflows');
        noCustomDir = join(tempDir, 'no-custom-workflows');

        // Setup iteration data dir
        await mkdir(join(iterDir, 'artifacts'), { recursive: true });
        vi.spyOn(registry, 'getIterationDir').mockReturnValue(iterDir);
        vi.spyOn(registry, 'getProjectDataDir').mockReturnValue(projectDir);
        vi.spyOn(registry, 'getGlobalDir').mockReturnValue(tempDir);
        vi.spyOn(registry, 'resolveContextDir').mockReturnValue({ dir: iterDir, type: 'iteration', number: ITER });
        vi.spyOn(registry, 'getProject').mockResolvedValue({
            dir: '/tmp/src',
            workflow: 'dev',
            createdAt: '2026-01-01T00:00:00Z',
            currentIteration: ITER,
            totalIterations: ITER,
            currentPatch: 0,
            totalPatches: 0,
            activeContext: 'iter-1',
        });

        // Write state.json (node-based format)
        await writeFile(
            join(iterDir, 'state.json'),
            JSON.stringify({
                projectName: 'test-project',
                workflow: 'dev',
                type: 'iteration',
                iteration: ITER,
                nodes: {},
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

        // Copy all schema files
        const realSchemasDir = join(realWorkflows, 'dev', 'schemas');
        const schemaFiles = await readdir(realSchemasDir);
        for (const f of schemaFiles) {
            const c = await readFile(join(realSchemasDir, f), 'utf-8');
            await writeFile(join(schemasDir, f), c);
        }

        // Copy role files (workflow loader needs them)
        const realRolesDir = join(realWorkflows, 'dev', 'roles');
        const roleFiles = await readdir(realRolesDir);
        for (const rf of roleFiles) {
            const c = await readFile(join(realRolesDir, rf), 'utf-8');
            await writeFile(join(rolesDir, rf), c);
        }

        // Create MCP server + client
        server = new McpServer({ name: 'test', version: '0.0.1' });
        registerArtifactSchema(server, workflowsDir, noCustomDir);

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        client = new Client({ name: 'test-client', version: '0.0.1' });
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(tempDir, { recursive: true, force: true });
    });

    // ─── Basic queries ───

    it('should return full artifact schema for prd', async () => {
        const { text, isError } = await callTool('artifact_schema', {
            project_name: 'test-project',
            artifact_id: 'prd',
        });

        expect(isError).toBe(false);
        expect(text).toContain('文档要求: 需求文档 (prd)');
        expect(text).toContain('格式: Markdown');
        expect(text).toContain('最小长度: 200 字符');
        expect(text).toContain('内容指引');
        // should list required sections
        expect(text).toContain('项目概述');
        expect(text).toContain('功能需求');
        expect(text).toContain('非功能需求');
        // should show step schemas
        expect(text).toContain('分步写入');
        expect(text).toContain('requirements');
    });

    it('should return schema for tech-design', async () => {
        const { text, isError } = await callTool('artifact_schema', {
            project_name: 'test-project',
            artifact_id: 'tech-design',
        });

        expect(isError).toBe(false);
        expect(text).toContain('文档要求: 技术方案 (tech-design)');
        expect(text).toContain('内容指引');
    });

    // ─── Step-specific query ───

    it('should return specific step schema when step is specified', async () => {
        const { text, isError } = await callTool('artifact_schema', {
            project_name: 'test-project',
            artifact_id: 'prd',
            step: 'requirements',
        });

        expect(isError).toBe(false);
        expect(text).toContain('Step 要求: prd.requirements');
        expect(text).toContain('格式: JSON');
        expect(text).toContain('features');
    });

    it('should return step schema for prd.draft', async () => {
        const { text, isError } = await callTool('artifact_schema', {
            project_name: 'test-project',
            artifact_id: 'prd',
            step: 'draft',
        });

        expect(isError).toBe(false);
        expect(text).toContain('Step 要求: prd.draft');
        expect(text).toContain('格式: Markdown');
    });

    // ─── Error cases ───

    it('should error for non-existent artifact_id', async () => {
        const { text, isError } = await callTool('artifact_schema', {
            project_name: 'test-project',
            artifact_id: 'nonexistent-doc',
        });

        expect(isError).toBe(true);
        expect(text).toContain('not found in workflow');
    });

    it('should error for non-existent step', async () => {
        const { text, isError } = await callTool('artifact_schema', {
            project_name: 'test-project',
            artifact_id: 'prd',
            step: 'nonexistent-step',
        });

        expect(isError).toBe(true);
        expect(text).toContain('Step "nonexistent-step" not found');
    });

    it('should error for step on artifact without steps', async () => {
        const { text, isError } = await callTool('artifact_schema', {
            project_name: 'test-project',
            artifact_id: 'user-stories',
            step: 'draft',
        });

        expect(isError).toBe(true);
        expect(text).toContain('not found');
    });

    // ─── Artifact without schema ───

    it('should indicate when no schema exists', async () => {
        const { text, isError } = await callTool('artifact_schema', {
            project_name: 'test-project',
            artifact_id: 'code',
        });

        // code is external, but should still not error — just say no schema
        expect(isError).toBe(false);
        expect(text).toContain('无 schema 定义');
    });
});
