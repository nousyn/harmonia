/**
 * Integration tests for the workflow engine.
 *
 * Tests 5 end-to-end scenarios as specified in 028 §6.3:
 * 1. Full happy path: clarify → gate → design → gate → develop → test → gate → deliver
 * 2. Gate fail → goto retry → success
 * 3. Gate fail → maxRetries exhausted → onExhausted
 * 4. Parallel tasks → fail-fast / wait-all
 * 5. Patch flow
 */

import { describe, it, expect } from 'vitest';
import { initNodeStates, startWorkflow, computeNextAction } from '../src/core/workflow-engine.js';
import type { EngineContext, GateContext } from '../src/core/workflow-engine.js';
import type {
    WorkflowDefinition,
    WorkflowNode,
    TaskNode,
    SequenceNode,
    ParallelNode,
    GateNode,
    GotoTarget,
    WorkflowState,
    GateCondition,
} from '../src/core/types.js';

// ─── Helpers ───

function makeTask(id: string, role = 'developer', overrides: Partial<TaskNode> = {}): TaskNode {
    return { type: 'task', id, role, ...overrides };
}

function makeSequence(id: string, children: WorkflowNode[]): SequenceNode {
    return { type: 'sequence', id, children };
}

function makeParallel(
    id: string,
    children: WorkflowNode[],
    failStrategy: 'fail-fast' | 'wait-all' = 'fail-fast',
    overrides: Partial<ParallelNode> = {},
): ParallelNode {
    return { type: 'parallel', id, failStrategy, children, ...overrides };
}

function makeGate(
    id: string,
    pass: WorkflowNode,
    fail: WorkflowNode | GotoTarget,
    conditions: GateCondition[] = [{ type: 'artifact_exists', artifact: 'test-artifact' }],
): GateNode {
    return { type: 'gate', id, conditions, pass, fail };
}

function makeDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
    return {
        name: 'test',
        description: 'Test workflow',
        coordinator: 'coordinator',
        root: makeSequence('main', [makeTask('task-1')]),
        ...overrides,
    };
}

function makeState(definition: WorkflowDefinition): WorkflowState {
    return {
        projectName: 'test-project',
        projectDir: '/test',
        workflow: 'test',
        type: 'iteration',
        iteration: 1,
        activeNodeId: null,
        nodes: initNodeStates(definition),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

function makeGateContext(overrides: Partial<GateContext> = {}): GateContext {
    return {
        artifactExists: () => false,
        artifactApproved: () => false,
        artifactField: () => undefined,
        ...overrides,
    };
}

function makeContext(overrides: Partial<EngineContext> = {}): EngineContext {
    return {
        gate: makeGateContext(),
        ...overrides,
    };
}

// ─── Scenario 1: Full happy path ───

describe('Scenario 1: Full happy path (dev workflow shape)', () => {
    // Simulates: clarify → prd-gate → design → design-gate → develop → test → test-gate → deliver
    const definition = makeDefinition({
        root: makeSequence('main', [
            makeTask('clarify', 'coordinator'),
            makeGate(
                'prd-gate',
                makeTask('design', 'architect'),
                { goto: 'clarify', maxRetries: 5, onExhausted: 'escalate' },
                [
                    { type: 'artifact_exists', artifact: 'prd' },
                    { type: 'artifact_approved', artifact: 'prd' },
                ],
            ),
            makeGate(
                'design-gate',
                makeTask('develop', 'developer'),
                { goto: 'design', maxRetries: 3, onExhausted: 'escalate' },
                [
                    { type: 'artifact_exists', artifact: 'tech-design' },
                    { type: 'artifact_exists', artifact: 'task-breakdown' },
                ],
            ),
            makeTask('test', 'tester'),
            makeGate(
                'test-gate',
                makeTask('deliver', 'coordinator'),
                { goto: 'develop', maxRetries: 3, onExhausted: 'escalate' },
                [{ type: 'artifact_field', artifact: 'test-report', field: 'result', operator: 'eq', value: 'pass' }],
            ),
        ]),
        floatingNodes: [makeTask('escalate', 'coordinator')],
    });

    it('should progress through full workflow to completion', () => {
        // Artifact state tracking
        const artifacts = new Set<string>();
        const approved = new Set<string>();
        const fields: Record<string, Record<string, unknown>> = {};

        const gateCtx: GateContext = {
            artifactExists: (id) => artifacts.has(id),
            artifactApproved: (id) => approved.has(id),
            artifactField: (id, field) => fields[id]?.[field],
        };
        const ctx = makeContext({ gate: gateCtx });

        // 1. Start workflow → should dispatch clarify
        let state = makeState(definition);
        let result = startWorkflow(definition, state, ctx);
        state = result.state;
        expect(result.nextAction.type).toBe('dispatch');
        expect(result.nextAction.nodeId).toBe('clarify');
        expect(result.nextAction.role).toBe('coordinator');

        // 2. Complete clarify → gate evaluates, prd not written yet, goto clarify
        // But first, let's say coordinator wrote prd + approved it
        artifacts.add('prd');
        approved.add('prd');
        result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'clarify' }, ctx);
        state = result.state;
        // prd-gate should pass → dispatch design
        expect(result.nextAction.type).toBe('dispatch');
        expect(result.nextAction.nodeId).toBe('design');
        expect(result.nextAction.role).toBe('architect');

        // 3. Complete design → design-gate evaluates
        artifacts.add('tech-design');
        artifacts.add('task-breakdown');
        result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'design' }, ctx);
        state = result.state;
        // design-gate passes → dispatch develop
        expect(result.nextAction.type).toBe('dispatch');
        expect(result.nextAction.nodeId).toBe('develop');
        expect(result.nextAction.role).toBe('developer');

        // 4. Complete develop → test is next in sequence
        result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'develop' }, ctx);
        state = result.state;
        expect(result.nextAction.type).toBe('dispatch');
        expect(result.nextAction.nodeId).toBe('test');
        expect(result.nextAction.role).toBe('tester');

        // 5. Complete test → test-gate evaluates
        fields['test-report'] = { result: 'pass' };
        result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'test' }, ctx);
        state = result.state;
        // test-gate passes → dispatch deliver
        expect(result.nextAction.type).toBe('dispatch');
        expect(result.nextAction.nodeId).toBe('deliver');
        expect(result.nextAction.role).toBe('coordinator');

        // 6. Complete deliver → workflow completed
        result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'deliver' }, ctx);
        state = result.state;
        expect(result.nextAction.type).toBe('completed');
    });
});

