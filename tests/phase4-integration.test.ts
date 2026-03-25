/**
 * Phase 4 Integration Tests — Coordinator 对接验证
 *
 * 4.1: Prompt assembly verification (through Orchestrator.buildTaskPayload)
 * 4.2: Coordinator adapter pushMessage chain
 * 4.3: Dev workflow E2E happy path
 * 4.4: Error path verification (failure, timeout, crash)
 *
 * Uses a multi-role workflow fixture to test real prompt assembly,
 * dispatch flow, and error handling through the Orchestrator.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Orchestrator } from '../src/core/orchestrator.js';
import { DefaultAdapterRegistry } from '../src/adapters/registry.js';
import { writeArtifact } from '../src/core/artifacts.js';
import type { OrchestratorConfig } from '../src/core/orchestrator.js';
import type { AgentAdapter, AgentAdapterFactory } from '../src/adapters/types.js';
import type { ResolvedContext } from '../src/core/engine-helpers.js';
import type { TaskPayload, TaskResult, AgentStatus } from '../src/core/types.js';

const TEST_PROJECT = 'integration-project';
const ITER = 1;

// ─── Helpers ───

function makeMockAdapter(
    result: TaskResult = { status: 'completed', artifacts: [] },
    onDispatch?: (payload: TaskPayload) => void,
): AgentAdapter {
    return {
        dispatchTask: async (payload: TaskPayload) => {
            onDispatch?.(payload);
            return result;
        },
        checkStatus: async () => 'running' as AgentStatus,
        terminate: async () => {},
    };
}

function makeMockFactory(result?: TaskResult, onDispatch?: (payload: TaskPayload) => void): AgentAdapterFactory {
    return {
        create: () => makeMockAdapter(result, onDispatch),
    };
}

/**
 * Multi-role workflow fixture:
 *
 *   sequence "main":
 *     task "clarify"     — role: coordinator (agent: openclaw)
 *     task "write-prd"   — role: coordinator (agent: openclaw), output: prd
 *     task "implement"   — role: developer (agent: opencode), input: prd, output: code
 */
