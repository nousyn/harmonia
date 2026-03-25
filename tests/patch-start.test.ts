/**
 * Tests for core/operations.ts — beginPatch operation.
 *
 * Uses HARMONIA_DATA_DIR to redirect file I/O to a temp directory.
 * Tests beginPatch directly.
 *
 * Migrated from tools/patch-start.ts tests. The operations version throws
 * errors on failure and returns BeginPatchResult on success.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { registerProject, startIteration } from '../src/core/registry.js';
import { beginPatch } from '../src/core/operations/index.js';

const PROJECT = 'test-project';
const WORKFLOWS_DIR = resolve(join(import.meta.dirname, '..', 'workflows'));

describe('beginPatch operation', () => {
    let harmoniaHome: string;

    beforeEach(async () => {
        harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-patch-test-'));
        process.env.HARMONIA_DATA_DIR = harmoniaHome;
    });

    afterEach(async () => {
        delete process.env.HARMONIA_DATA_DIR;
        await rm(harmoniaHome, { recursive: true, force: true });
    });

    it('should throw when project is not registered', async () => {
        await expect(beginPatch(WORKFLOWS_DIR, 'nonexistent')).rejects.toThrow('未注册');
    });

    it('should throw when no iterations exist', async () => {
        await registerProject(PROJECT, join(harmoniaHome, 'src'), 'dev');

        await expect(beginPatch(WORKFLOWS_DIR, PROJECT)).rejects.toThrow('尚未有任何迭代');
    });

    it('should create a patch after first iteration exists', async () => {
        await registerProject(PROJECT, join(harmoniaHome, 'src'), 'dev');
        await startIteration(PROJECT);

        const result = await beginPatch(WORKFLOWS_DIR, PROJECT);

        expect(result.patchNumber).toBe(1);
        expect(result.projectName).toBe(PROJECT);
        expect(result.workflowName).toBe('dev');
        expect(result.nextAction).toBeDefined();
    });

    it('should create patch directory with state.json', async () => {
        await registerProject(PROJECT, join(harmoniaHome, 'src'), 'dev');
        await startIteration(PROJECT);

        await beginPatch(WORKFLOWS_DIR, PROJECT);

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

        const r1 = await beginPatch(WORKFLOWS_DIR, PROJECT);
        expect(r1.patchNumber).toBe(1);

        const r2 = await beginPatch(WORKFLOWS_DIR, PROJECT);
        expect(r2.patchNumber).toBe(2);
    });

    it('should include description and issue_id when provided', async () => {
        await registerProject(PROJECT, join(harmoniaHome, 'src'), 'dev');
        await startIteration(PROJECT);

        const result = await beginPatch(WORKFLOWS_DIR, PROJECT, '修复登录问题', 'issue-1');

        expect(result.description).toBe('修复登录问题');
        expect(result.issueId).toBe('issue-1');
    });
});