// ─── Scenario 2: Gate fail → goto retry → success ───

describe('Scenario 2: Gate fail → goto → retry → success', () => {
    // Workflow: taskA → gate → taskB
    // Gate fails → goto taskA → taskA retries → gate passes → taskB dispatched
    const definition = makeDefinition({
        root: makeSequence('main', [
            makeTask('taskA', 'developer'),
            makeGate('gate-1', makeTask('taskB', 'tester'), { goto: 'taskA', maxRetries: 3, onExhausted: 'escalate' }, [
                { type: 'artifact_exists', artifact: 'output' },
            ]),
        ]),
        floatingNodes: [makeTask('escalate', 'coordinator')],
    });

    it('should goto retry on gate fail, then proceed on gate pass', () => {
        const artifacts = new Set<string>();
        const gateCtx: GateContext = {
            artifactExists: (id) => artifacts.has(id),
            artifactApproved: () => false,
            artifactField: () => undefined,
        };
        const ctx = makeContext({ gate: gateCtx });

        // 1. Start → dispatch taskA
        let state = makeState(definition);
        let result = startWorkflow(definition, state, ctx);
        state = result.state;
        expect(result.nextAction.type).toBe('dispatch');
        expect(result.nextAction.nodeId).toBe('taskA');

        // 2. Complete taskA → gate evaluates, artifact missing → goto taskA
        result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'taskA' }, ctx);
        state = result.state;
        // Gate fail → goto loops back to taskA
        expect(result.nextAction.type).toBe('dispatch');
        expect(result.nextAction.nodeId).toBe('taskA');
        // retryCount should be 1
        expect(state.nodes['taskA'].retryCount).toBe(1);
        // Gate evaluation results should be attached
        expect(result.nextAction.gateResults).toBeDefined();
        expect(result.nextAction.gateResults!.passed).toBe(false);

        // 3. Now produce the artifact and complete taskA again → gate passes → dispatch taskB
        artifacts.add('output');
        result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'taskA' }, ctx);
        state = result.state;
        expect(result.nextAction.type).toBe('dispatch');
        expect(result.nextAction.nodeId).toBe('taskB');
        expect(result.nextAction.role).toBe('tester');

        // 4. Complete taskB → workflow completed
        result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'taskB' }, ctx);
        state = result.state;
        expect(result.nextAction.type).toBe('completed');
    });

    it('should track retry count across multiple goto loops', () => {
        const gateCtx: GateContext = {
            artifactExists: () => false,
            artifactApproved: () => false,
            artifactField: () => undefined,
        };
        const ctx = makeContext({ gate: gateCtx });

        let state = makeState(definition);
        let result = startWorkflow(definition, state, ctx);
        state = result.state;

        // Loop 3 times: complete taskA → gate fails → goto taskA
        for (let i = 0; i < 3; i++) {
            result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'taskA' }, ctx);
            state = result.state;
            expect(result.nextAction.type).toBe('dispatch');
            expect(result.nextAction.nodeId).toBe('taskA');
            expect(state.nodes['taskA'].retryCount).toBe(i + 1);
        }
    });
});

