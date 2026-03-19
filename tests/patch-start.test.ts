/**
 * Tests for tools/patch-start.ts — patch_start MCP tool.
 *
 * Uses HARMONIA_DATA_DIR to redirect file I/O to a temp directory.
 * Tests the tool via MCP server/client transport (same pattern as sequential.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerProject, startIteration } from '../src/core/registry.js';
import { registerPatchStart } from '../src/tools/patch-start.js';

const PROJECT = 'test-project';
const WORKFLOWS_DIR = resolve(join(import.meta.dirname, '..', 'workflows'));

describe('patch_start tool', () => {
    let harmoniaHome: string;
    let client: Client;
    let server: McpServer;

    async function callTool(name: string, args: Record<string, unknown>) {
        const result = await client.callTool({ name, arguments: args });
        const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
        return { text, isError: result.isError ?? false };
    }

    beforeEach(async () => {
        harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-patch-test-'));
        process.env.HARMONIA_DATA_DIR = harmoniaHome;

        // Setup MCP server + client
        server = new McpServer({ name: 'test', version: '0.0.1' });
        registerPatchStart(server, WORKFLOWS_DIR);
        client = new Client({ name: 'test-client', version: '0.0.1' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await client.connect(clientTransport);
    });

    afterEach(async () => {
        delete process.env.HARMONIA_DATA_DIR;
        await rm(harmoniaHome, { recursive: true, force: true });
    });

    it('should reject when project is not registered', async () => {
        const { text, isError } = await callTool('patch_start', { project_name: 'nonexistent' });
        expect(isError).toBe(true);
        expect(text).toContain('未注册');
    });

    it('should reject when no iterations exist', async () => {
        // Register project but don't start any iteration
        await registerProject(PROJECT, join(harmoniaHome, 'src'), 'dev');

        const { text, isError } = await callTool('patch_start', { project_name: PROJECT });
        expect(isError).toBe(true);
        expect(text).toContain('尚未有任何迭代');
    });

    it('should create a patch after first iteration exists', async () => {
        await registerProject(PROJECT, join(harmoniaHome, 'src'), 'dev');
        await startIteration(PROJECT);

        const { text, isError } = await callTool('patch_start', { project_name: PROJECT });
        expect(isError).toBeFalsy();
        expect(text).toContain('patch-1');
        // New architecture: patch_start returns nextAction info instead of scale/phases
        expect(text).toContain('dev');
    });

    it('should create patch directory with state.json', async () => {
        await registerProject(PROJECT, join(harmoniaHome, 'src'), 'dev');
        await startIteration(PROJECT);

        await callTool('patch_start', { project_name: PROJECT });

        // Verify patch directory and state file exist
        const statePath = join(harmoniaHome, PROJECT, 'patch-1', 'state.json');
        const state = JSON.parse(await readFile(statePath, 'utf-8'));

        expect(state.type).toBe('patch');
        // New architecture: state uses node-based tracking instead of scale/phases
        expect(state.nodes).toBeDefined();
        expect(state.activeNodeId).toBeDefined();
        // Verify workflow nodes exist
        expect(state.nodes['main']).toBeDefined();
        expect(state.nodes['clarify']).toBeDefined();
    });

    it('should auto-increment patch numbers', async () => {
        await registerProject(PROJECT, join(harmoniaHome, 'src'), 'dev');
        await startIteration(PROJECT);

        const r1 = await callTool('patch_start', { project_name: PROJECT });
        expect(r1.text).toContain('patch-1');

        const r2 = await callTool('patch_start', { project_name: PROJECT });
        expect(r2.text).toContain('patch-2');
    });

    it('should include description and issue_id in output when provided', async () => {
        await registerProject(PROJECT, join(harmoniaHome, 'src'), 'dev');
        await startIteration(PROJECT);

        const { text, isError } = await callTool('patch_start', {
            project_name: PROJECT,
            description: '修复登录问题',
            issue_id: 'issue-1',
        });
        expect(isError).toBeFalsy();
        expect(text).toContain('修复登录问题');
        expect(text).toContain('issue-1');
    });
});
