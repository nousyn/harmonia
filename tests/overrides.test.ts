import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    readProjectOverrides,
    writeProjectOverrides,
    getMergedOverrides,
    resolveArtifactReview,
    resolveCapabilityOverride,
    setCapabilityOverride,
    setReviewOverride,
} from '../src/core/overrides.js';
import type { ArtifactDefinition, OverrideConfig } from '../src/core/types.js';

const TEST_PROJECT = 'test-project';

describe('override configuration', () => {
    let harmoniaHome: string;

    beforeEach(async () => {
        harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-override-test-'));
        process.env.HARMONIA_DATA_DIR = harmoniaHome;
        await mkdir(join(harmoniaHome, TEST_PROJECT), { recursive: true });
    });

    afterEach(async () => {
        delete process.env.HARMONIA_DATA_DIR;
        await rm(harmoniaHome, { recursive: true, force: true });
    });

    // ─── Read/Write ───

    it('should return empty config when no override file exists', async () => {
        const config = await readProjectOverrides(TEST_PROJECT);
        expect(config).toEqual({});
    });

    it('should write and read project overrides', async () => {
        const config: OverrideConfig = {
            review: true,
        };
        await writeProjectOverrides(TEST_PROJECT, config);
        const result = await readProjectOverrides(TEST_PROJECT);
        expect(result).toEqual(config);
    });

    it('should write and read project overrides with roles', async () => {
        const config: OverrideConfig = {
            review: { prd: true, fsd: false },
            roles: {
                architect: {
                    capabilities: {
                        'analyze-codebase': {
                            type: 'skill',
                            tool: 'codebase-search',
                        },
                    },
                },
            },
        };
        await writeProjectOverrides(TEST_PROJECT, config);
        const result = await readProjectOverrides(TEST_PROJECT);
        expect(result).toEqual(config);
    });

    // ─── getMergedOverrides ───

    it('should return project overrides directly', async () => {
        await writeProjectOverrides(TEST_PROJECT, {
            review: { prd: false },
            roles: {
                architect: {
                    capabilities: {
                        'analyze-codebase': { type: 'mcp', tool: 'project-tool', server: 'my-server' },
                    },
                },
            },
        });

        const merged = await getMergedOverrides(TEST_PROJECT);
        expect(merged.review).toEqual({ prd: false });
        expect(merged.roles?.architect?.capabilities?.['analyze-codebase']?.tool).toBe('project-tool');
    });

    it('should return empty config when no project override exists', async () => {
        const merged = await getMergedOverrides(TEST_PROJECT);
        expect(merged).toEqual({});
    });

    // ─── resolveArtifactReview ───

    it('should use workflow default when no override', () => {
        const artifactDef: ArtifactDefinition = {
            name: 'PRD',
            scale: { small: 'lite', medium: 'full', large: 'full' },
            review: true,
        };
        expect(resolveArtifactReview('prd', artifactDef, {})).toBe(true);
    });

    it('should use boolean override', () => {
        const artifactDef: ArtifactDefinition = {
            name: 'PRD',
            scale: { small: 'lite', medium: 'full', large: 'full' },
            review: true,
        };
        expect(resolveArtifactReview('prd', artifactDef, { review: false })).toBe(false);
    });

    it('should use per-artifact override over workflow default', () => {
        const artifactDef: ArtifactDefinition = {
            name: 'PRD',
            scale: { small: 'lite', medium: 'full', large: 'full' },
            review: false,
        };
        expect(resolveArtifactReview('prd', artifactDef, { review: { prd: true } })).toBe(true);
    });

    it('should fall through to workflow default for unmentioned artifacts', () => {
        const artifactDef: ArtifactDefinition = {
            name: 'FSD',
            scale: { small: 'skip', medium: 'full', large: 'full' },
            review: false,
        };
        // Override only mentions prd, not fsd
        expect(resolveArtifactReview('fsd', artifactDef, { review: { prd: true } })).toBe(false);
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

    it('should set capability override at project level', async () => {
        await setCapabilityOverride(TEST_PROJECT, 'developer', 'implement-code', {
            type: 'mcp',
            tool: 'code-writer',
            server: 'coder',
        });
        const config = await readProjectOverrides(TEST_PROJECT);
        expect(config.roles?.developer?.capabilities?.['implement-code']?.server).toBe('coder');
    });

    it('should set review override', async () => {
        await setReviewOverride(TEST_PROJECT, 'prototype', true);
        const config = await readProjectOverrides(TEST_PROJECT);
        expect(config.review).toEqual({ prototype: true });
    });

    it('should accumulate review overrides', async () => {
        await setReviewOverride(TEST_PROJECT, 'prd', true);
        await setReviewOverride(TEST_PROJECT, 'fsd', false);
        const config = await readProjectOverrides(TEST_PROJECT);
        expect(config.review).toEqual({ prd: true, fsd: false });
    });
});
