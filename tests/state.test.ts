import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectState, readState, updatePhaseStatus, projectStateExists, setScale } from '../src/core/state.js';
import { loadWorkflow } from '../src/core/workflow.js';
import { resolve } from 'node:path';

const WORKFLOWS_DIR = resolve(join(import.meta.dirname, '..', 'workflows'));
const TEST_PROJECT = 'test-project';
const TEST_PROJECT_DIR = '/tmp/harmonia-test-src';

describe('project state', () => {
    let harmoniaHome: string;

    beforeEach(async () => {
        harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-home-'));
        process.env.HARMONIA_DATA_DIR = harmoniaHome;
        // Create the project data dir (normally done by registerProject)
        await mkdir(join(harmoniaHome, TEST_PROJECT), { recursive: true });
    });

    afterEach(async () => {
        delete process.env.HARMONIA_DATA_DIR;
        await rm(harmoniaHome, { recursive: true, force: true });
    });

    it('should report project does not exist before init', async () => {
        expect(await projectStateExists(TEST_PROJECT)).toBe(false);
    });

    it('should initialize a project with null scale', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, 'dev');
        const state = await initProjectState(TEST_PROJECT, TEST_PROJECT_DIR, wf);

        expect(state.projectName).toBe(TEST_PROJECT);
        expect(state.projectDir).toBe(TEST_PROJECT_DIR);
        expect(state.workflow).toBe('dev');
        expect(state.scale).toBeNull();
        expect(state.currentPhase).toBe('clarify');
        expect(state.phases).toHaveLength(5);
        expect(state.phases[0].status).toBe('in_progress');
        expect(state.phases[1].status).toBe('pending');
    });

    it('should report project exists after init', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, 'dev');
        await initProjectState(TEST_PROJECT, TEST_PROJECT_DIR, wf);
        expect(await projectStateExists(TEST_PROJECT)).toBe(true);
    });

    it('should read state after init', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, 'dev');
        await initProjectState(TEST_PROJECT, TEST_PROJECT_DIR, wf);
        const state = await readState(TEST_PROJECT);

        expect(state.workflow).toBe('dev');
        expect(state.phases).toHaveLength(5);
    });

    it('should update a phase status', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, 'dev');
        await initProjectState(TEST_PROJECT, TEST_PROJECT_DIR, wf);

        const state = await updatePhaseStatus(TEST_PROJECT, 'clarify', 'completed');
        const clarify = state.phases.find((p) => p.id === 'clarify')!;
        const design = state.phases.find((p) => p.id === 'design')!;

        expect(clarify.status).toBe('completed');
        expect(clarify.completedAt).toBeDefined();
        expect(design.status).toBe('in_progress');
        expect(state.currentPhase).toBe('design');
    });

    it('should handle blocked status', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, 'dev');
        await initProjectState(TEST_PROJECT, TEST_PROJECT_DIR, wf);

        const state = await updatePhaseStatus(TEST_PROJECT, 'clarify', 'blocked', 'Waiting for user input');
        const clarify = state.phases.find((p) => p.id === 'clarify')!;

        expect(clarify.status).toBe('blocked');
        expect(clarify.blockedReason).toBe('Waiting for user input');
    });

    it('should throw on updating non-existent phase', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, 'dev');
        await initProjectState(TEST_PROJECT, TEST_PROJECT_DIR, wf);

        await expect(updatePhaseStatus(TEST_PROJECT, 'nonexistent', 'completed')).rejects.toThrow(
            'Phase "nonexistent" not found',
        );
    });

    it('should auto-advance through multiple phases', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, 'dev');
        await initProjectState(TEST_PROJECT, TEST_PROJECT_DIR, wf);

        await updatePhaseStatus(TEST_PROJECT, 'clarify', 'completed');
        await updatePhaseStatus(TEST_PROJECT, 'design', 'completed');
        const state = await updatePhaseStatus(TEST_PROJECT, 'develop', 'completed');

        expect(state.currentPhase).toBe('test');
        expect(state.phases.find((p) => p.id === 'test')!.status).toBe('in_progress');
    });

    it('should set scale on a project with null scale', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, 'dev');
        await initProjectState(TEST_PROJECT, TEST_PROJECT_DIR, wf);

        const state = await setScale(TEST_PROJECT, 'medium');
        expect(state.scale).toBe('medium');

        // Verify persisted
        const reread = await readState(TEST_PROJECT);
        expect(reread.scale).toBe('medium');
    });

    it('should reject setScale when scale is already set', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, 'dev');
        await initProjectState(TEST_PROJECT, TEST_PROJECT_DIR, wf);
        await setScale(TEST_PROJECT, 'small');

        await expect(setScale(TEST_PROJECT, 'large')).rejects.toThrow('Scale 已设定为 "small"');
    });
});
