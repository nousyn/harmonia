import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    readGlobalOverrides,
    readProjectOverrides,
    writeGlobalOverrides,
    writeProjectOverrides,
    getMergedOverrides,
    resolveDocReview,
    resolveCapabilityOverride,
    setCapabilityOverride,
    setReviewOverride,
} from '../src/core/overrides.js';
import type { DocDefinition, OverrideConfig } from '../src/core/types.js';

const TEST_PROJECT = 'test-project';

describe('override configuration', () => {
    let harmoniaHome: string;

    beforeEach(async () => {
        harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-override-test-'));
        process.env.HARMONIA_HOME = harmoniaHome;
        await mkdir(join(harmoniaHome, TEST_PROJECT), { recursive: true });
    });

    afterEach(async () => {
        delete process.env.HARMONIA_HOME;
        await rm(harmoniaHome, { recursive: true, force: true });
    });

    // ─── Read/Write ───

    it('should return empty config when no override file exists', async () => {
        const config = await readGlobalOverrides();
        expect(config).toEqual({});
    });

    it('should write and read global overrides', async () => {
        const config: OverrideConfig = {
            review: { prd: true, fsd: false },
            roles: {
                architect: {
                    'analyze-codebase': {
                        type: 'skill',
                        tool: 'codebase-search',
                    },
                },
            },
        };
        await writeGlobalOverrides(config);
        const result = await readGlobalOverrides();
        expect(result).toEqual(config);
    });

    it('should write and read project overrides', async () => {
        const config: OverrideConfig = {
            review: true,
        };
        await writeProjectOverrides(TEST_PROJECT, config);
        const result = await readProjectOverrides(TEST_PROJECT);
        expect(result).toEqual(config);
    });

    // ─── Merge ───

    it('should merge project overrides over global', async () => {
        await writeGlobalOverrides({
            review: { prd: true, fsd: true },
            roles: {
                architect: {
                    'analyze-codebase': { type: 'skill', tool: 'global-tool' },
                },
            },
        });
        await writeProjectOverrides(TEST_PROJECT, {
            review: { prd: false },
            roles: {
                architect: {
                    'analyze-codebase': { type: 'mcp', tool: 'project-tool', server: 'my-server' },
                },
            },
        });

        const merged = await getMergedOverrides(TEST_PROJECT);

        // review: project wins entirely
        expect(merged.review).toEqual({ prd: false });
        // roles: project capability overrides global
        expect(merged.roles?.architect?.['analyze-codebase']?.tool).toBe('project-tool');
    });

    it('should fall back to global when no project override exists', async () => {
        await writeGlobalOverrides({
            review: true,
        });
        const merged = await getMergedOverrides(TEST_PROJECT);
        expect(merged.review).toBe(true);
    });

    // ─── resolveDocReview ───

    it('should use workflow default when no override', () => {
        const docDef: DocDefinition = {
            name: 'PRD',
            scale: { small: 'lite', medium: 'full', large: 'full' },
            review: true,
        };
        expect(resolveDocReview('prd', docDef, {})).toBe(true);
    });

    it('should use global boolean override', () => {
        const docDef: DocDefinition = {
            name: 'PRD',
            scale: { small: 'lite', medium: 'full', large: 'full' },
            review: true,
        };
        expect(resolveDocReview('prd', docDef, { review: false })).toBe(false);
    });

    it('should use per-doc override over workflow default', () => {
        const docDef: DocDefinition = {
            name: 'PRD',
            scale: { small: 'lite', medium: 'full', large: 'full' },
            review: false,
        };
        expect(resolveDocReview('prd', docDef, { review: { prd: true } })).toBe(true);
    });

    it('should fall through to workflow default for unmentioned docs', () => {
        const docDef: DocDefinition = {
            name: 'FSD',
            scale: { small: 'skip', medium: 'full', large: 'full' },
            review: false,
        };
        // Override only mentions prd, not fsd
        expect(resolveDocReview('fsd', docDef, { review: { prd: true } })).toBe(false);
    });

    // ─── resolveCapabilityOverride ───

    it('should return null when no override configured', () => {
        expect(resolveCapabilityOverride('architect', 'analyze-codebase', {})).toBe(null);
    });

    it('should return override when configured', () => {
        const overrides: OverrideConfig = {
            roles: {
                architect: {
                    capabilities: {
                        'analyze-codebase': { type: 'mcp', tool: 'search', server: 'rag' },
                    },
                },
            },
        };
        const result = resolveCapabilityOverride('architect', 'analyze-codebase', overrides);
        expect(result).toEqual({ type: 'mcp', tool: 'search', server: 'rag' });
    });

    // ─── setCapabilityOverride / setReviewOverride ───

    it('should set capability override at global level', async () => {
        await setCapabilityOverride('global', null, 'pm', 'write-prd', {
            type: 'skill',
            tool: 'smart-prd',
        });
        const config = await readGlobalOverrides();
        expect(config.roles?.pm?.capabilities?.['write-prd']).toEqual({
            type: 'skill',
            tool: 'smart-prd',
        });
    });

    it('should set capability override at project level', async () => {
        await setCapabilityOverride('project', TEST_PROJECT, 'developer', 'implement-code', {
            type: 'mcp',
            tool: 'code-writer',
            server: 'coder',
        });
        const config = await readProjectOverrides(TEST_PROJECT);
        expect(config.roles?.developer?.capabilities?.['implement-code']?.server).toBe('coder');
    });

    it('should set review override', async () => {
        await setReviewOverride('global', null, 'prototype', true);
        const config = await readGlobalOverrides();
        expect(config.review).toEqual({ prototype: true });
    });

    it('should accumulate review overrides', async () => {
        await setReviewOverride('global', null, 'prd', true);
        await setReviewOverride('global', null, 'fsd', false);
        const config = await readGlobalOverrides();
        expect(config.review).toEqual({ prd: true, fsd: false });
    });
});
