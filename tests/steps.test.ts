/**
 * Tests for P3 Sequential step state management (core/steps.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as registry from '../src/core/registry.js';
import {
    readSteps,
    getDocStepState,
    getCompletedStepIds,
    recordStepCompletion,
    markFinalized,
    isDocFinalized,
} from '../src/core/steps.js';

let tempDir: string;

beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'harmonia-steps-test-'));
    const projectDir = join(tempDir, 'test-project');
    await mkdir(projectDir, { recursive: true });
    vi.spyOn(registry, 'getProjectDataDir').mockReturnValue(projectDir);
});

afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
});

const PRD_STEPS = ['requirements', 'completeness-check', 'draft', 'final'];

describe('readSteps', () => {
    it('should return empty record when steps.json does not exist', async () => {
        const result = await readSteps('test-project');
        expect(result).toEqual({});
    });
});

describe('getDocStepState', () => {
    it('should return null when no step state exists for a doc', async () => {
        const result = await getDocStepState('test-project', 'prd');
        expect(result).toBeNull();
    });
});

describe('getCompletedStepIds', () => {
    it('should return empty set for null state', () => {
        const result = getCompletedStepIds(null);
        expect(result.size).toBe(0);
    });

    it('should return set of completed step IDs', () => {
        const result = getCompletedStepIds({
            docId: 'prd',
            completedSteps: [
                {
                    stepId: 'requirements',
                    completedAt: '2026-01-01T00:00:00Z',
                    artifactPath: 'docs/prd.requirements.json',
                },
                {
                    stepId: 'completeness-check',
                    completedAt: '2026-01-01T00:01:00Z',
                    artifactPath: 'docs/prd.completeness-check.json',
                },
            ],
            finalized: false,
        });
        expect(result.has('requirements')).toBe(true);
        expect(result.has('completeness-check')).toBe(true);
        expect(result.has('draft')).toBe(false);
    });
});

describe('recordStepCompletion', () => {
    it('should record the first step', async () => {
        const state = await recordStepCompletion(
            'test-project',
            'prd',
            'requirements',
            'docs/prd.requirements.json',
            PRD_STEPS,
        );

        expect(state.docId).toBe('prd');
        expect(state.completedSteps).toHaveLength(1);
        expect(state.completedSteps[0].stepId).toBe('requirements');
        expect(state.completedSteps[0].artifactPath).toBe('docs/prd.requirements.json');
        expect(state.finalized).toBe(false);
    });

    it('should record multiple steps in order', async () => {
        await recordStepCompletion('test-project', 'prd', 'requirements', 'docs/prd.requirements.json', PRD_STEPS);
        const state = await recordStepCompletion(
            'test-project',
            'prd',
            'completeness-check',
            'docs/prd.completeness-check.json',
            PRD_STEPS,
        );

        expect(state.completedSteps).toHaveLength(2);
        expect(state.completedSteps[0].stepId).toBe('requirements');
        expect(state.completedSteps[1].stepId).toBe('completeness-check');
    });

    it('should persist state to steps.json', async () => {
        await recordStepCompletion('test-project', 'prd', 'requirements', 'docs/prd.requirements.json', PRD_STEPS);

        const projectDir = registry.getProjectDataDir('test-project');
        const content = await readFile(join(projectDir, 'steps.json'), 'utf-8');
        const data = JSON.parse(content);
        expect(data.docs.prd.completedSteps).toHaveLength(1);
    });

    it('should rollback subsequent steps when overwriting a completed step', async () => {
        // Complete steps 1, 2, 3
        await recordStepCompletion('test-project', 'prd', 'requirements', 'docs/prd.requirements.json', PRD_STEPS);
        await recordStepCompletion(
            'test-project',
            'prd',
            'completeness-check',
            'docs/prd.completeness-check.json',
            PRD_STEPS,
        );
        await recordStepCompletion('test-project', 'prd', 'draft', 'docs/prd.draft.md', PRD_STEPS);

        // Re-write step 2 → should clear step 2 and 3, re-record step 2
        const state = await recordStepCompletion(
            'test-project',
            'prd',
            'completeness-check',
            'docs/prd.completeness-check-v2.json',
            PRD_STEPS,
        );

        expect(state.completedSteps).toHaveLength(2);
        expect(state.completedSteps[0].stepId).toBe('requirements');
        expect(state.completedSteps[1].stepId).toBe('completeness-check');
        expect(state.completedSteps[1].artifactPath).toBe('docs/prd.completeness-check-v2.json');
    });

    it('should reset finalized flag when overwriting a step', async () => {
        // Complete all steps and finalize
        await recordStepCompletion('test-project', 'prd', 'requirements', 'docs/prd.requirements.json', PRD_STEPS);
        await recordStepCompletion(
            'test-project',
            'prd',
            'completeness-check',
            'docs/prd.completeness-check.json',
            PRD_STEPS,
        );
        await recordStepCompletion('test-project', 'prd', 'draft', 'docs/prd.draft.md', PRD_STEPS);
        await recordStepCompletion('test-project', 'prd', 'final', 'docs/prd.final.md', PRD_STEPS);
        await markFinalized('test-project', 'prd');

        // Verify finalized
        expect(await isDocFinalized('test-project', 'prd')).toBe(true);

        // Re-write step 3 → should reset finalized
        const state = await recordStepCompletion('test-project', 'prd', 'draft', 'docs/prd.draft-v2.md', PRD_STEPS);
        expect(state.finalized).toBe(false);
        expect(state.finalizedAt).toBeUndefined();
    });

    it('should handle multiple documents independently', async () => {
        const TD_STEPS = ['analysis', 'api-contract', 'draft', 'final'];

        await recordStepCompletion('test-project', 'prd', 'requirements', 'docs/prd.requirements.json', PRD_STEPS);
        await recordStepCompletion(
            'test-project',
            'tech-design',
            'analysis',
            'docs/tech-design.analysis.json',
            TD_STEPS,
        );

        const prdState = await getDocStepState('test-project', 'prd');
        const tdState = await getDocStepState('test-project', 'tech-design');

        expect(prdState!.completedSteps).toHaveLength(1);
        expect(prdState!.completedSteps[0].stepId).toBe('requirements');
        expect(tdState!.completedSteps).toHaveLength(1);
        expect(tdState!.completedSteps[0].stepId).toBe('analysis');
    });
});

describe('markFinalized', () => {
    it('should set finalized flag and timestamp', async () => {
        await recordStepCompletion('test-project', 'prd', 'requirements', 'docs/prd.requirements.json', PRD_STEPS);
        const state = await markFinalized('test-project', 'prd');

        expect(state.finalized).toBe(true);
        expect(state.finalizedAt).toBeDefined();
    });

    it('should throw when no step state exists', async () => {
        await expect(markFinalized('test-project', 'nonexistent')).rejects.toThrow('No step state found');
    });
});

describe('isDocFinalized', () => {
    it('should return false when no state exists', async () => {
        expect(await isDocFinalized('test-project', 'prd')).toBe(false);
    });

    it('should return false when not finalized', async () => {
        await recordStepCompletion('test-project', 'prd', 'requirements', 'docs/prd.requirements.json', PRD_STEPS);
        expect(await isDocFinalized('test-project', 'prd')).toBe(false);
    });

    it('should return true when finalized', async () => {
        await recordStepCompletion('test-project', 'prd', 'requirements', 'docs/prd.requirements.json', PRD_STEPS);
        await markFinalized('test-project', 'prd');
        expect(await isDocFinalized('test-project', 'prd')).toBe(true);
    });
});
