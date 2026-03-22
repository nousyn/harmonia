import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    initWorkflowState,
    readState,
    writeState,
    updateNodeState,
    persistState,
    stateExists,
} from '../src/core/state.js';
import type { WorkflowPlugin, WorkflowDefinition, WorkflowState, NodeState } from '../src/core/types.js';

const TEST_PROJECT = 'test-project';
const TEST_PROJECT_DIR = '/tmp/harmonia-test-src';
const ITER = 1;

// ─── Helpers ───

function makePlugin(overrides: Partial<WorkflowDefinition> = {}): WorkflowPlugin {
    const definition: WorkflowDefinition = {
        name: 'test',
        description: 'Test workflow',
        coordinator: 'coordinator',
        root: {
            type: 'sequence',
            id: 'main',
            children: [
                { type: 'task', id: 'clarify', role: 'coordinator' },
                {
                    type: 'gate',
                    id: 'prd-gate',
                    conditions: [{ type: 'artifact_exists', artifact: 'prd' }],
                    pass: { type: 'task', id: 'design', role: 'architect' },
                    fail: { goto: 'clarify', maxRetries: 3 },
                },
                { type: 'task', id: 'develop', role: 'developer' },
            ],
        },
        ...overrides,
    };

    return {
        name: definition.name,
        definition,
        roles: {},
        artifactSchemas: {},
        artifactDefinitions: {},
        actions: {},
        pluginDir: '/test/plugin',
    };
}

function makePluginWithFloating(): WorkflowPlugin {
    return makePlugin({
        floatingNodes: [{ type: 'task', id: 'escalate', role: 'coordinator' }],
    });
}

// ─── Tests ───