async function createMultiRoleFixture(
    baseDir: string,
): Promise<{ workflowsDir: string; contextDir: string; projectDir: string }> {
    const workflowsDir = join(baseDir, '.workflows');
    const wfDir = join(workflowsDir, 'dev-wf');
    const rolesDir = join(wfDir, 'roles');
    const schemasDir = join(wfDir, 'schemas');
    const contextDir = join(baseDir, TEST_PROJECT, `iter-${ITER}`);
    const projectDir = join(baseDir, TEST_PROJECT);

    await mkdir(rolesDir, { recursive: true });
    await mkdir(schemasDir, { recursive: true });
    await mkdir(join(contextDir, 'artifacts'), { recursive: true });

    const workflowDef = {
        name: 'dev-wf',
        description: 'Dev workflow for integration testing',
        coordinator: 'coordinator',
        artifacts: {
            prd: {
                name: 'Product Requirements Document',
                format: 'md',
            },
            code: {
                name: 'Source Code',
                unmanaged: true,
                output: '{project}',
            },
        },
        root: {
            type: 'sequence',
            id: 'main',
            children: [
                { type: 'task', id: 'clarify', role: 'coordinator' },
                { type: 'task', id: 'write-prd', role: 'coordinator' },
                {
                    type: 'task',
                    id: 'implement',
                    role: 'developer',
                    inputArtifacts: ['prd'],
                },
            ],
        },
    };
    await writeFile(join(wfDir, 'workflow.json'), JSON.stringify(workflowDef, null, 2));

    await writeFile(
        join(rolesDir, 'coordinator.md'),
        [
            '---',
            'model: high',
            'agent: openclaw',
            'session: persistent',
            'parallel: false',
            'capabilities:',
            '  - id: write-prd',
            '    description: Write the PRD',
            '    artifact: prd',
            '---',
            'You are the project coordinator.',
            '',
            'Your responsibilities:',
            '- Clarify requirements with the user',
            '- Write the Product Requirements Document',
        ].join('\n'),
    );

    await writeFile(
        join(rolesDir, 'developer.md'),
        [
            '---',
            'model: high',
            'agent: opencode',
            'session: none',
            'parallel: false',
            'capabilities:',
            '  - id: write-code',
            '    description: Write source code',
            '    artifact: code',
            '---',
            'You are a senior software developer.',
            '',
            'Your responsibilities:',
            '- Read the PRD and implement the requested features',
            '- Write clean, tested code',
        ].join('\n'),
    );

    const state = {
        projectName: TEST_PROJECT,
        projectDir,
        workflow: 'dev-wf',
        type: 'iteration',
        iteration: ITER,
        activeNodeId: null,
        nodes: {
            main: { id: 'main', status: 'pending', retryCount: 0 },
            clarify: { id: 'clarify', status: 'pending', retryCount: 0 },
            'write-prd': { id: 'write-prd', status: 'pending', retryCount: 0 },
            implement: { id: 'implement', status: 'pending', retryCount: 0 },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    await writeFile(join(contextDir, 'state.json'), JSON.stringify(state, null, 2));

    return { workflowsDir, contextDir, projectDir };
}

function makeConfig(
    fixture: { workflowsDir: string; contextDir: string; projectDir: string },
    registry?: DefaultAdapterRegistry,
): OrchestratorConfig {
    const context: ResolvedContext = {
        entry: {
            name: TEST_PROJECT,
            dir: fixture.projectDir,
            workflow: 'dev-wf',
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

describe('Phase 4 Integration Tests', () => {
    let baseDir: string;
    let fixture: { workflowsDir: string; contextDir: string; projectDir: string };
    let originalDataDir: string | undefined;

    beforeEach(async () => {
        baseDir = await mkdtemp(join(tmpdir(), 'harmonia-p4-'));
        fixture = await createMultiRoleFixture(baseDir);
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

    // ═══════════════════════════════════════════════════════
    // 4.1: Prompt Assembly Verification
    // ═══════════════════════════════════════════════════════

    describe('4.1 — Prompt Assembly', () => {
        it('should include role system prompt in built payload', async () => {
            const registry = new DefaultAdapterRegistry();
            registry.register('openclaw', makeMockFactory());
            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            orch.start();

            const payload = await orch.buildTaskPayload('clarify', 'Clarify the requirements');

            expect(payload.prompt).toContain('You are the project coordinator.');
            expect(payload.prompt).toContain('Clarify requirements with the user');
            expect(payload.role).toBe('coordinator');
            expect(payload.nodeId).toBe('clarify');
            orch.shutdown();
        });

        it('should include task brief in the prompt', async () => {
            const registry = new DefaultAdapterRegistry();
            registry.register('openclaw', makeMockFactory());
            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            orch.start();

            const payload = await orch.buildTaskPayload('clarify', 'Ask the user about login requirements');

            expect(payload.prompt).toContain('Ask the user about login requirements');
            orch.shutdown();
        });

        it('should include input artifact content when artifact exists', async () => {
            const registry = new DefaultAdapterRegistry();
            registry.register('openclaw', makeMockFactory());
            registry.register('opencode', makeMockFactory());
            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            orch.start();

            await orch.handleNodeCompleted('clarify');
            await orch.handleNodeCompleted('write-prd');

            const ioCtx = {
                contextDir: fixture.contextDir,
                projectDir: fixture.projectDir,
                contextLabel: `iter-${ITER}`,
            };
            await writeArtifact('prd', '# PRD\n\n## Requirements\n\nBuild a login system with OAuth support.', ioCtx);

            const payload = await orch.buildTaskPayload('implement', 'Implement the login system');

            expect(payload.prompt).toContain('Build a login system with OAuth support');
            expect(payload.prompt).toContain('You are a senior software developer.');
            expect(payload.inputArtifacts.length).toBeGreaterThan(0);
            orch.shutdown();
        });

        it('should include output artifact expectations for the role', async () => {
            const registry = new DefaultAdapterRegistry();
            registry.register('opencode', makeMockFactory());
            registry.register('openclaw', makeMockFactory());
            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            orch.start();

            await orch.handleNodeCompleted('clarify');
            await orch.handleNodeCompleted('write-prd');

            const payload = await orch.buildTaskPayload('implement', 'Write the code');

            expect(payload.outputExpectations.length).toBeGreaterThan(0);
            expect(payload.outputExpectations.some((o) => o.name === 'Source Code')).toBe(true);
            orch.shutdown();
        });

        it('should resolve agent type from role frontmatter via dispatchTask', async () => {
            const registry = new DefaultAdapterRegistry();
            let capturedPayload: TaskPayload | undefined;
            registry.register(
                'openclaw',
                makeMockFactory({ status: 'completed', artifacts: [] }, (p) => {
                    capturedPayload = p;
                }),
            );
            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            orch.start();

            const result = await orch.dispatchTask('clarify', 'Clarify requirements');

            expect(result.status).toBe('completed');
            expect(capturedPayload).toBeDefined();
            expect(capturedPayload!.prompt).toContain('You are the project coordinator.');
            orch.shutdown();
        });

        it('should indicate missing input artifacts gracefully', async () => {
            const registry = new DefaultAdapterRegistry();
            registry.register('opencode', makeMockFactory());
            registry.register('openclaw', makeMockFactory());
            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            orch.start();

            await orch.handleNodeCompleted('clarify');
            await orch.handleNodeCompleted('write-prd');

            const payload = await orch.buildTaskPayload('implement', 'Implement it');

            expect(payload.prompt).toContain('Missing');
            orch.shutdown();
        });

        it('should include project context in the prompt', async () => {
            const registry = new DefaultAdapterRegistry();
            registry.register('openclaw', makeMockFactory());
            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            orch.start();

            const payload = await orch.buildTaskPayload('clarify', 'Do task');

            expect(payload.prompt).toContain(TEST_PROJECT);
            expect(payload.prompt).toContain('Project Context');
            orch.shutdown();
        });
    });

    // ═══════════════════════════════════════════════════════
    // 4.2: Coordinator pushMessage Chain
    // ═══════════════════════════════════════════════════════

    describe('4.2 — Coordinator pushMessage Chain', () => {
        it('should deliver pushMessage to coordinator adapter', async () => {
            const registry = new DefaultAdapterRegistry();
            const pushed: string[] = [];
            const coordAdapter = makeMockAdapter();
            (coordAdapter as any).pushMessage = async (msg: string) => {
                pushed.push(msg);
            };
            registry.register('openclaw', { create: () => coordAdapter });
            registry.register('opencode', makeMockFactory());

            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            orch.start();

            // Connect the coordinator adapter with the coordinator role
            orch.connectAgent({
                agentType: 'openclaw',
                role: 'coordinator',
                adapter: coordAdapter,
            });

            await orch.notifyCoordinator('Task clarify completed successfully');

            expect(pushed).toHaveLength(1);
            expect(pushed[0]).toContain('Task clarify completed successfully');
            orch.shutdown();
        });

        it('should silently skip when adapter has no pushMessage', async () => {
            const registry = new DefaultAdapterRegistry();
            // Standard mock adapter has no pushMessage method
            const coordAdapter = makeMockAdapter();
            registry.register('openclaw', { create: () => coordAdapter });

            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            orch.start();

            orch.connectAgent({
                agentType: 'openclaw',
                role: 'coordinator',
                adapter: coordAdapter,
            });

            // Should not throw even though adapter lacks pushMessage
            await expect(orch.notifyCoordinator('Some update')).resolves.toBeUndefined();
            orch.shutdown();
        });

        it('should silently skip when no coordinator is connected', async () => {
            const registry = new DefaultAdapterRegistry();
            registry.register('openclaw', makeMockFactory());

            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            orch.start();

            // No connectAgent call — coordinator is not connected
            await expect(orch.notifyCoordinator('Nobody home')).resolves.toBeUndefined();
            orch.shutdown();
        });

        it('should handle pushMessage failure gracefully', async () => {
            const registry = new DefaultAdapterRegistry();
            const coordAdapter = makeMockAdapter();
            (coordAdapter as any).pushMessage = async () => {
                throw new Error('Push connection lost');
            };
            registry.register('openclaw', { create: () => coordAdapter });

            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            orch.start();

            orch.connectAgent({
                agentType: 'openclaw',
                role: 'coordinator',
                adapter: coordAdapter,
            });

            // Should not throw — error is caught internally
            await expect(orch.notifyCoordinator('Will fail')).resolves.toBeUndefined();
            orch.shutdown();
        });
    });

    // ═══════════════════════════════════════════════════════
    // 4.3: E2E Happy Path
    // ═══════════════════════════════════════════════════════

    describe('4.3 — E2E Happy Path', () => {
        it('should complete full workflow: start → dispatch each node → done', async () => {
            const registry = new DefaultAdapterRegistry();
            const dispatched: string[] = [];

            registry.register(
                'openclaw',
                makeMockFactory({ status: 'completed', artifacts: [] }, (p) => dispatched.push(p.nodeId)),
            );
            registry.register(
                'opencode',
                makeMockFactory({ status: 'completed', artifacts: [] }, (p) => dispatched.push(p.nodeId)),
            );

            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            const firstAction = orch.start();

            // First action should point to 'clarify'
            expect(firstAction.type).toBe('dispatch');
            expect(firstAction.nodeId).toBe('clarify');

            // Dispatch clarify
            const r1 = await orch.dispatchTask('clarify', 'Clarify requirements');
            expect(r1.status).toBe('completed');
            const a1 = await orch.handleNodeCompleted('clarify');
            expect(a1.type).toBe('dispatch');
            expect(a1.nodeId).toBe('write-prd');

            // Dispatch write-prd
            const r2 = await orch.dispatchTask('write-prd', 'Write the PRD');
            expect(r2.status).toBe('completed');
            const a2 = await orch.handleNodeCompleted('write-prd');
            expect(a2.type).toBe('dispatch');
            expect(a2.nodeId).toBe('implement');

            // Dispatch implement
            const r3 = await orch.dispatchTask('implement', 'Implement features');
            expect(r3.status).toBe('completed');
            const a3 = await orch.handleNodeCompleted('implement');
            expect(a3.type).toBe('completed');

            // Verify dispatch order
            expect(dispatched).toEqual(['clarify', 'write-prd', 'implement']);
            orch.shutdown();
        });

        it('should pass correct prompt content at each step with artifacts', async () => {
            const registry = new DefaultAdapterRegistry();
            const payloads: TaskPayload[] = [];

            const capturingFactory: AgentAdapterFactory = {
                create: () => makeMockAdapter({ status: 'completed', artifacts: [] }, (p) => payloads.push(p)),
            };
            registry.register('openclaw', capturingFactory);
            registry.register('opencode', capturingFactory);

            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            orch.start();

            // Step 1: clarify
            await orch.dispatchTask('clarify', 'Clarify the feature');
            await orch.handleNodeCompleted('clarify');

            // Step 2: write-prd — produce an artifact
            await orch.dispatchTask('write-prd', 'Write the PRD document');
            // Write the PRD artifact before marking complete
            const ioCtx = {
                contextDir: fixture.contextDir,
                projectDir: fixture.projectDir,
                contextLabel: `iter-${ITER}`,
            };
            await writeArtifact('prd', '# Login PRD\n\nBuild OAuth login.', ioCtx);
            await orch.handleNodeCompleted('write-prd');

            // Step 3: implement — should receive PRD as input
            await orch.dispatchTask('implement', 'Implement login');

            // Verify payload contents
            expect(payloads).toHaveLength(3);

            // clarify payload should have coordinator role prompt
            expect(payloads[0].role).toBe('coordinator');
            expect(payloads[0].prompt).toContain('project coordinator');
            expect(payloads[0].prompt).toContain('Clarify the feature');

            // write-prd payload should still have coordinator role
            expect(payloads[1].role).toBe('coordinator');
            expect(payloads[1].prompt).toContain('Write the PRD document');

            // implement payload should have developer role + PRD content
            expect(payloads[2].role).toBe('developer');
            expect(payloads[2].prompt).toContain('senior software developer');
            expect(payloads[2].prompt).toContain('Implement login');
            expect(payloads[2].prompt).toContain('Build OAuth login');

            orch.shutdown();
        });
    });

    // ═══════════════════════════════════════════════════════
    // 4.4: Error Paths
    // ═══════════════════════════════════════════════════════

    describe('4.4 — Error Paths', () => {
        it('should mark node as failed when agent returns failed status', async () => {
            const registry = new DefaultAdapterRegistry();
            registry.register(
                'openclaw',
                makeMockFactory({
                    status: 'failed',
                    artifacts: [],
                    error: 'Agent crashed unexpectedly',
                }),
            );

            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            orch.start();

            const result = await orch.dispatchTask('clarify', 'Do clarify');

            expect(result.status).toBe('failed');
            expect(result.error).toContain('Agent crashed unexpectedly');
            orch.shutdown();
        });

        it('should return failed result when adapter throws an exception', async () => {
            const registry = new DefaultAdapterRegistry();
            const throwingAdapter: AgentAdapter = {
                dispatchTask: async () => {
                    throw new Error('Connection timeout');
                },
                checkStatus: async () => 'running' as AgentStatus,
                terminate: async () => {},
            };
            registry.register('openclaw', { create: () => throwingAdapter });

            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            orch.start();

            const result = await orch.dispatchTask('clarify', 'Do clarify');

            expect(result.status).toBe('failed');
            expect(result.error).toContain('Connection timeout');
            orch.shutdown();
        });

        it('should stop sequence when a mid-workflow node fails', async () => {
            const registry = new DefaultAdapterRegistry();
            registry.register('openclaw', makeMockFactory());
            registry.register('opencode', makeMockFactory());

            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            orch.start();

            // Complete clarify, then fail write-prd
            await orch.dispatchTask('clarify', 'Clarify');
            await orch.handleNodeCompleted('clarify');

            const failAction = await orch.handleNodeFailed('write-prd', 'PRD generation failed');

            // After a failure, the sequence should not proceed to implement
            expect(failAction.type).not.toBe('dispatch');
            orch.shutdown();
        });

        it('should return failed when no adapter is registered for agent type', async () => {
            // Registry with no adapters registered
            const registry = new DefaultAdapterRegistry();

            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            orch.start();

            const result = await orch.dispatchTask('clarify', 'Do clarify');

            expect(result.status).toBe('failed');
            expect(result.error).toBeDefined();
            orch.shutdown();
        });

        it('should throw when dispatching to a nonexistent node', async () => {
            const registry = new DefaultAdapterRegistry();
            registry.register('openclaw', makeMockFactory());

            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            orch.start();

            await expect(orch.dispatchTask('nonexistent-node', 'Do something')).rejects.toThrow();
            orch.shutdown();
        });

        it('should throw when building payload for a nonexistent node', async () => {
            const registry = new DefaultAdapterRegistry();
            registry.register('openclaw', makeMockFactory());

            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            orch.start();

            await expect(orch.buildTaskPayload('nonexistent-node', 'Do something')).rejects.toThrow();
            orch.shutdown();
        });

        it('should handle handleNodeFailed for first node gracefully', async () => {
            const registry = new DefaultAdapterRegistry();
            registry.register('openclaw', makeMockFactory());

            const orch = await Orchestrator.create(makeConfig(fixture, registry));
            orch.start();

            // Fail the very first node
            const action = await orch.handleNodeFailed('clarify', 'Immediate failure');

            // Should not proceed to next node
            expect(action.type).not.toBe('dispatch');
            orch.shutdown();
        });
    });
});