// ─── Scenario 3: Gate fail → maxRetries exhausted → onExhausted ───

describe('Scenario 3: Gate fail → maxRetries exhausted → onExhausted', () => {
    // Workflow: taskA → gate → taskB
    // Gate always fails, maxRetries=2, onExhausted='escalate'
    // After 2 retries, should activate the 'escalate' floating node
    const definition = makeDefinition({
        root: makeSequence('main', [
            makeTask('taskA', 'developer'),
            makeGate('gate-1', makeTask('taskB', 'tester'), { goto: 'taskA', maxRetries: 2, onExhausted: 'escalate' }, [
                { type: 'artifact_exists', artifact: 'required-output' },
            ]),
        ]),
        floatingNodes: [makeTask('escalate', 'coordinator')],
    });

    it('should activate floating node when retries exhausted', () => {
        const gateCtx: GateContext = {
            artifactExists: () => false,
            artifactApproved: () => false,
            artifactField: () => undefined,
        };
        const ctx = makeContext({ gate: gateCtx });

        // 1. Start → dispatch taskA
        let state = makeState(definition);
        let result = startWorkflow(definition, state, ctx);
        state = result.state;
        expect(result.nextAction.type).toBe('dispatch');
        expect(result.nextAction.nodeId).toBe('taskA');

        // 2. Complete taskA (attempt 0) → gate fails → goto taskA (retryCount=1)
        result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'taskA' }, ctx);
        state = result.state;
        expect(result.nextAction.type).toBe('dispatch');
        expect(result.nextAction.nodeId).toBe('taskA');
        expect(state.nodes['taskA'].retryCount).toBe(1);

        // 3. Complete taskA (attempt 1) → gate fails → goto taskA (retryCount=2)
        result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'taskA' }, ctx);
        state = result.state;
        expect(result.nextAction.type).toBe('dispatch');
        expect(result.nextAction.nodeId).toBe('taskA');
        expect(state.nodes['taskA'].retryCount).toBe(2);

        // 4. Complete taskA (attempt 2) → gate fails → retries exhausted (2 >= maxRetries 2) → escalate
        result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'taskA' }, ctx);
        state = result.state;
        expect(result.nextAction.type).toBe('dispatch');
        expect(result.nextAction.nodeId).toBe('escalate');
        expect(result.nextAction.role).toBe('coordinator');
    });

    it('should report failed when retries exhausted and no onExhausted configured', () => {
        // Same workflow but without onExhausted
        const defNoEscalate = makeDefinition({
            root: makeSequence('main', [
                makeTask('taskA', 'developer'),
                makeGate('gate-1', makeTask('taskB', 'tester'), { goto: 'taskA', maxRetries: 1 }, [
                    { type: 'artifact_exists', artifact: 'required-output' },
                ]),
            ]),
        });

        const gateCtx: GateContext = {
            artifactExists: () => false,
            artifactApproved: () => false,
            artifactField: () => undefined,
        };
        const ctx = makeContext({ gate: gateCtx });

        let state = makeState(defNoEscalate);
        let result = startWorkflow(defNoEscalate, state, ctx);
        state = result.state;

        // Complete taskA → gate fails → goto taskA (retryCount=1)
        result = computeNextAction(defNoEscalate, state, { type: 'node_completed', nodeId: 'taskA' }, ctx);
        state = result.state;
        expect(result.nextAction.type).toBe('dispatch');
        expect(state.nodes['taskA'].retryCount).toBe(1);

        // Complete taskA again → gate fails → retries exhausted (1 >= 1), no onExhausted → failed
        result = computeNextAction(defNoEscalate, state, { type: 'node_completed', nodeId: 'taskA' }, ctx);
        state = result.state;
        expect(result.nextAction.type).toBe('failed');
        expect(result.nextAction.instructions).toContain('exhausted retries');
    });
});

