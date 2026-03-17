import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectState, readState, updatePhaseStatus, projectStateExists, setScale } from '../src/core/state.js';
import { loadWorkflow } from '../src/core/workflow.js';
import { resolve } from 'node:path';

const WORKFLOWS_DIR = resolve(join(import.meta.dirname, '..', 'workflows'));
const NO_CUSTOM_DIR = join(WORKFLOWS_DIR, '..', '.workflows-nonexistent');
const TEST_PROJECT = 'test-project';
const TEST_PROJECT_DIR = '/tmp/harmonia-test-src';
const ITER = 1;

describe('project state', () => {
    let harmoniaHome: string;

    beforeEach(async () => {
        harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-home-'));
        process.env.HARMONIA_DATA_DIR = harmoniaHome;
        // Create the iteration data dir (normally done by startIteration)
        await mkdir(join(harmoniaHome, TEST_PROJECT, `iter-${ITER}`, 'docs'), { recursive: true });
    });

    afterEach(async () => {
        delete process.env.HARMONIA_DATA_DIR;
        await rm(harmoniaHome, { recursive: true, force: true });
    });

    it('should report project does not exist before init', async () => {
        expect(await projectStateExists(TEST_PROJECT, ITER)).toBe(false);
    });

    it('should initialize a project with null scale', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, NO_CUSTOM_DIR, 'dev');
        const state = await initProjectState(TEST_PROJECT, TEST_PROJECT_DIR, wf, ITER);

        expect(state.projectName).toBe(TEST_PROJECT);
        expect(state.projectDir).toBe(TEST_PROJECT_DIR);
        expect(state.workflow).toBe('dev');
        expect(state.iteration).toBe(ITER);
        expect(state.scale).toBeNull();
        expect(state.currentPhase).toBe('clarify');
        expect(state.phases).toHaveLength(5);
        expect(state.phases[0].status).toBe('in_progress');
        expect(state.phases[1].status).toBe('pending');
    });

    it('should report project exists after init', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, NO_CUSTOM_DIR, 'dev');
        await initProjectState(TEST_PROJECT, TEST_PROJECT_DIR, wf, ITER);
        expect(await projectStateExists(TEST_PROJECT, ITER)).toBe(true);
    });

    it('should read state after init', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, NO_CUSTOM_DIR, 'dev');
        await initProjectState(TEST_PROJECT, TEST_PROJECT_DIR, wf, ITER);
        const state = await readState(TEST_PROJECT, ITER);

        expect(state.workflow).toBe('dev');
        expect(state.phases).toHaveLength(5);
    });

    it('should update a phase status', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, NO_CUSTOM_DIR, 'dev');
        await initProjectState(TEST_PROJECT, TEST_PROJECT_DIR, wf, ITER);

        const state = await updatePhaseStatus(TEST_PROJECT, ITER, 'clarify', 'completed');
        const clarify = state.phases.find((p) => p.id === 'clarify')!;
        const design = state.phases.find((p) => p.id === 'design')!;

        expect(clarify.status).toBe('completed');
        expect(clarify.completedAt).toBeDefined();
        expect(design.status).toBe('in_progress');
        expect(state.currentPhase).toBe('design');
    });

    it('should handle blocked status', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, NO_CUSTOM_DIR, 'dev');
        await initProjectState(TEST_PROJECT, TEST_PROJECT_DIR, wf, ITER);

        const state = await updatePhaseStatus(TEST_PROJECT, ITER, 'clarify', 'blocked', 'Waiting for user input');
        const clarify = state.phases.find((p) => p.id === 'clarify')!;

        expect(clarify.status).toBe('blocked');
        expect(clarify.blockedReason).toBe('Waiting for user input');
    });

    it('should throw on updating non-existent phase', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, NO_CUSTOM_DIR, 'dev');
        await initProjectState(TEST_PROJECT, TEST_PROJECT_DIR, wf, ITER);

        await expect(updatePhaseStatus(TEST_PROJECT, ITER, 'nonexistent', 'completed')).rejects.toThrow(
            'Phase "nonexistent" not found',
        );
    });

    it('should auto-advance through multiple phases', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, NO_CUSTOM_DIR, 'dev');
        await initProjectState(TEST_PROJECT, TEST_PROJECT_DIR, wf, ITER);

        await updatePhaseStatus(TEST_PROJECT, ITER, 'clarify', 'completed');
        await updatePhaseStatus(TEST_PROJECT, ITER, 'design', 'completed');
        const state = await updatePhaseStatus(TEST_PROJECT, ITER, 'develop', 'completed');

        expect(state.currentPhase).toBe('test');
        expect(state.phases.find((p) => p.id === 'test')!.status).toBe('in_progress');
    });

    it('should set scale on a project with null scale', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, NO_CUSTOM_DIR, 'dev');
        await initProjectState(TEST_PROJECT, TEST_PROJECT_DIR, wf, ITER);

        const state = await setScale(TEST_PROJECT, ITER, 'medium');
        expect(state.scale).toBe('medium');

        // Verify persisted
        const reread = await readState(TEST_PROJECT, ITER);
        expect(reread.scale).toBe('medium');
    });

    it('should reject setScale when scale is already set', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, NO_CUSTOM_DIR, 'dev');
        await initProjectState(TEST_PROJECT, TEST_PROJECT_DIR, wf, ITER);
        await setScale(TEST_PROJECT, ITER, 'small');

        await expect(setScale(TEST_PROJECT, ITER, 'large')).rejects.toThrow('Scale 已设定为 "small"');
    });
});
