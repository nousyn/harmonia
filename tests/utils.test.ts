/**
 * Tests for core/engine-helpers.ts — resolveActive helper.
 *
 * Uses HARMONIA_DATA_DIR to redirect file I/O to a temp directory.
 * Tests resolveActive against real registry data (not mocks) to avoid ESM spy issues.
 *
 * Migrated from tools/utils.ts tests. The core version throws errors
 * instead of returning MCP ToolResult objects.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerProject, startIteration, startPatch } from '../src/core/registry.js';
import { resolveActive } from '../src/core/engine-helpers.js';
import type { ResolvedContext } from '../src/core/engine-helpers.js';

const PROJECT = 'test-project';

describe('core/engine-helpers resolveActive', () => {
    let harmoniaHome: string;

    beforeEach(async () => {
        harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-utils-test-'));
        process.env.HARMONIA_DATA_DIR = harmoniaHome;
    });

    afterEach(async () => {
        delete process.env.HARMONIA_DATA_DIR;
        await rm(harmoniaHome, { recursive: true, force: true });
    });

    // ─── resolveActive ───

    describe('resolveActive', () => {
        it('should throw when project does not exist', async () => {
            await expect(resolveActive('nonexistent')).rejects.toThrow('未注册');
        });

        it('should throw when project has no active context', async () => {
            await registerProject(PROJECT, join(harmoniaHome, 'src'), 'dev');

            await expect(resolveActive(PROJECT)).rejects.toThrow('尚未开始迭代或补丁');
        });

        it('should resolve iteration context', async () => {
            await registerProject(PROJECT, join(harmoniaHome, 'src'), 'dev');
            await startIteration(PROJECT);

            const ctx = await resolveActive(PROJECT);

            expect(ctx.type).toBe('iteration');
            expect(ctx.number).toBe(1);
            expect(ctx.activeContext).toBe('iter-1');
            expect(ctx.dir).toContain('iter-1');
            expect(ctx.entry.currentIteration).toBe(1);
        });

        it('should resolve patch context', async () => {
            await registerProject(PROJECT, join(harmoniaHome, 'src'), 'dev');
            await startIteration(PROJECT);
            await startPatch(PROJECT);

            const ctx = await resolveActive(PROJECT);

            expect(ctx.type).toBe('patch');
            expect(ctx.number).toBe(1);
            expect(ctx.activeContext).toBe('patch-1');
            expect(ctx.dir).toContain('patch-1');
        });

        it('should reflect most recent active context', async () => {
            await registerProject(PROJECT, join(harmoniaHome, 'src'), 'dev');
            await startIteration(PROJECT); // iter-1
            await startPatch(PROJECT); // patch-1 becomes active

            const r1 = await resolveActive(PROJECT);
            expect(r1.activeContext).toBe('patch-1');

            await startIteration(PROJECT); // iter-2 becomes active

            const r2 = await resolveActive(PROJECT);
            expect(r2.activeContext).toBe('iter-2');
            expect(r2.number).toBe(2);
        });
    });
});
