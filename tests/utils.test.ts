/**
 * Tests for tools/utils.ts — resolveActive / isError helpers.
 *
 * Uses HARMONIA_DATA_DIR to redirect file I/O to a temp directory.
 * Tests resolveActive against real registry data (not mocks) to avoid ESM spy issues.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerProject, startIteration, startPatch } from '../src/core/registry.js';
import { resolveActive, isError } from '../src/tools/utils.js';
import type { ResolvedContext } from '../src/tools/utils.js';

const PROJECT = 'test-project';

describe('tools/utils', () => {
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
        it('should return error when project does not exist', async () => {
            const result = await resolveActive('nonexistent');
            expect(isError(result)).toBe(true);
            const err = result as { content: { text: string }[]; isError: boolean };
            expect(err.isError).toBe(true);
            expect(err.content[0].text).toContain('未注册');
        });

        it('should return error when project has no active context', async () => {
            await registerProject(PROJECT, join(harmoniaHome, 'src'), 'dev');

            const result = await resolveActive(PROJECT);
            expect(isError(result)).toBe(true);
            const err = result as { content: { text: string }[]; isError: boolean };
            expect(err.content[0].text).toContain('尚未开始迭代或补丁');
        });

        it('should resolve iteration context', async () => {
            await registerProject(PROJECT, join(harmoniaHome, 'src'), 'dev');
            await startIteration(PROJECT);

            const result = await resolveActive(PROJECT);
            expect(isError(result)).toBe(false);

            const ctx = result as ResolvedContext;
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

            const result = await resolveActive(PROJECT);
            expect(isError(result)).toBe(false);

            const ctx = result as ResolvedContext;
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
            expect(isError(r1)).toBe(false);
            expect((r1 as ResolvedContext).activeContext).toBe('patch-1');

            await startIteration(PROJECT); // iter-2 becomes active

            const r2 = await resolveActive(PROJECT);
            expect(isError(r2)).toBe(false);
            expect((r2 as ResolvedContext).activeContext).toBe('iter-2');
            expect((r2 as ResolvedContext).number).toBe(2);
        });
    });

    // ─── isError ───

    describe('isError', () => {
        it('should return true for error results', () => {
            const err = {
                content: [{ type: 'text' as const, text: 'error' }],
                isError: true,
            };
            expect(isError(err)).toBe(true);
        });

        it('should return false for resolved context', () => {
            const ctx: ResolvedContext = {
                entry: {
                    dir: '/tmp',
                    workflow: 'dev',
                    createdAt: '',
                    currentIteration: 1,
                    totalIterations: 1,
                    currentPatch: 0,
                    totalPatches: 0,
                    activeContext: 'iter-1',
                },
                number: 1,
                type: 'iteration',
                dir: '/tmp/iter-1',
                activeContext: 'iter-1',
            };
            expect(isError(ctx)).toBe(false);
        });
    });
});