describe('workflow state (node-based)', () => {
    let harmoniaHome: string;
    let contextDir: string;

    beforeEach(async () => {
        harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-state-'));
        contextDir = join(harmoniaHome, TEST_PROJECT, `iter-${ITER}`);
        await mkdir(contextDir, { recursive: true });
    });

    afterEach(async () => {
        await rm(harmoniaHome, { recursive: true, force: true });
    });

    // ─── stateExists ───

    describe('stateExists', () => {
        it('should return false before init', async () => {
            expect(await stateExists(TEST_PROJECT, ITER, contextDir)).toBe(false);
        });

        it('should return true after init', async () => {
            const plugin = makePlugin();
            await initWorkflowState(TEST_PROJECT, TEST_PROJECT_DIR, plugin, ITER, 'iteration', contextDir);
            expect(await stateExists(TEST_PROJECT, ITER, contextDir)).toBe(true);
        });
    });

    // ─── initWorkflowState ───

    describe('initWorkflowState', () => {
        it('should create state with all nodes pending', async () => {
            const plugin = makePlugin();
            const state = await initWorkflowState(
                TEST_PROJECT,
                TEST_PROJECT_DIR,
                plugin,
                ITER,
                'iteration',
                contextDir,
            );

            expect(state.projectName).toBe(TEST_PROJECT);
            expect(state.projectDir).toBe(TEST_PROJECT_DIR);
            expect(state.workflow).toBe('test');
            expect(state.type).toBe('iteration');
            expect(state.iteration).toBe(ITER);
            expect(state.activeNodeId).toBeNull();

            // All nodes should be pending
            const nodeIds = Object.keys(state.nodes);
            expect(nodeIds).toContain('main');
            expect(nodeIds).toContain('clarify');
            expect(nodeIds).toContain('prd-gate');
            expect(nodeIds).toContain('design');
            expect(nodeIds).toContain('develop');

            for (const node of Object.values(state.nodes)) {
                expect(node.status).toBe('pending');
                expect(node.retryCount).toBe(0);
            }
        });

        it('should include floating nodes in state', async () => {
            const plugin = makePluginWithFloating();
            const state = await initWorkflowState(
                TEST_PROJECT,
                TEST_PROJECT_DIR,
                plugin,
                ITER,
                'iteration',
                contextDir,
            );

            expect(state.nodes['escalate']).toBeDefined();
            expect(state.nodes['escalate'].status).toBe('pending');
        });

        it('should persist state to disk', async () => {
            const plugin = makePlugin();
            await initWorkflowState(TEST_PROJECT, TEST_PROJECT_DIR, plugin, ITER, 'iteration', contextDir);

            const filePath = join(contextDir, 'state.json');
            const content = await readFile(filePath, 'utf-8');
            const persisted = JSON.parse(content);

            expect(persisted.projectName).toBe(TEST_PROJECT);
            expect(persisted.nodes).toBeDefined();
        });

        it('should handle patch type', async () => {
            const plugin = makePlugin();
            const state = await initWorkflowState(TEST_PROJECT, TEST_PROJECT_DIR, plugin, 1, 'patch', contextDir);

            expect(state.type).toBe('patch');
        });
    });

    // ─── readState ───

    describe('readState', () => {
        it('should read persisted state', async () => {
            const plugin = makePlugin();
            await initWorkflowState(TEST_PROJECT, TEST_PROJECT_DIR, plugin, ITER, 'iteration', contextDir);

            const state = await readState(TEST_PROJECT, ITER, contextDir);
            expect(state.projectName).toBe(TEST_PROJECT);
            expect(state.workflow).toBe('test');
            expect(Object.keys(state.nodes).length).toBeGreaterThan(0);
        });

        it('should throw when state file does not exist', async () => {
            await expect(readState(TEST_PROJECT, ITER, contextDir)).rejects.toThrow();
        });
    });

    // ─── writeState ───

    describe('writeState', () => {
        it('should overwrite existing state', async () => {
            const plugin = makePlugin();
            const state = await initWorkflowState(
                TEST_PROJECT,
                TEST_PROJECT_DIR,
                plugin,
                ITER,
                'iteration',
                contextDir,
            );

            // Modify and write
            state.activeNodeId = 'clarify';
            state.nodes['clarify'] = {
                ...state.nodes['clarify'],
                status: 'active',
                startedAt: new Date().toISOString(),
            };

            await writeState(TEST_PROJECT, ITER, state, contextDir);

            const reread = await readState(TEST_PROJECT, ITER, contextDir);
            expect(reread.activeNodeId).toBe('clarify');
            expect(reread.nodes['clarify'].status).toBe('active');
        });

        it('should update the updatedAt timestamp', async () => {
            const plugin = makePlugin();
            const state = await initWorkflowState(
                TEST_PROJECT,
                TEST_PROJECT_DIR,
                plugin,
                ITER,
                'iteration',
                contextDir,
            );

            const original = state.updatedAt;

            // Small delay to ensure timestamp difference
            await new Promise((r) => setTimeout(r, 10));

            await writeState(TEST_PROJECT, ITER, state, contextDir);
            const reread = await readState(TEST_PROJECT, ITER, contextDir);

            expect(reread.updatedAt).not.toBe(original);
        });
    });

    // ─── updateNodeState ───

    describe('updateNodeState', () => {
        it('should update a specific node', async () => {
            const plugin = makePlugin();
            await initWorkflowState(TEST_PROJECT, TEST_PROJECT_DIR, plugin, ITER, 'iteration', contextDir);

            const updated = await updateNodeState(
                TEST_PROJECT,
                ITER,
                'clarify',
                { status: 'active', startedAt: new Date().toISOString() },
                contextDir,
            );

            expect(updated.nodes['clarify'].status).toBe('active');
            expect(updated.nodes['clarify'].startedAt).toBeDefined();
            // Other nodes should be unchanged
            expect(updated.nodes['develop'].status).toBe('pending');
        });

        it('should throw for non-existent node', async () => {
            const plugin = makePlugin();
            await initWorkflowState(TEST_PROJECT, TEST_PROJECT_DIR, plugin, ITER, 'iteration', contextDir);

            await expect(
                updateNodeState(TEST_PROJECT, ITER, 'nonexistent', { status: 'active' }, contextDir),
            ).rejects.toThrow('Node "nonexistent" not found');
        });

        it('should persist the update', async () => {
            const plugin = makePlugin();
            await initWorkflowState(TEST_PROJECT, TEST_PROJECT_DIR, plugin, ITER, 'iteration', contextDir);

            await updateNodeState(
                TEST_PROJECT,
                ITER,
                'clarify',
                { status: 'completed', completedAt: new Date().toISOString() },
                contextDir,
            );

            const reread = await readState(TEST_PROJECT, ITER, contextDir);
            expect(reread.nodes['clarify'].status).toBe('completed');
            expect(reread.nodes['clarify'].completedAt).toBeDefined();
        });

        it('should preserve existing fields not in the update', async () => {
            const plugin = makePlugin();
            await initWorkflowState(TEST_PROJECT, TEST_PROJECT_DIR, plugin, ITER, 'iteration', contextDir);

            // First update: set active
            await updateNodeState(
                TEST_PROJECT,
                ITER,
                'clarify',
                { status: 'active', startedAt: '2026-01-01T00:00:00Z' },
                contextDir,
            );

            // Second update: set completed (should keep startedAt)
            const updated = await updateNodeState(
                TEST_PROJECT,
                ITER,
                'clarify',
                { status: 'completed', completedAt: '2026-01-01T01:00:00Z' },
                contextDir,
            );

            expect(updated.nodes['clarify'].status).toBe('completed');
            expect(updated.nodes['clarify'].startedAt).toBe('2026-01-01T00:00:00Z');
            expect(updated.nodes['clarify'].completedAt).toBe('2026-01-01T01:00:00Z');
        });
    });

    // ─── persistState ───

    describe('persistState', () => {
        it('should persist entire engine-computed state', async () => {
            const plugin = makePlugin();
            const state = await initWorkflowState(
                TEST_PROJECT,
                TEST_PROJECT_DIR,
                plugin,
                ITER,
                'iteration',
                contextDir,
            );

            // Simulate engine computing new state
            const newState: WorkflowState = {
                ...state,
                activeNodeId: 'clarify',
                nodes: {
                    ...state.nodes,
                    main: { ...state.nodes['main'], status: 'active', startedAt: new Date().toISOString() },
                    clarify: { ...state.nodes['clarify'], status: 'active', startedAt: new Date().toISOString() },
                },
            };

            await persistState(TEST_PROJECT, ITER, newState, contextDir);

            const reread = await readState(TEST_PROJECT, ITER, contextDir);
            expect(reread.activeNodeId).toBe('clarify');
            expect(reread.nodes['main'].status).toBe('active');
            expect(reread.nodes['clarify'].status).toBe('active');
            expect(reread.nodes['develop'].status).toBe('pending');
        });
    });
});
