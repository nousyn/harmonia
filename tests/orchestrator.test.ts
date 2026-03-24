/**
 * Integration tests for the Orchestrator class (Phase 1.8).
 *
 * Uses a complete minimal workflow plugin fixture on a temp filesystem.
 * The adapter registry uses mock adapters since real adapters are Phase 2.
 *
 * Verifies:
 * - Orchestrator.create() loads state and workflow
 * - start() returns the first dispatch action
 * - Agent connection/disconnection management
 * - handleNodeCompleted/Failed drive workflow forward
 * - dispatchTask() assembles prompt and invokes adapter
 * - shutdown() cleans up resources
 * - DefaultAdapterRegistry register/get/list
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Orchestrator } from '../src/core/orchestrator.js';
import { DefaultAdapterRegistry } from '../src/adapters/registry.js';
import type {
    AgentAdapter,
    AgentAdapterFactory,
    OrchestratorConfig,
    ConnectedAgent,
} from '../src/core/orchestrator.js';
import type { ResolvedContext } from '../src/core/engine-helpers.js';
import type { TaskPayload, TaskResult, AgentStatus } from '../src/core/types.js';

const TEST_PROJECT = 'test-project';
const ITER = 1;

// ─── Helpers ───

/** Create a mock adapter that resolves immediately with a given result. */
function makeMockAdapter(result: TaskResult = { status: 'completed', artifacts: [] }): AgentAdapter {
    return {
        dispatchTask: async (_payload: TaskPayload) => result,
        checkStatus: async () => 'running' as AgentStatus,
        terminate: async () => {},
    };
}

/** Create a factory that produces mock adapters. */
function makeMockFactory(result?: TaskResult): AgentAdapterFactory {
    return {
        create: () => makeMockAdapter(result),
    };
}

/**
 * Set up a minimal but complete workflow plugin fixture:
 * - workflow.json
 * - roles/coordinator.md
 * - state.json
 */
