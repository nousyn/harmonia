import { describe, it, expect, vi } from 'vitest';
import { initNodeStates, startWorkflow, computeNextAction, evaluateGate } from '../src/core/workflow-engine.js';
import type { EngineContext, GateContext } from '../src/core/workflow-engine.js';
import type {
    WorkflowDefinition,
    WorkflowNode,
    TaskNode,
    SequenceNode,
    ParallelNode,
    GateNode,
    LoopNode,
    LoopNodeState,
    GotoTarget,
    WorkflowState,
    NodeState,
    GateCondition,
} from '../src/core/types.js';

// ─── Helpers ───

function makeTask(id: string, role = 'developer'): TaskNode {
    return { type: 'task', id, role };
}

function makeSequence(id: string, children: WorkflowNode[]): SequenceNode {
    return { type: 'sequence', id, children };
}

function makeParallel(
    id: string,
    children: WorkflowNode[],
    failStrategy: 'fail-fast' | 'wait-all' = 'fail-fast',
): ParallelNode {
    return { type: 'parallel', id, failStrategy, children };
}

function makeGate(
    id: string,
    pass: WorkflowNode,
    fail: WorkflowNode | GotoTarget,
    conditions: GateCondition[] = [{ type: 'artifact_exists', artifact: 'test-artifact' }],
): GateNode {
    return { type: 'gate', id, conditions, pass, fail };
}

