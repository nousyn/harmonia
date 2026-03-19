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
    getArtifactStepState,
    getCompletedStepIds,
    recordStepCompletion,
    markFinalized,
    isArtifactFinalized,
} from '../src/core/steps.js';

const ITER = 1;
let tempDir: string;

beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'harmonia-steps-test-'));
    const iterDir = join(tempDir, 'test-project', `iter-${ITER}`);
    await mkdir(iterDir, { recursive: true });
    vi.spyOn(registry, 'getIterationDir').mockReturnValue(iterDir);
});

afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
});

const PRD_STEPS = ['requirements', 'completeness-check', 'draft', 'final'];

describe('readSteps', () => {
    it('should return empty record when steps.json does not exist', async () => {
        const result = await readSteps('test-project', ITER);
        expect(result).toEqual({});
    });
});

describe('getArtifactStepState', () => {
    it('should return null when no step state exists for a doc', async () => {
        const result = await getArtifactStepState('test-project', ITER, 'prd');
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
                    artifactPath: 'artifacts/prd.requirements.json',
                },
                {
                    stepId: 'completeness-check',
                    completedAt: '2026-01-01T00:01:00Z',
                    artifactPath: 'artifacts/prd.completeness-check.json',
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
            ITER,
            'prd',
            'requirements',
            'artifacts/prd.requirements.json',
            PRD_STEPS,
        );

        expect(state.artifactId).toBe('prd');
        expect(state.completedSteps).toHaveLength(1);
        expect(state.completedSteps[0].stepId).toBe('requirements');
        expect(state.completedSteps[0].artifactPath).toBe('artifacts/prd.requirements.json');
        expect(state.finalized).toBe(false);
    });

    it('should record multiple steps in order', async () => {
        await recordStepCompletion(
            'test-project',
            ITER,
            'prd',
            'requirements',
            'artifacts/prd.requirements.json',
            PRD_STEPS,
        );
        const state = await recordStepCompletion(
            'test-project',
            ITER,
            'prd',
            'completeness-check',
            'artifacts/prd.completeness-check.json',
            PRD_STEPS,
        );

        expect(state.completedSteps).toHaveLength(2);
        expect(state.completedSteps[0].stepId).toBe('requirements');
        expect(state.completedSteps[1].stepId).toBe('completeness-check');
    });

    it('should persist state to steps.json', async () => {
        await recordStepCompletion(
            'test-project',
            ITER,
            'prd',
            'requirements',
            'artifacts/prd.requirements.json',
            PRD_STEPS,
        );

        const iterDir = registry.getIterationDir('test-project', ITER);
        const content = await readFile(join(iterDir, 'steps.json'), 'utf-8');
        const data = JSON.parse(content);
        expect(data.artifacts.prd.completedSteps).toHaveLength(1);
    });

    it('should rollback subsequent steps when overwriting a completed step', async () => {
        // Complete steps 1, 2, 3
        await recordStepCompletion(
            'test-project',
            ITER,
            'prd',
            'requirements',
            'artifacts/prd.requirements.json',
            PRD_STEPS,
        );
        await recordStepCompletion(
            'test-project',
            ITER,
            'prd',
            'completeness-check',
            'artifacts/prd.completeness-check.json',
            PRD_STEPS,
        );
        await recordStepCompletion('test-project', ITER, 'prd', 'draft', 'artifacts/prd.draft.md', PRD_STEPS);

        // Re-write step 2 → should clear step 2 and 3, re-record step 2
        const state = await recordStepCompletion(
            'test-project',
            ITER,
            'prd',
            'completeness-check',
            'artifacts/prd.completeness-check-v2.json',
            PRD_STEPS,
        );

        expect(state.completedSteps).toHaveLength(2);
        expect(state.completedSteps[0].stepId).toBe('requirements');
        expect(state.completedSteps[1].stepId).toBe('completeness-check');
        expect(state.completedSteps[1].artifactPath).toBe('artifacts/prd.completeness-check-v2.json');
    });

    it('should reset finalized flag when overwriting a step', async () => {
        // Complete all steps and finalize
        await recordStepCompletion(
            'test-project',
            ITER,
            'prd',
            'requirements',
            'artifacts/prd.requirements.json',
            PRD_STEPS,
        );
        await recordStepCompletion(
            'test-project',
            ITER,
            'prd',
            'completeness-check',
            'artifacts/prd.completeness-check.json',
            PRD_STEPS,
        );
        await recordStepCompletion('test-project', ITER, 'prd', 'draft', 'artifacts/prd.draft.md', PRD_STEPS);
        await recordStepCompletion('test-project', ITER, 'prd', 'final', 'artifacts/prd.final.md', PRD_STEPS);
        await markFinalized('test-project', ITER, 'prd');

        // Verify finalized
        expect(await isArtifactFinalized('test-project', ITER, 'prd')).toBe(true);

        // Re-write step 3 → should reset finalized
        const state = await recordStepCompletion(
            'test-project',
            ITER,
            'prd',
            'draft',
            'artifacts/prd.draft-v2.md',
            PRD_STEPS,
        );
        expect(state.finalized).toBe(false);
        expect(state.finalizedAt).toBeUndefined();
    });

    it('should handle multiple documents independently', async () => {
        const TD_STEPS = ['analysis', 'api-contract', 'draft', 'final'];

        await recordStepCompletion(
            'test-project',
            ITER,
            'prd',
            'requirements',
            'artifacts/prd.requirements.json',
            PRD_STEPS,
        );
        await recordStepCompletion(
            'test-project',
            ITER,
            'tech-design',
            'analysis',
            'artifacts/tech-design.analysis.json',
            TD_STEPS,
        );

        const prdState = await getArtifactStepState('test-project', ITER, 'prd');
        const tdState = await getArtifactStepState('test-project', ITER, 'tech-design');

        expect(prdState!.completedSteps).toHaveLength(1);
        expect(prdState!.completedSteps[0].stepId).toBe('requirements');
        expect(tdState!.completedSteps).toHaveLength(1);
        expect(tdState!.completedSteps[0].stepId).toBe('analysis');
    });
});

describe('markFinalized', () => {
    it('should set finalized flag and timestamp', async () => {
        await recordStepCompletion(
            'test-project',
            ITER,
            'prd',
            'requirements',
            'artifacts/prd.requirements.json',
            PRD_STEPS,
        );
        const state = await markFinalized('test-project', ITER, 'prd');

        expect(state.finalized).toBe(true);
        expect(state.finalizedAt).toBeDefined();
    });

    it('should throw when no step state exists', async () => {
        await expect(markFinalized('test-project', ITER, 'nonexistent')).rejects.toThrow('No step state found');
    });
});

describe('isArtifactFinalized', () => {
    it('should return false when no state exists', async () => {
        expect(await isArtifactFinalized('test-project', ITER, 'prd')).toBe(false);
    });

    it('should return false when not finalized', async () => {
        await recordStepCompletion(
            'test-project',
            ITER,
            'prd',
            'requirements',
            'artifacts/prd.requirements.json',
            PRD_STEPS,
        );
        expect(await isArtifactFinalized('test-project', ITER, 'prd')).toBe(false);
    });

    it('should return true when finalized', async () => {
        await recordStepCompletion(
            'test-project',
            ITER,
            'prd',
            'requirements',
            'artifacts/prd.requirements.json',
            PRD_STEPS,
        );
        await markFinalized('test-project', ITER, 'prd');
        expect(await isArtifactFinalized('test-project', ITER, 'prd')).toBe(true);
    });
});