// ─── Scenario 4: Parallel tasks — fail-fast / wait-all ───

describe('Scenario 4: Parallel tasks', () => {
    describe('fail-fast strategy', () => {
        const definition = makeDefinition({
            root: makeSequence('main', [
                makeParallel(
                    'par',
                    [makeTask('taskA', 'developer'), makeTask('taskB', 'tester'), makeTask('taskC', 'designer')],
                    'fail-fast',
                ),
                makeTask('after', 'coordinator'),
            ]),
        });

        it('should dispatch all parallel children simultaneously', () => {
            const ctx = makeContext();
            let state = makeState(definition);
            const result = startWorkflow(definition, state, ctx);
            state = result.state;

            expect(result.nextAction.type).toBe('dispatch');
            expect(result.nextAction.nodeId).toBe('par');
            expect(result.nextAction.parallelDispatch).toHaveLength(3);
            expect(result.nextAction.parallelDispatch).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ nodeId: 'taskA', role: 'developer' }),
                    expect.objectContaining({ nodeId: 'taskB', role: 'tester' }),
                    expect.objectContaining({ nodeId: 'taskC', role: 'designer' }),
                ]),
            );

            // All children should be active
            expect(state.nodes['taskA'].status).toBe('active');
            expect(state.nodes['taskB'].status).toBe('active');
            expect(state.nodes['taskC'].status).toBe('active');
        });

        it('should wait when some children complete but others still running', () => {
            const ctx = makeContext();
            let state = makeState(definition);
            let result = startWorkflow(definition, state, ctx);
            state = result.state;

            // Complete taskA — others still running
            result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'taskA' }, ctx);
            state = result.state;
            expect(result.nextAction.type).toBe('wait');
            expect(state.nodes['taskA'].status).toBe('completed');
            expect(state.nodes['taskB'].status).toBe('active');
        });

        it('should proceed to next node when all parallel children complete', () => {
            const ctx = makeContext();
            let state = makeState(definition);
            let result = startWorkflow(definition, state, ctx);
            state = result.state;

            // Complete all three tasks
            result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'taskA' }, ctx);
            state = result.state;
            expect(result.nextAction.type).toBe('wait');

            result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'taskB' }, ctx);
            state = result.state;
            expect(result.nextAction.type).toBe('wait');

            result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'taskC' }, ctx);
            state = result.state;
            // All done → parallel completes → next in sequence is 'after'
            expect(result.nextAction.type).toBe('dispatch');
            expect(result.nextAction.nodeId).toBe('after');
            expect(result.nextAction.role).toBe('coordinator');
        });

        it('should cancel remaining children on first failure (fail-fast)', () => {
            const ctx = makeContext();
            let state = makeState(definition);
            let result = startWorkflow(definition, state, ctx);
            state = result.state;

            // Complete taskA first
            result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'taskA' }, ctx);
            state = result.state;

            // taskB fails → fail-fast: cancel active taskC, fail parallel
            result = computeNextAction(
                definition,
                state,
                { type: 'node_failed', nodeId: 'taskB', error: 'test failure' },
                ctx,
            );
            state = result.state;

            // taskC should be cancelled
            expect(state.nodes['taskC'].status).toBe('cancelled');
            // parallel should be failed → bubbles up → sequence fails → workflow fails
            expect(result.nextAction.type).toBe('failed');
        });
    });

    describe('wait-all strategy', () => {
        const definition = makeDefinition({
            root: makeSequence('main', [
                makeParallel('par', [makeTask('taskA', 'developer'), makeTask('taskB', 'tester')], 'wait-all'),
                makeTask('after', 'coordinator'),
            ]),
        });

        it('should wait for remaining children even after a failure (wait-all)', () => {
            const ctx = makeContext();
            let state = makeState(definition);
            let result = startWorkflow(definition, state, ctx);
            state = result.state;

            // taskA fails
            result = computeNextAction(
                definition,
                state,
                { type: 'node_failed', nodeId: 'taskA', error: 'test failure' },
                ctx,
            );
            state = result.state;
            // Should wait for taskB to finish
            expect(result.nextAction.type).toBe('wait');
            expect(result.nextAction.instructions).toContain('wait-all');

            // taskB completes — now all done, but there was a failure → parallel fails
            result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'taskB' }, ctx);
            state = result.state;
            // Parallel had a failure → fails → bubbles up → workflow fails
            expect(result.nextAction.type).toBe('failed');
        });

        it('should succeed when all children complete without failure (wait-all)', () => {
            const ctx = makeContext();
            let state = makeState(definition);
            let result = startWorkflow(definition, state, ctx);
            state = result.state;

            result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'taskA' }, ctx);
            state = result.state;
            expect(result.nextAction.type).toBe('wait');

            result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'taskB' }, ctx);
            state = result.state;
            expect(result.nextAction.type).toBe('dispatch');
            expect(result.nextAction.nodeId).toBe('after');
        });
    });
});