async function createWorkflowFixture(
    baseDir: string,
): Promise<{ workflowsDir: string; contextDir: string; projectDir: string }> {
    const workflowsDir = join(baseDir, '.workflows');
    const wfDir = join(workflowsDir, 'test-wf');
    const rolesDir = join(wfDir, 'roles');
    const contextDir = join(baseDir, TEST_PROJECT, `iter-${ITER}`);
    const projectDir = join(baseDir, TEST_PROJECT);

    await mkdir(rolesDir, { recursive: true });
    await mkdir(join(wfDir, 'schemas'), { recursive: true });
    await mkdir(join(contextDir, 'artifacts'), { recursive: true });

    // workflow.json — simple sequence with 2 tasks
    const workflowDef = {
        name: 'test-wf',
        description: 'Test workflow',
        coordinator: 'coordinator',
        root: {
            type: 'sequence',
            id: 'main',
            children: [
                { type: 'task', id: 'design', role: 'coordinator' },
                { type: 'task', id: 'implement', role: 'coordinator' },
            ],
        },
    };
    await writeFile(join(wfDir, 'workflow.json'), JSON.stringify(workflowDef, null, 2));

    // coordinator role
    await writeFile(
        join(rolesDir, 'coordinator.md'),
        '---\nmodel: high\nsession: persistent\nparallel: false\n---\nYou are the coordinator.',
    );

    // state.json — initial state with all nodes pending
    const state = {
        projectName: TEST_PROJECT,
        projectDir: '/test',
        workflow: 'test-wf',
        type: 'iteration',
        iteration: ITER,
        activeNodeId: null,
        nodes: {
            main: { id: 'main', status: 'pending', retryCount: 0 },
            design: { id: 'design', status: 'pending', retryCount: 0 },
            implement: { id: 'implement', status: 'pending', retryCount: 0 },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    await writeFile(join(contextDir, 'state.json'), JSON.stringify(state, null, 2));

    return { workflowsDir, contextDir, projectDir };
}

function makeOrchestratorConfig(
    fixture: { workflowsDir: string; contextDir: string; projectDir: string },
    registry?: DefaultAdapterRegistry,
): OrchestratorConfig {
    const context: ResolvedContext = {
        entry: {
            name: TEST_PROJECT,
            dir: fixture.projectDir,
            workflow: 'test-wf',
            activeContext: `iter-${ITER}`,
        },
        number: ITER,
        type: 'iteration',
        dir: fixture.contextDir,
        activeContext: `iter-${ITER}`,
    };
    return {
        workflowsDir: fixture.workflowsDir,
        projectName: TEST_PROJECT,
        context,
        adapterRegistry: registry,
        logLevel: 'silent',
    };
}

// ─── Tests ───

describe('Orchestrator', () => {
    let baseDir: string;
    let fixture: { workflowsDir: string; contextDir: string; projectDir: string };
    let originalDataDir: string | undefined;

    beforeEach(async () => {
        baseDir = await mkdtemp(join(tmpdir(), 'harmonia-orch-'));
        fixture = await createWorkflowFixture(baseDir);
        originalDataDir = process.env.HARMONIA_DATA_DIR;
        process.env.HARMONIA_DATA_DIR = baseDir;
    });

    afterEach(async () => {
        if (originalDataDir === undefined) {
            delete process.env.HARMONIA_DATA_DIR;
        } else {
            process.env.HARMONIA_DATA_DIR = originalDataDir;
        }
        await rm(baseDir, { recursive: true, force: true });
    });

    // ─── create() ───

    describe('create', () => {
        it('should create an orchestrator from config', async () => {
            const orch = await Orchestrator.create(makeOrchestratorConfig(fixture));
            expect(orch).toBeDefined();
            expect(orch.getDefinition().name).toBe('test-wf');
            orch.shutdown();
        });

        it('should load workflow state', async () => {
            const orch = await Orchestrator.create(makeOrchestratorConfig(fixture));
            const state = orch.getState();
            expect(state.projectName).toBe(TEST_PROJECT);
            expect(state.workflow).toBe('test-wf');
            expect(state.nodes['design']).toBeDefined();
            expect(state.nodes['implement']).toBeDefined();
            orch.shutdown();
        });
    });

    // ─── start() ───

    describe('start', () => {
        it('should return the first dispatch action', async () => {
            const orch = await Orchestrator.create(makeOrchestratorConfig(fixture));
            const action = orch.start();

            expect(action.type).toBe('dispatch');
            expect(action.nodeId).toBe('design');
            expect(action.role).toBe('coordinator');
            orch.shutdown();
        });

        it('should update state after start', async () => {
            const orch = await Orchestrator.create(makeOrchestratorConfig(fixture));
            orch.start();

            const state = orch.getState();
            expect(state.nodes['design'].status).toBe('active');
            orch.shutdown();
        });
    });

    // ─── Agent connection ───

    describe('agent connection', () => {
        it('should connect and list agents', async () => {
            const orch = await Orchestrator.create(makeOrchestratorConfig(fixture));

            orch.connectAgent({ agentType: 'opencode', role: 'coordinator' });

            const agents = orch.listConnectedAgents();
            expect(agents).toHaveLength(1);
            expect(agents[0].agentType).toBe('opencode');
            expect(agents[0].role).toBe('coordinator');
            orch.shutdown();
        });

        it('should disconnect an agent', async () => {
            const orch = await Orchestrator.create(makeOrchestratorConfig(fixture));

            orch.connectAgent({ agentType: 'opencode', role: 'coordinator' });
            orch.disconnectAgent('coordinator');

            expect(orch.listConnectedAgents()).toHaveLength(0);
            orch.shutdown();
        });

        it('should get a connected agent by key', async () => {
            const orch = await Orchestrator.create(makeOrchestratorConfig(fixture));

            orch.connectAgent({ agentType: 'opencode', role: 'dev', sessionId: 'ses-1' });

            const agent = orch.getConnectedAgent('dev');
            expect(agent).toBeDefined();
            expect(agent!.sessionId).toBe('ses-1');
            orch.shutdown();
        });
    });

    // ─── handleNodeCompleted / handleNodeFailed ───

    describe('workflow event handling', () => {
        it('should advance to next task on handleNodeCompleted', async () => {
            const orch = await Orchestrator.create(makeOrchestratorConfig(fixture));
            orch.start();

            const action = await orch.handleNodeCompleted('design');

            expect(action.type).toBe('dispatch');
            expect(action.nodeId).toBe('implement');
            expect(orch.getState().nodes['design'].status).toBe('completed');
            orch.shutdown();
        });

        it('should complete workflow when all tasks done', async () => {
            const orch = await Orchestrator.create(makeOrchestratorConfig(fixture));
            orch.start();

            await orch.handleNodeCompleted('design');
            const action = await orch.handleNodeCompleted('implement');

            expect(action.type).toBe('completed');
            orch.shutdown();
        });

        it('should handle node failure', async () => {
            const orch = await Orchestrator.create(makeOrchestratorConfig(fixture));
            orch.start();

            const action = await orch.handleNodeFailed('design', 'Agent crashed');

            expect(action.type).toBe('failed');
            expect(orch.getState().nodes['design'].status).toBe('failed');
            orch.shutdown();
        });
    });

    // ─── dispatchTask ───

    describe('dispatchTask', () => {
        it('should return failed when no adapter is registered', async () => {
            const orch = await Orchestrator.create(makeOrchestratorConfig(fixture));
            orch.start();

            const result = await orch.dispatchTask('design', 'Design the system');

            expect(result.status).toBe('failed');
            expect(result.error).toContain('No adapter');
            orch.shutdown();
        });

        it('should dispatch task through adapter when registered', async () => {
            const registry = new DefaultAdapterRegistry();
            registry.register('opencode', makeMockFactory({ status: 'completed', artifacts: ['prd'] }));

            // Need to set agent in role frontmatter — but the loaded plugin comes from disk.
            // The mock adapter factory is keyed by agent type from the role's frontmatter.agent
            // Since our coordinator role doesn't set agent, it defaults to 'unknown'.
            registry.register('unknown', makeMockFactory({ status: 'completed', artifacts: ['prd'] }));

            const orch = await Orchestrator.create(makeOrchestratorConfig(fixture, registry));
            orch.start();

            const result = await orch.dispatchTask('design', 'Design the system');

            expect(result.status).toBe('completed');
            expect(result.artifacts).toEqual(['prd']);
            orch.shutdown();
        });

        it('should return failed when adapter throws', async () => {
            const registry = new DefaultAdapterRegistry();
            const failingFactory: AgentAdapterFactory = {
                create: () => ({
                    dispatchTask: async () => {
                        throw new Error('Connection lost');
                    },
                    checkStatus: async () => 'unreachable' as AgentStatus,
                    terminate: async () => {},
                }),
            };
            registry.register('unknown', failingFactory);

            const orch = await Orchestrator.create(makeOrchestratorConfig(fixture, registry));
            orch.start();

            const result = await orch.dispatchTask('design', 'Design it');

            expect(result.status).toBe('failed');
            expect(result.error).toContain('Connection lost');
            orch.shutdown();
        });
    });

    // ─── shutdown ───

    describe('shutdown', () => {
        it('should clean up all resources', async () => {
            const orch = await Orchestrator.create(makeOrchestratorConfig(fixture));
            orch.connectAgent({ agentType: 'opencode', role: 'coordinator' });
            orch.start();

            orch.shutdown();

            expect(orch.listConnectedAgents()).toHaveLength(0);
            expect(orch.getEventBus().listenerCount('node.activated')).toBe(0);
        });
    });
});

// ─── DefaultAdapterRegistry ───

describe('DefaultAdapterRegistry', () => {
    it('should register and retrieve a factory', () => {
        const registry = new DefaultAdapterRegistry();
        const factory = makeMockFactory();

        registry.register('opencode', factory);

        expect(registry.getFactory('opencode')).toBe(factory);
    });

    it('should return undefined for unregistered type', () => {
        const registry = new DefaultAdapterRegistry();
        expect(registry.getFactory('unknown')).toBeUndefined();
    });

    it('should list registered types', () => {
        const registry = new DefaultAdapterRegistry();
        registry.register('opencode', makeMockFactory());
        registry.register('claude', makeMockFactory());

        const types = registry.listTypes().sort();
        expect(types).toEqual(['claude', 'opencode']);
    });

    it('should allow overwriting a registered factory', () => {
        const registry = new DefaultAdapterRegistry();
        const factory1 = makeMockFactory();
        const factory2 = makeMockFactory();

        registry.register('opencode', factory1);
        registry.register('opencode', factory2);

        expect(registry.getFactory('opencode')).toBe(factory2);
        expect(registry.listTypes()).toHaveLength(1);
    });
});