function makeLoop(id: string, body: WorkflowNode, maxIterations = 10): LoopNode {
    return { type: 'loop', id, body, maxIterations };
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

// ─── Tests ───

describe('workflow-engine', () => {
    // ─── initNodeStates ───

    describe('initNodeStates', () => {
        it('should create states for all nodes in a simple sequence', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1'), makeTask('t2'), makeTask('t3')]),
            });
            const states = initNodeStates(def);
            expect(Object.keys(states)).toHaveLength(4); // main + t1 + t2 + t3
            expect(states['main'].status).toBe('pending');
            expect(states['t1'].status).toBe('pending');
            expect(states['t2'].status).toBe('pending');
            expect(states['t3'].status).toBe('pending');
        });

        it('should create states for nested structures', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeParallel('p1', [makeTask('t1'), makeTask('t2')]),
                    makeGate('g1', makeTask('t3'), makeTask('t4')),
                ]),
            });
            const states = initNodeStates(def);
            // main, p1, t1, t2, g1, t3, t4
            expect(Object.keys(states)).toHaveLength(7);
        });

        it('should include floating nodes', () => {
            const def = makeDefinition({
                floatingNodes: [makeTask('escalate', 'coordinator')],
            });
            const states = initNodeStates(def);
            expect(states['escalate']).toBeDefined();
            expect(states['escalate'].status).toBe('pending');
        });

        it('should initialize retryCount to 0', () => {
            const def = makeDefinition();
            const states = initNodeStates(def);
            expect(states['main'].retryCount).toBe(0);
            expect(states['task-1'].retryCount).toBe(0);
        });
    });

    // ─── startWorkflow ───

    describe('startWorkflow', () => {
        it('should activate root and return first task dispatch', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1', 'developer')]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            const result = startWorkflow(def, state, ctx);

            expect(result.state.nodes['main'].status).toBe('active');
            expect(result.state.nodes['t1'].status).toBe('active');
            expect(result.nextAction.type).toBe('dispatch');
            expect(result.nextAction.nodeId).toBe('t1');
            expect(result.nextAction.role).toBe('developer');
        });

        it('should handle empty sequence (immediate completion)', () => {
            const def = makeDefinition({
                root: makeSequence('main', []),
            });
            const state = makeState(def);
            const ctx = makeContext();

            const result = startWorkflow(def, state, ctx);

            expect(result.state.nodes['main'].status).toBe('completed');
            expect(result.nextAction.type).toBe('completed');
        });

        it('should use getRolePrompt when provided', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1', 'developer')]),
            });
            const state = makeState(def);
            const ctx = makeContext({
                getRolePrompt: () => 'Custom prompt for developer',
            });

            const result = startWorkflow(def, state, ctx);

            expect(result.nextAction.rolePrompt).toBe('Custom prompt for developer');
        });
    });

    // ─── Sequence execution ───

    describe('sequence execution', () => {
        it('should advance through sequence tasks one by one', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1'), makeTask('t2'), makeTask('t3')]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            // Start workflow → activates t1
            let result = startWorkflow(def, state, ctx);
            expect(result.nextAction.nodeId).toBe('t1');

            // Complete t1 → should activate t2
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 't1',
                },
                ctx,
            );
            expect(result.nextAction.nodeId).toBe('t2');
            expect(result.nextAction.type).toBe('dispatch');
            expect(result.state.nodes['t1'].status).toBe('completed');

            // Complete t2 → should activate t3
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 't2',
                },
                ctx,
            );
            expect(result.nextAction.nodeId).toBe('t3');

            // Complete t3 → workflow complete
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 't3',
                },
                ctx,
            );
            expect(result.nextAction.type).toBe('completed');
            expect(result.state.nodes['main'].status).toBe('completed');
        });
    });

    // ─── Parallel execution ───

    describe('parallel execution', () => {
        it('should activate all children simultaneously', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeParallel('p1', [makeTask('t1'), makeTask('t2'), makeTask('t3')])]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            const result = startWorkflow(def, state, ctx);

            // All children should be active
            expect(result.state.nodes['t1'].status).toBe('active');
            expect(result.state.nodes['t2'].status).toBe('active');
            expect(result.state.nodes['t3'].status).toBe('active');
            expect(result.nextAction.type).toBe('dispatch');
        });

        it('should wait until all children complete', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeParallel('p1', [makeTask('t1'), makeTask('t2')])]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            // Complete t1 — t2 still active
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 't1',
                },
                ctx,
            );
            expect(result.nextAction.type).toBe('wait');

            // Complete t2 — parallel should complete
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 't2',
                },
                ctx,
            );
            expect(result.state.nodes['p1'].status).toBe('completed');
            expect(result.nextAction.type).toBe('completed'); // root completes too
        });

        it('should handle fail-fast strategy', () => {
            const def = makeDefinition({
                root: makeParallel('p1', [makeTask('t1'), makeTask('t2'), makeTask('t3')], 'fail-fast'),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            // t1 fails — should cancel remaining active children
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_failed',
                    nodeId: 't1',
                    error: 'test error',
                },
                ctx,
            );

            expect(result.state.nodes['t1'].status).toBe('failed');
            // t2 and t3 should be cancelled
            expect(result.state.nodes['t2'].status).toBe('cancelled');
            expect(result.state.nodes['t3'].status).toBe('cancelled');
            // Parallel node itself should fail
            expect(result.state.nodes['p1'].status).toBe('failed');
        });

        it('should handle wait-all strategy', () => {
            const def = makeDefinition({
                root: makeParallel('p1', [makeTask('t1'), makeTask('t2')], 'wait-all'),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            // t1 fails — should still wait for t2
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_failed',
                    nodeId: 't1',
                    error: 'test error',
                },
                ctx,
            );
            expect(result.nextAction.type).toBe('wait');

            // t2 completes — now parallel should fail (has failures)
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 't2',
                },
                ctx,
            );
            expect(result.state.nodes['p1'].status).toBe('failed');
        });

        it('should complete parallel when all children succeed under wait-all', () => {
            const def = makeDefinition({
                root: makeParallel('p1', [makeTask('t1'), makeTask('t2')], 'wait-all'),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 't1',
                },
                ctx,
            );
            expect(result.nextAction.type).toBe('wait');

            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 't2',
                },
                ctx,
            );
            expect(result.state.nodes['p1'].status).toBe('completed');
            expect(result.nextAction.type).toBe('completed');
        });
    });

    // ─── Gate evaluation ───

    describe('gate evaluation', () => {
        it('should pass when all conditions are met', () => {
            const gate = makeGate('g1', makeTask('pass-task'), { goto: 'prev' }, [
                { type: 'artifact_exists', artifact: 'prd' },
                { type: 'artifact_approved', artifact: 'prd' },
            ]);
            const gateCtx = makeGateContext({
                artifactExists: (id) => id === 'prd',
                artifactApproved: (id) => id === 'prd',
            });

            const result = evaluateGate(gate, gateCtx);
            expect(result.passed).toBe(true);
            expect(result.conditions).toHaveLength(2);
            expect(result.conditions.every((c) => c.met)).toBe(true);
        });

        it('should fail when any condition is not met', () => {
            const gate = makeGate('g1', makeTask('pass-task'), { goto: 'prev' }, [
                { type: 'artifact_exists', artifact: 'prd' },
                { type: 'artifact_approved', artifact: 'prd' },
            ]);
            const gateCtx = makeGateContext({
                artifactExists: () => true,
                artifactApproved: () => false, // not approved
            });

            const result = evaluateGate(gate, gateCtx);
            expect(result.passed).toBe(false);
            expect(result.conditions[0].met).toBe(true);
            expect(result.conditions[1].met).toBe(false);
        });

        it('should evaluate artifact_field with eq operator', () => {
            const gate = makeGate('g1', makeTask('pass-task'), { goto: 'prev' }, [
                {
                    type: 'artifact_field',
                    artifact: 'test-report',
                    field: 'result',
                    operator: 'eq',
                    value: 'pass',
                },
            ]);
            const gateCtx = makeGateContext({
                artifactField: (artifactId, field) => {
                    if (artifactId === 'test-report' && field === 'result') return 'pass';
                    return undefined;
                },
            });

            const result = evaluateGate(gate, gateCtx);
            expect(result.passed).toBe(true);
            expect(result.conditions[0].actualValue).toBe('pass');
        });

        it('should evaluate artifact_field with neq operator', () => {
            const gate = makeGate('g1', makeTask('pass-task'), { goto: 'prev' }, [
                { type: 'artifact_field', artifact: 'a', field: 'status', operator: 'neq', value: 'blocked' },
            ]);
            const gateCtx = makeGateContext({
                artifactField: () => 'active',
            });

            const result = evaluateGate(gate, gateCtx);
            expect(result.passed).toBe(true);
        });

        it('should evaluate artifact_field with gt/lt/gte/lte operators', () => {
            const conditions: GateCondition[] = [
                { type: 'artifact_field', artifact: 'a', field: 'score', operator: 'gt', value: 80 },
            ];
            const gate = makeGate('g1', makeTask('pass-task'), { goto: 'prev' }, conditions);

            // gt: 90 > 80 = true
            let result = evaluateGate(gate, makeGateContext({ artifactField: () => 90 }));
            expect(result.passed).toBe(true);

            // gt: 80 > 80 = false
            result = evaluateGate(gate, makeGateContext({ artifactField: () => 80 }));
            expect(result.passed).toBe(false);
        });

        it('should evaluate artifact_field with contains operator', () => {
            const conditions: GateCondition[] = [
                { type: 'artifact_field', artifact: 'a', field: 'tags', operator: 'contains', value: 'urgent' },
            ];
            const gate = makeGate('g1', makeTask('pass-task'), { goto: 'prev' }, conditions);

            // String contains
            let result = evaluateGate(gate, makeGateContext({ artifactField: () => 'This is urgent!' }));
            expect(result.passed).toBe(true);

            // Array contains
            result = evaluateGate(gate, makeGateContext({ artifactField: () => ['urgent', 'bug'] }));
            expect(result.passed).toBe(true);

            // Not found
            result = evaluateGate(gate, makeGateContext({ artifactField: () => 'normal' }));
            expect(result.passed).toBe(false);
        });

        it('should evaluate artifact_field with in operator', () => {
            const conditions: GateCondition[] = [
                { type: 'artifact_field', artifact: 'a', field: 'status', operator: 'in', value: ['pass', 'skip'] },
            ];
            const gate = makeGate('g1', makeTask('pass-task'), { goto: 'prev' }, conditions);

            let result = evaluateGate(gate, makeGateContext({ artifactField: () => 'pass' }));
            expect(result.passed).toBe(true);

            result = evaluateGate(gate, makeGateContext({ artifactField: () => 'fail' }));
            expect(result.passed).toBe(false);
        });
    });

    // ─── Gate in workflow ───

    describe('gate in workflow', () => {
        it('should activate pass branch when gate passes', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeGate('g1', makeTask('pass-task', 'developer'), { goto: 'pass-task' }, [
                        { type: 'artifact_exists', artifact: 'prd' },
                    ]),
                ]),
            });
            const state = makeState(def);
            const ctx = makeContext({
                gate: makeGateContext({
                    artifactExists: () => true,
                }),
            });

            const result = startWorkflow(def, state, ctx);

            expect(result.state.nodes['g1'].status).toBe('completed');
            expect(result.state.nodes['pass-task'].status).toBe('active');
            expect(result.nextAction.type).toBe('dispatch');
            expect(result.nextAction.nodeId).toBe('pass-task');
        });

        it('should execute goto when gate fails with goto target', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('clarify', 'coordinator'),
                    makeGate('prd-gate', makeTask('design', 'architect'), { goto: 'clarify', maxRetries: 3 }, [
                        { type: 'artifact_exists', artifact: 'prd' },
                    ]),
                ]),
            });
            const state = makeState(def);
            const ctx = makeContext({
                gate: makeGateContext({
                    artifactExists: () => false, // prd doesn't exist
                }),
            });

            // Start → activates clarify
            let result = startWorkflow(def, state, ctx);
            expect(result.nextAction.nodeId).toBe('clarify');

            // Complete clarify → gate evaluates → fails → goto clarify
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'clarify',
                },
                ctx,
            );

            // clarify should be reset to active (via goto)
            expect(result.state.nodes['clarify'].status).toBe('active');
            expect(result.state.nodes['clarify'].retryCount).toBe(1);
            expect(result.nextAction.nodeId).toBe('clarify');
        });

        it('should activate inline fail node when gate fails with inline node', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeGate(
                        'g1',
                        makeTask('pass-task', 'developer'),
                        makeTask('fail-task', 'coordinator'), // inline fail node
                        [{ type: 'artifact_exists', artifact: 'missing' }],
                    ),
                ]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            const result = startWorkflow(def, state, ctx);

            expect(result.state.nodes['g1'].status).toBe('completed');
            expect(result.state.nodes['fail-task'].status).toBe('active');
            expect(result.nextAction.nodeId).toBe('fail-task');
        });
    });

    // ─── Goto + retry ───

    describe('goto and retry', () => {
        it('should increment retryCount on goto target', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('clarify', 'coordinator'),
                    makeGate('g1', makeTask('design', 'architect'), { goto: 'clarify', maxRetries: 5 }, [
                        { type: 'artifact_exists', artifact: 'prd' },
                    ]),
                ]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            // Start → clarify
            let result = startWorkflow(def, state, ctx);

            // Complete clarify → gate fails → goto clarify (retry 1)
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'clarify',
                },
                ctx,
            );
            expect(result.state.nodes['clarify'].retryCount).toBe(1);

            // Complete clarify again → gate fails → goto clarify (retry 2)
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'clarify',
                },
                ctx,
            );
            expect(result.state.nodes['clarify'].retryCount).toBe(2);
        });

        it('should exhaust retries and activate onExhausted floating node', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('clarify', 'coordinator'),
                    makeGate(
                        'g1',
                        makeTask('design', 'architect'),
                        { goto: 'clarify', maxRetries: 2, onExhausted: 'escalate' },
                        [{ type: 'artifact_exists', artifact: 'prd' }],
                    ),
                ]),
                floatingNodes: [makeTask('escalate', 'coordinator')],
            });
            const state = makeState(def);
            const ctx = makeContext();

            // Start → clarify
            let result = startWorkflow(def, state, ctx);

            // First attempt → fail → goto (retry 1)
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'clarify',
                },
                ctx,
            );
            expect(result.state.nodes['clarify'].retryCount).toBe(1);

            // Second attempt → fail → goto (retry 2)
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'clarify',
                },
                ctx,
            );
            expect(result.state.nodes['clarify'].retryCount).toBe(2);

            // Third attempt → fail → retries exhausted (2 >= maxRetries:2) → escalate
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'clarify',
                },
                ctx,
            );
            expect(result.nextAction.nodeId).toBe('escalate');
            expect(result.state.nodes['escalate'].status).toBe('active');
        });

        it('should reset subsequent nodes when goto executes', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('t1', 'developer'),
                    makeTask('t2', 'developer'),
                    makeTask('t3', 'developer'),
                ]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            // Start → t1
            let result = startWorkflow(def, state, ctx);

            // Complete t1 → t2
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 't1',
                },
                ctx,
            );

            // Complete t2 → t3
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 't2',
                },
                ctx,
            );

            // Now manually trigger a failure with onFailed goto to t1
            // We need a definition with onFailed for this
            const defWithOnFailed = makeDefinition({
                root: makeSequence('main', [
                    makeTask('t1', 'developer'),
                    makeTask('t2', 'developer'),
                    { ...makeTask('t3', 'developer'), onFailed: { goto: 't1', maxRetries: 3 } },
                ]),
            });
            const stateWithOnFailed = makeState(defWithOnFailed);

            // Start and advance to t3
            let r2 = startWorkflow(defWithOnFailed, stateWithOnFailed, ctx);
            r2 = computeNextAction(defWithOnFailed, r2.state, { type: 'node_completed', nodeId: 't1' }, ctx);
            r2 = computeNextAction(defWithOnFailed, r2.state, { type: 'node_completed', nodeId: 't2' }, ctx);

            // t3 fails → onFailed goto t1
            r2 = computeNextAction(
                defWithOnFailed,
                r2.state,
                {
                    type: 'node_failed',
                    nodeId: 't3',
                    error: 'test failure',
                },
                ctx,
            );

            // t1 should be active again, t2 and t3 should be pending
            expect(r2.state.nodes['t1'].status).toBe('active');
            expect(r2.state.nodes['t1'].retryCount).toBe(1);
            expect(r2.state.nodes['t2'].status).toBe('pending');
            expect(r2.state.nodes['t2'].retryCount).toBe(0);
            expect(r2.state.nodes['t3'].status).toBe('pending');
            expect(r2.state.nodes['t3'].retryCount).toBe(0);
        });
    });

    // ─── Failure handling ───

    describe('failure handling', () => {
        it('should bubble failure up to parent when no onFailed', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1'), makeTask('t2')]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            // t1 fails — no onFailed — bubbles to sequence → root
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_failed',
                    nodeId: 't1',
                    error: 'task error',
                },
                ctx,
            );

            expect(result.state.nodes['t1'].status).toBe('failed');
            expect(result.state.nodes['t1'].error).toBe('task error');
            expect(result.state.nodes['main'].status).toBe('failed');
            expect(result.nextAction.type).toBe('failed');
            expect(result.nextAction.instructions).toContain('failed');
        });

        it('should use onFailed goto for retry', () => {
            const def = makeDefinition({
                root: makeSequence('main', [{ ...makeTask('t1'), onFailed: { goto: 't1', maxRetries: 2 } }]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            // t1 fails → onFailed goto t1 (self-retry)
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_failed',
                    nodeId: 't1',
                    error: 'first failure',
                },
                ctx,
            );

            expect(result.state.nodes['t1'].status).toBe('active');
            expect(result.state.nodes['t1'].retryCount).toBe(1);
            expect(result.nextAction.type).toBe('dispatch');
        });

        it('should exhaust onFailed retries and activate onExhausted', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    {
                        ...makeTask('t1'),
                        onFailed: { goto: 't1', maxRetries: 1, onExhausted: 'escalate' },
                    },
                ]),
                floatingNodes: [makeTask('escalate', 'coordinator')],
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            // First failure → retry (retryCount becomes 1)
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_failed',
                    nodeId: 't1',
                    error: 'fail 1',
                },
                ctx,
            );
            expect(result.state.nodes['t1'].retryCount).toBe(1);
            expect(result.nextAction.type).toBe('dispatch');

            // Second failure → retries exhausted (1 >= maxRetries:1) → escalate
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_failed',
                    nodeId: 't1',
                    error: 'fail 2',
                },
                ctx,
            );
            expect(result.nextAction.nodeId).toBe('escalate');
            expect(result.state.nodes['escalate'].status).toBe('active');
        });

        it('should bubble failure when onFailed retries exhausted and no onExhausted', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    {
                        ...makeTask('t1'),
                        onFailed: { goto: 't1', maxRetries: 1 },
                    },
                ]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            // First failure → retry
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_failed',
                    nodeId: 't1',
                    error: 'fail 1',
                },
                ctx,
            );

            // Second failure → exhausted, no onExhausted → bubble
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_failed',
                    nodeId: 't1',
                    error: 'fail 2',
                },
                ctx,
            );

            expect(result.state.nodes['main'].status).toBe('failed');
        });

        it('should handle parallel node with onFailed', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    {
                        ...makeParallel('p1', [makeTask('t1'), makeTask('t2')], 'fail-fast'),
                        onFailed: { goto: 'p1', maxRetries: 2 },
                    },
                ]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            // t1 fails → parallel fail-fast → parallel onFailed goto p1
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_failed',
                    nodeId: 't1',
                    error: 'task failed',
                },
                ctx,
            );

            // p1 should be retried
            expect(result.state.nodes['p1'].status).toBe('active');
            expect(result.state.nodes['p1'].retryCount).toBe(1);
            // Children should be re-activated
            expect(result.state.nodes['t1'].status).toBe('active');
            expect(result.state.nodes['t2'].status).toBe('active');
        });
    });

    // ─── Artifact events and gate re-evaluation ───

    describe('artifact events and gate re-evaluation', () => {
        it('should re-evaluate active gates on artifact_written', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeGate('g1', makeTask('next-task', 'developer'), makeTask('wait-task', 'coordinator'), [
                        { type: 'artifact_exists', artifact: 'prd' },
                    ]),
                ]),
            });
            const state = makeState(def);

            // First: gate fails → activates wait-task inline fail node
            const ctx1 = makeContext();
            let result = startWorkflow(def, state, ctx1);
            // Gate should have completed (with inline fail path)
            expect(result.state.nodes['g1'].status).toBe('completed');
            expect(result.state.nodes['wait-task'].status).toBe('active');
        });

        it('should handle artifact_approved event', () => {
            // Gate that requires artifact to be approved
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('write-task', 'developer'),
                    makeGate(
                        'approval-gate',
                        makeTask('continue-task', 'developer'),
                        makeTask('wait-approval', 'coordinator'),
                        [{ type: 'artifact_approved', artifact: 'prd' }],
                    ),
                ]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            // Start → write-task
            let result = startWorkflow(def, state, ctx);
            expect(result.nextAction.nodeId).toBe('write-task');

            // Complete write-task → gate evaluates → fails (not approved)
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'write-task',
                },
                ctx,
            );

            // Gate completed with inline fail path
            expect(result.state.nodes['approval-gate'].status).toBe('completed');
            expect(result.state.nodes['wait-approval'].status).toBe('active');
        });

        it('should return wait when no gate conditions newly satisfied', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1')]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            // Send artifact_written event — no active gates
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'artifact_written',
                    artifactId: 'some-artifact',
                },
                ctx,
            );

            expect(result.nextAction.type).toBe('wait');
        });
    });

    // ─── Dispatch request handling ───

    describe('dispatch request handling', () => {
        it('should dispatch an active task node', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1', 'developer')]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            // Start workflow to activate t1
            let result = startWorkflow(def, state, ctx);

            // Request dispatch for active task
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'dispatch_requested',
                    nodeId: 't1',
                },
                ctx,
            );

            expect(result.nextAction.type).toBe('dispatch');
            expect(result.nextAction.nodeId).toBe('t1');
            expect(result.nextAction.role).toBe('developer');
        });

        it('should reject dispatch for non-active node', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1'), makeTask('t2')]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            // t2 is pending, not active
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'dispatch_requested',
                    nodeId: 't2',
                },
                ctx,
            );

            expect(result.nextAction.type).toBe('wait');
            expect(result.nextAction.instructions).toContain("not in 'active' state");
        });

        it('should reject dispatch for non-task node', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeParallel('p1', [makeTask('t1'), makeTask('t2')])]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            // p1 is active but is a parallel node, not a task
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'dispatch_requested',
                    nodeId: 'p1',
                },
                ctx,
            );

            expect(result.nextAction.type).toBe('wait');
            expect(result.nextAction.instructions).toContain('not a task');
        });
    });

    // ─── Status query ───

    describe('status query', () => {
        it('should report completed when root is completed', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1')]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            // Complete t1
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 't1',
                },
                ctx,
            );

            // Query status
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'query_status',
                },
                ctx,
            );

            expect(result.nextAction.type).toBe('completed');
        });

        it('should suggest dispatch for active task', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1', 'developer')]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'query_status',
                },
                ctx,
            );

            expect(result.nextAction.type).toBe('dispatch');
            expect(result.nextAction.nodeId).toBe('t1');
            expect(result.nextAction.role).toBe('developer');
        });

        it('should report failed when root has failed', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1')]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            // t1 fails → main fails
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_failed',
                    nodeId: 't1',
                    error: 'crash',
                },
                ctx,
            );

            // Query status
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'query_status',
                },
                ctx,
            );

            expect(result.nextAction.type).toBe('failed');
            expect(result.nextAction.instructions).toContain('failed');
        });
    });

    // ─── Complex integration scenarios ───

    describe('complex scenarios', () => {
        it('should handle the dev workflow pattern: clarify → gate → design → gate → develop → test → gate → deliver', () => {
            // Simplified version of the actual dev workflow
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('clarify', 'coordinator'),
                    makeGate(
                        'prd-gate',
                        makeTask('design', 'architect'),
                        { goto: 'clarify', maxRetries: 3, onExhausted: 'escalate' },
                        [
                            { type: 'artifact_exists', artifact: 'prd' },
                            { type: 'artifact_approved', artifact: 'prd' },
                        ],
                    ),
                    makeGate('design-gate', makeTask('develop', 'developer'), { goto: 'design', maxRetries: 2 }, [
                        { type: 'artifact_exists', artifact: 'tech-design' },
                    ]),
                    makeTask('test', 'tester'),
                    makeGate('test-gate', makeTask('deliver', 'coordinator'), { goto: 'develop', maxRetries: 2 }, [
                        {
                            type: 'artifact_field',
                            artifact: 'test-report',
                            field: 'result',
                            operator: 'eq',
                            value: 'pass',
                        },
                    ]),
                ]),
                floatingNodes: [makeTask('escalate', 'coordinator')],
            });

            let prdExists = false;
            let prdApproved = false;
            let techDesignExists = false;
            let testResult: unknown = undefined;

            const ctx = makeContext({
                gate: {
                    artifactExists: (id) => {
                        if (id === 'prd') return prdExists;
                        if (id === 'tech-design') return techDesignExists;
                        return false;
                    },
                    artifactApproved: (id) => {
                        if (id === 'prd') return prdApproved;
                        return false;
                    },
                    artifactField: (id, field) => {
                        if (id === 'test-report' && field === 'result') return testResult;
                        return undefined;
                    },
                },
            });

            const state = makeState(def);

            // 1. Start → clarify
            let result = startWorkflow(def, state, ctx);
            expect(result.nextAction.nodeId).toBe('clarify');

            // 2. Complete clarify → prd-gate fails (prd doesn't exist) → goto clarify
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'clarify',
                },
                ctx,
            );
            expect(result.state.nodes['clarify'].retryCount).toBe(1);

            // 3. Simulate: prd is now written and approved
            prdExists = true;
            prdApproved = true;

            // Complete clarify again → prd-gate passes → design
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'clarify',
                },
                ctx,
            );
            expect(result.nextAction.nodeId).toBe('design');

            // 4. Complete design → design-gate fails (tech-design doesn't exist) → goto design
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'design',
                },
                ctx,
            );
            expect(result.state.nodes['design'].retryCount).toBe(1);

            // 5. Simulate: tech-design is now written
            techDesignExists = true;

            // Complete design again → design-gate passes → develop
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'design',
                },
                ctx,
            );
            expect(result.nextAction.nodeId).toBe('develop');

            // 6. Complete develop → test
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'develop',
                },
                ctx,
            );
            expect(result.nextAction.nodeId).toBe('test');

            // 7. Complete test → test-gate fails (no test result) → goto develop
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'test',
                },
                ctx,
            );
            expect(result.state.nodes['develop'].retryCount).toBe(1);

            // 8. Simulate: test report passes
            testResult = 'pass';

            // Complete develop → test
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'develop',
                },
                ctx,
            );

            // Complete test → test-gate passes → deliver
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'test',
                },
                ctx,
            );
            expect(result.nextAction.nodeId).toBe('deliver');

            // 9. Complete deliver → workflow complete
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'deliver',
                },
                ctx,
            );
            expect(result.nextAction.type).toBe('completed');
        });

        it('should handle nested parallel within sequence', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('init', 'coordinator'),
                    makeParallel(
                        'parallel-work',
                        [
                            makeTask('frontend', 'developer'),
                            makeTask('backend', 'developer'),
                            makeTask('docs', 'developer'),
                        ],
                        'wait-all',
                    ),
                    makeTask('integrate', 'developer'),
                ]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            // Start → init
            let result = startWorkflow(def, state, ctx);
            expect(result.nextAction.nodeId).toBe('init');

            // Complete init → parallel activates all children
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'init',
                },
                ctx,
            );
            expect(result.state.nodes['frontend'].status).toBe('active');
            expect(result.state.nodes['backend'].status).toBe('active');
            expect(result.state.nodes['docs'].status).toBe('active');

            // Complete frontend → wait
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'frontend',
                },
                ctx,
            );
            expect(result.nextAction.type).toBe('wait');

            // Complete backend → wait
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'backend',
                },
                ctx,
            );
            expect(result.nextAction.type).toBe('wait');

            // Complete docs → parallel completes → integrate
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'docs',
                },
                ctx,
            );
            expect(result.state.nodes['parallel-work'].status).toBe('completed');
            expect(result.nextAction.nodeId).toBe('integrate');

            // Complete integrate → workflow complete
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'integrate',
                },
                ctx,
            );
            expect(result.nextAction.type).toBe('completed');
        });

        it('should handle gate pass branch completing and advancing sequence', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeGate(
                        'check-gate',
                        makeTask('passed-task', 'developer'),
                        makeTask('failed-task', 'coordinator'),
                        [{ type: 'artifact_exists', artifact: 'config' }],
                    ),
                    makeTask('final-task', 'developer'),
                ]),
            });
            const state = makeState(def);
            const ctx = makeContext({
                gate: makeGateContext({ artifactExists: () => true }),
            });

            // Start → gate passes → passed-task
            let result = startWorkflow(def, state, ctx);
            expect(result.nextAction.nodeId).toBe('passed-task');

            // Complete passed-task → gate completes → final-task
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'passed-task',
                },
                ctx,
            );
            expect(result.nextAction.nodeId).toBe('final-task');

            // Complete final-task → workflow complete
            result = computeNextAction(
                def,
                result.state,
                {
                    type: 'node_completed',
                    nodeId: 'final-task',
                },
                ctx,
            );
            expect(result.nextAction.type).toBe('completed');
        });
    });

    // ─── Loop basic flow ───

    describe('loop basic flow', () => {
        it('should activate loop body and track iteration state', () => {
            const def = makeDefinition({
                root: makeLoop('my-loop', makeTask('work', 'developer'), 5),
            });
            const state = makeState(def);
            const ctx = makeContext();

            const result = startWorkflow(def, state, ctx);

            expect(result.state.nodes['my-loop'].status).toBe('active');
            expect(result.state.nodes['work'].status).toBe('active');
            expect((result.state.nodes['my-loop'] as LoopNodeState).currentIteration).toBe(0);
            expect((result.state.nodes['my-loop'] as LoopNodeState).done).toBe(false);
            expect(result.nextAction.type).toBe('dispatch');
            expect(result.nextAction.nodeId).toBe('work');
        });

        it('should start next iteration when body completes', () => {
            const def = makeDefinition({
                root: makeLoop('my-loop', makeTask('work', 'developer'), 5),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);
            expect((result.state.nodes['my-loop'] as LoopNodeState).currentIteration).toBe(0);

            // Complete body → iteration 1
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 'work' }, ctx);
            expect((result.state.nodes['my-loop'] as LoopNodeState).currentIteration).toBe(1);
            expect(result.state.nodes['work'].status).toBe('active');
            expect(result.nextAction.type).toBe('dispatch');
            expect(result.nextAction.nodeId).toBe('work');

            // Complete body → iteration 2
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 'work' }, ctx);
            expect((result.state.nodes['my-loop'] as LoopNodeState).currentIteration).toBe(2);
            expect(result.state.nodes['work'].status).toBe('active');
        });

        it('should reset body node retryCount between iterations', () => {
            const def = makeDefinition({
                root: makeLoop('my-loop', makeTask('work', 'developer'), 5),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            // Complete first iteration
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 'work' }, ctx);

            // Body node should have retryCount reset to 0
            expect(result.state.nodes['work'].retryCount).toBe(0);
        });

        it('should handle loop with sequence body', () => {
            const def = makeDefinition({
                root: makeLoop(
                    'my-loop',
                    makeSequence('body-seq', [makeTask('t1', 'developer'), makeTask('t2', 'developer')]),
                    5,
                ),
            });
            const state = makeState(def);
            const ctx = makeContext();

            // Start → loop activates → body-seq activates → t1
            let result = startWorkflow(def, state, ctx);
            expect(result.nextAction.nodeId).toBe('t1');

            // Complete t1 → t2
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 't1' }, ctx);
            expect(result.nextAction.nodeId).toBe('t2');

            // Complete t2 → body-seq completes → iteration 1 → t1 again
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 't2' }, ctx);
            expect((result.state.nodes['my-loop'] as LoopNodeState).currentIteration).toBe(1);
            expect(result.state.nodes['t1'].status).toBe('active');
            expect(result.state.nodes['t2'].status).toBe('pending');
            expect(result.nextAction.nodeId).toBe('t1');
        });

        it('should handle loop within a sequence', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('init', 'coordinator'),
                    makeLoop('dev-loop', makeTask('develop', 'developer'), 5),
                    makeTask('finalize', 'coordinator'),
                ]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            // Start → init
            let result = startWorkflow(def, state, ctx);
            expect(result.nextAction.nodeId).toBe('init');

            // Complete init → loop activates → develop (iteration 0)
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 'init' }, ctx);
            expect(result.state.nodes['dev-loop'].status).toBe('active');
            expect((result.state.nodes['dev-loop'] as LoopNodeState).currentIteration).toBe(0);
            expect(result.nextAction.nodeId).toBe('develop');

            // Complete develop → iteration 1
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 'develop' }, ctx);
            expect((result.state.nodes['dev-loop'] as LoopNodeState).currentIteration).toBe(1);

            // Mark loop_done, then complete develop → loop terminates → finalize
            result = computeNextAction(def, result.state, { type: 'loop_done', nodeId: 'dev-loop' }, ctx);
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 'develop' }, ctx);
            expect(result.state.nodes['dev-loop'].status).toBe('completed');
            expect(result.nextAction.nodeId).toBe('finalize');

            // Complete finalize → workflow complete
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 'finalize' }, ctx);
            expect(result.nextAction.type).toBe('completed');
        });
    });

    // ─── Loop termination ───

    describe('loop termination', () => {
        it('should terminate loop after current iteration when loop_done is called', () => {
            const def = makeDefinition({
                root: makeLoop('my-loop', makeTask('work', 'developer'), 10),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            // Send loop_done event
            result = computeNextAction(def, result.state, { type: 'loop_done', nodeId: 'my-loop' }, ctx);
            expect(result.nextAction.type).toBe('wait');
            expect((result.state.nodes['my-loop'] as LoopNodeState).done).toBe(true);
            // Loop is still active — current iteration continues
            expect(result.state.nodes['my-loop'].status).toBe('active');

            // Complete current iteration → loop completes
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 'work' }, ctx);
            expect(result.state.nodes['my-loop'].status).toBe('completed');
            expect(result.nextAction.type).toBe('completed');
        });

        it('should fail when maxIterations is reached', () => {
            const def = makeDefinition({
                root: makeLoop('my-loop', makeTask('work', 'developer'), 3),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);
            expect((result.state.nodes['my-loop'] as LoopNodeState).currentIteration).toBe(0);

            // Complete → iteration 1
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 'work' }, ctx);
            expect((result.state.nodes['my-loop'] as LoopNodeState).currentIteration).toBe(1);

            // Complete → iteration 2
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 'work' }, ctx);
            expect((result.state.nodes['my-loop'] as LoopNodeState).currentIteration).toBe(2);

            // Complete → nextIteration (3) >= maxIterations (3) → FAILED
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 'work' }, ctx);
            expect(result.state.nodes['my-loop'].status).toBe('failed');
            expect(result.nextAction.type).toBe('failed');
        });

        it('should reject loop_done for non-active loop', () => {
            const def = makeDefinition({
                root: makeLoop('my-loop', makeTask('work', 'developer'), 10),
            });
            const state = makeState(def);
            const ctx = makeContext();

            // Don't start workflow — loop is still pending
            const result = computeNextAction(def, state, { type: 'loop_done', nodeId: 'my-loop' }, ctx);
            expect(result.nextAction.type).toBe('wait');
            expect(result.nextAction.instructions).toContain('not active');
        });

        it('should allow loop_done mid-sequence-body and terminate after body completes', () => {
            const def = makeDefinition({
                root: makeLoop(
                    'my-loop',
                    makeSequence('body-seq', [makeTask('t1', 'developer'), makeTask('t2', 'developer')]),
                    10,
                ),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);
            expect(result.nextAction.nodeId).toBe('t1');

            // Call loop_done while t1 is active
            result = computeNextAction(def, result.state, { type: 'loop_done', nodeId: 'my-loop' }, ctx);
            expect((result.state.nodes['my-loop'] as LoopNodeState).done).toBe(true);

            // Complete t1 → t2 (current iteration continues)
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 't1' }, ctx);
            expect(result.nextAction.nodeId).toBe('t2');

            // Complete t2 → body-seq completes → loop checks done=true → loop completed
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 't2' }, ctx);
            expect(result.state.nodes['my-loop'].status).toBe('completed');
        });
    });

    // ─── Loop failure propagation ───

    describe('loop failure propagation', () => {
        it('should propagate body task failure to loop when no onFailed', () => {
            const def = makeDefinition({
                root: makeLoop('my-loop', makeTask('work', 'developer'), 5),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            // work fails → bubbles to loop → loop fails → workflow fails
            result = computeNextAction(
                def,
                result.state,
                { type: 'node_failed', nodeId: 'work', error: 'task crashed' },
                ctx,
            );
            expect(result.state.nodes['work'].status).toBe('failed');
            expect(result.state.nodes['my-loop'].status).toBe('failed');
            expect(result.nextAction.type).toBe('failed');
        });

        it('should handle body task onFailed retry within loop', () => {
            const bodyTask = { ...makeTask('work', 'developer'), onFailed: { goto: 'work', maxRetries: 2 } };
            const def = makeDefinition({
                root: makeLoop('my-loop', bodyTask, 5),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            // work fails → task-level onFailed retries work
            result = computeNextAction(
                def,
                result.state,
                { type: 'node_failed', nodeId: 'work', error: 'first fail' },
                ctx,
            );
            expect(result.state.nodes['work'].status).toBe('active');
            expect(result.state.nodes['work'].retryCount).toBe(1);
            // Loop is still active
            expect(result.state.nodes['my-loop'].status).toBe('active');
            expect(result.nextAction.type).toBe('dispatch');
        });

        it('should use loop onFailed when loop itself fails', () => {
            const loopNode: LoopNode = {
                ...makeLoop('my-loop', makeTask('work', 'developer'), 2),
                onFailed: { goto: 'my-loop', maxRetries: 1 },
            };
            const def = makeDefinition({
                root: makeSequence('main', [loopNode]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            // iteration 0 → complete → iteration 1
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 'work' }, ctx);
            expect((result.state.nodes['my-loop'] as LoopNodeState).currentIteration).toBe(1);

            // Complete iteration 1 → nextIteration(2) >= maxIterations(2) → loop fails → onFailed goto my-loop
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 'work' }, ctx);

            // Loop should be retried via onFailed
            expect(result.state.nodes['my-loop'].status).toBe('active');
            expect(result.state.nodes['my-loop'].retryCount).toBe(1);
            expect((result.state.nodes['my-loop'] as LoopNodeState).currentIteration).toBe(0);
        });

        it('should escalate when loop onFailed retries are exhausted', () => {
            const loopNode: LoopNode = {
                ...makeLoop('my-loop', makeTask('work', 'developer'), 1),
                onFailed: { goto: 'my-loop', maxRetries: 1, onExhausted: 'escalate' },
            };
            const def = makeDefinition({
                root: makeSequence('main', [loopNode]),
                floatingNodes: [makeTask('escalate', 'coordinator')],
            });
            const state = makeState(def);
            const ctx = makeContext();

            let result = startWorkflow(def, state, ctx);

            // iteration 0 complete → maxIterations(1) reached → loop fails → onFailed retry (retryCount 1)
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 'work' }, ctx);
            expect(result.state.nodes['my-loop'].retryCount).toBe(1);

            // iteration 0 complete again → maxIterations(1) reached → loop fails → retries exhausted → escalate
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 'work' }, ctx);
            expect(result.nextAction.nodeId).toBe('escalate');
            expect(result.state.nodes['escalate'].status).toBe('active');
        });
    });

    // ─── Loop body goto out ───

    describe('loop body goto out', () => {
        it('should allow gate fail goto to node outside loop', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('setup', 'coordinator'),
                    makeLoop(
                        'dev-loop',
                        makeGate(
                            'quality-gate',
                            makeTask('continue-work', 'developer'),
                            { goto: 'setup', maxRetries: 3 },
                            [{ type: 'artifact_exists', artifact: 'quality-report' }],
                        ),
                        5,
                    ),
                    makeTask('finalize', 'coordinator'),
                ]),
            });
            const state = makeState(def);
            const ctx = makeContext();

            // Start → setup
            let result = startWorkflow(def, state, ctx);
            expect(result.nextAction.nodeId).toBe('setup');

            // Complete setup → loop activates → gate evaluates → fails → goto setup
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 'setup' }, ctx);

            // Gate should fail (artifact doesn't exist) and goto setup
            expect(result.state.nodes['setup'].status).toBe('active');
            expect(result.state.nodes['setup'].retryCount).toBe(1);
            // Loop should be reset (goto target is outside loop)
            expect(result.state.nodes['dev-loop'].status).toBe('pending');
        });
    });

    // ─── initNodeStates with loop ───

    describe('initNodeStates with loop', () => {
        it('should create states for loop and its body nodes', () => {
            const def = makeDefinition({
                root: makeLoop('my-loop', makeSequence('body-seq', [makeTask('t1'), makeTask('t2')]), 5),
            });
            const states = initNodeStates(def);

            // my-loop, body-seq, t1, t2
            expect(states['my-loop']).toBeDefined();
            expect(states['body-seq']).toBeDefined();
            expect(states['t1']).toBeDefined();
            expect(states['t2']).toBeDefined();
            expect(states['my-loop'].status).toBe('pending');
            expect(states['body-seq'].status).toBe('pending');
        });

        it('should create states for nested loops', () => {
            const def = makeDefinition({
                root: makeLoop('outer-loop', makeLoop('inner-loop', makeTask('work'), 3), 5),
            });
            const states = initNodeStates(def);

            expect(states['outer-loop']).toBeDefined();
            expect(states['inner-loop']).toBeDefined();
            expect(states['work']).toBeDefined();
        });
    });

    // ─── Nested loop runtime ───

    describe('nested loop runtime', () => {
        it('should handle inner loop_done while outer loop continues iterating', () => {
            // outer-loop body = inner-loop body = task
            const def = makeDefinition({
                root: makeLoop('outer-loop', makeLoop('inner-loop', makeTask('work'), 5), 3),
            });
            const state = makeState(def);
            const ctx = makeContext();

            // Start → outer-loop activates → inner-loop activates → work dispatched
            let result = startWorkflow(def, state, ctx);
            expect(result.nextAction.nodeId).toBe('work');
            expect(result.state.nodes['outer-loop'].status).toBe('active');
            expect(result.state.nodes['inner-loop'].status).toBe('active');

            // Complete work (inner iteration 0) → inner loops back (iteration 1) → work dispatched
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 'work' }, ctx);
            expect(result.nextAction.nodeId).toBe('work');
            const innerState = result.state.nodes['inner-loop'] as LoopNodeState;
            expect(innerState.currentIteration).toBe(1);

            // Signal inner loop done
            result = computeNextAction(def, result.state, { type: 'loop_done', nodeId: 'inner-loop' }, ctx);
            expect((result.state.nodes['inner-loop'] as LoopNodeState).done).toBe(true);

            // Complete work → inner loop terminates (done=true) → outer loop iterates → inner-loop reactivated → work dispatched
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 'work' }, ctx);
            expect(result.nextAction.nodeId).toBe('work');
            // Outer loop should be on iteration 1 now
            const outerState = result.state.nodes['outer-loop'] as LoopNodeState;
            expect(outerState.currentIteration).toBe(1);
            // Inner loop should be reset (new iteration, done cleared)
            const innerState2 = result.state.nodes['inner-loop'] as LoopNodeState;
            expect(innerState2.currentIteration).toBe(0);
            expect(innerState2.done).toBeFalsy();
        });
    });

    // ─── Loop with parallel body ───

    describe('loop with parallel body', () => {
        it('should iterate after parallel body completes', () => {
            const def = makeDefinition({
                root: makeLoop('my-loop', makeParallel('par', [makeTask('t1'), makeTask('t2')]), 3),
            });
            const state = makeState(def);
            const ctx = makeContext();

            // Start → loop activates → parallel activates → both tasks dispatched
            let result = startWorkflow(def, state, ctx);
            expect(result.state.nodes['t1'].status).toBe('active');
            expect(result.state.nodes['t2'].status).toBe('active');

            // Complete t1
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 't1' }, ctx);
            // parallel not done yet, waiting for t2
            expect(result.nextAction.type).toBe('wait');

            // Complete t2 → parallel completes → loop iterates (iteration 1) → parallel reactivated
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 't2' }, ctx);
            const loopState = result.state.nodes['my-loop'] as LoopNodeState;
            expect(loopState.currentIteration).toBe(1);
            expect(result.state.nodes['t1'].status).toBe('active');
            expect(result.state.nodes['t2'].status).toBe('active');

            // Signal loop done
            result = computeNextAction(def, result.state, { type: 'loop_done', nodeId: 'my-loop' }, ctx);
            expect((result.state.nodes['my-loop'] as LoopNodeState).done).toBe(true);

            // Complete t1, t2 → parallel completes → loop terminates (done=true)
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 't1' }, ctx);
            result = computeNextAction(def, result.state, { type: 'node_completed', nodeId: 't2' }, ctx);
            expect(result.state.nodes['my-loop'].status).toBe('completed');
        });
    });
});