// ─── Scenario 5: Patch flow ───

describe('Scenario 5: Patch flow (type=patch)', () => {
    // A patch workflow is typically shorter: develop → test → gate → deliver
    // No clarify/design phases. The engine doesn't treat type='patch' differently,
    // but the workflow definition is simpler.
    const definition = makeDefinition({
        root: makeSequence('main', [
            makeTask('develop', 'developer'),
            makeTask('test', 'tester'),
            makeGate(
                'test-gate',
                makeTask('deliver', 'coordinator'),
                { goto: 'develop', maxRetries: 2, onExhausted: 'escalate' },
                [{ type: 'artifact_field', artifact: 'test-report', field: 'result', operator: 'eq', value: 'pass' }],
            ),
        ]),
        floatingNodes: [makeTask('escalate', 'coordinator')],
    });

    function makePatchState(def: WorkflowDefinition): WorkflowState {
        return {
            projectName: 'test-project',
            projectDir: '/test',
            workflow: 'test',
            type: 'patch',
            iteration: 1,
            activeNodeId: null,
            nodes: initNodeStates(def),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            meta: { description: 'Fix login button not responding' },
        };
    }

    it('should run a patch workflow from develop to deliver', () => {
        const fields: Record<string, Record<string, unknown>> = {};
        const gateCtx: GateContext = {
            artifactExists: () => false,
            artifactApproved: () => false,
            artifactField: (id, field) => fields[id]?.[field],
        };
        const ctx = makeContext({ gate: gateCtx });

        // 1. Start → dispatch develop
        let state = makePatchState(definition);
        let result = startWorkflow(definition, state, ctx);
        state = result.state;
        expect(result.nextAction.type).toBe('dispatch');
        expect(result.nextAction.nodeId).toBe('develop');
        expect(state.type).toBe('patch');

        // 2. Complete develop → dispatch test
        result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'develop' }, ctx);
        state = result.state;
        expect(result.nextAction.type).toBe('dispatch');
        expect(result.nextAction.nodeId).toBe('test');

        // 3. Complete test → gate evaluates, test-report not ready → goto develop
        result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'test' }, ctx);
        state = result.state;
        expect(result.nextAction.type).toBe('dispatch');
        expect(result.nextAction.nodeId).toBe('develop');
        expect(state.nodes['develop'].retryCount).toBe(1);

        // 4. Fix the code, re-develop → re-test → gate passes → deliver
        result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'develop' }, ctx);
        state = result.state;
        expect(result.nextAction.nodeId).toBe('test');

        fields['test-report'] = { result: 'pass' };
        result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'test' }, ctx);
        state = result.state;
        expect(result.nextAction.type).toBe('dispatch');
        expect(result.nextAction.nodeId).toBe('deliver');

        // 5. Complete deliver → workflow completed
        result = computeNextAction(definition, state, { type: 'node_completed', nodeId: 'deliver' }, ctx);
        state = result.state;
        expect(result.nextAction.type).toBe('completed');
    });

    it('should preserve patch metadata throughout workflow', () => {
        const ctx = makeContext();
        const state = makePatchState(definition);
        const result = startWorkflow(definition, state, ctx);

        expect(result.state.type).toBe('patch');
        expect(result.state.meta?.description).toBe('Fix login button not responding');
    });
});
