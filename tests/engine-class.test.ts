/**
 * Tests for the Engine class (stateful wrapper around pure engine functions).
 *
 * Verifies:
 * - start() triggers node.activated events
 * - handleEvent() correctly emits node.completed, node.failed, node.activated
 * - getState() / getNextAction() / getDefinition() accessors
 * - Parallel dispatch emits multiple node.activated events
 */

import { describe, it, expect } from 'vitest';
import { Engine, initNodeStates } from '../src/core/workflow-engine.js';
import type { EngineContext, GateContext } from '../src/core/workflow-engine.js';
import { EventBus } from '../src/core/event-bus.js';
import type { NodeActivatedEvent, NodeCompletedEvent, NodeFailedEvent } from '../src/core/event-bus.js';
import type {
    WorkflowDefinition,
    WorkflowNode,
    TaskNode,
    SequenceNode,
    ParallelNode,
    GateNode,
    GateCondition,
    WorkflowState,
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
    fail: WorkflowNode,
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

// ─── Tests ───

describe('Engine class', () => {
    // ─── start() ───

    describe('start', () => {
        it('should return a dispatch action for the first task', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1', 'architect')]),
            });
            const bus = new EventBus();
            const engine = new Engine(def, makeState(def), makeContext(), bus);

            const action = engine.start();

            expect(action.type).toBe('dispatch');
            expect(action.nodeId).toBe('t1');
            expect(action.role).toBe('architect');
        });

        it('should emit node.activated when starting', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1', 'architect')]),
            });
            const bus = new EventBus();
            const activated: NodeActivatedEvent[] = [];
            bus.on('node.activated', (e) => activated.push(e));

            const engine = new Engine(def, makeState(def), makeContext(), bus);
            engine.start();

            expect(activated).toHaveLength(1);
            expect(activated[0].nodeId).toBe('t1');
            expect(activated[0].role).toBe('architect');
            expect(activated[0].ts).toBeGreaterThan(0);
        });

        it('should update internal state after start', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1')]),
            });
            const bus = new EventBus();
            const engine = new Engine(def, makeState(def), makeContext(), bus);

            engine.start();

            const state = engine.getState();
            expect(state.nodes['t1'].status).toBe('active');
        });
    });

    // ─── handleEvent() ───

    describe('handleEvent', () => {
        it('should advance to next task on node_completed', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1'), makeTask('t2')]),
            });
            const bus = new EventBus();
            const engine = new Engine(def, makeState(def), makeContext(), bus);

            engine.start();
            const action = engine.handleEvent({ type: 'node_completed', nodeId: 't1' });

            expect(action.type).toBe('dispatch');
            expect(action.nodeId).toBe('t2');
        });

        it('should emit node.completed when a node completes', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1'), makeTask('t2')]),
            });
            const bus = new EventBus();
            const completed: NodeCompletedEvent[] = [];
            bus.on('node.completed', (e) => completed.push(e));

            const engine = new Engine(def, makeState(def), makeContext(), bus);
            engine.start();
            engine.handleEvent({ type: 'node_completed', nodeId: 't1' });

            expect(completed).toHaveLength(1);
            expect(completed[0].nodeId).toBe('t1');
            expect(completed[0].role).toBe('developer');
        });

        it('should emit node.activated for the next task after completion', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1'), makeTask('t2', 'architect')]),
            });
            const bus = new EventBus();
            const activated: NodeActivatedEvent[] = [];
            bus.on('node.activated', (e) => activated.push(e));

            const engine = new Engine(def, makeState(def), makeContext(), bus);
            engine.start(); // activates t1
            activated.length = 0; // clear

            engine.handleEvent({ type: 'node_completed', nodeId: 't1' });

            // t2 should be activated
            expect(activated).toHaveLength(1);
            expect(activated[0].nodeId).toBe('t2');
            expect(activated[0].role).toBe('architect');
        });

        it('should emit node.failed when a node fails', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1')]),
            });
            const bus = new EventBus();
            const failed: NodeFailedEvent[] = [];
            bus.on('node.failed', (e) => failed.push(e));

            const engine = new Engine(def, makeState(def), makeContext(), bus);
            engine.start();
            engine.handleEvent({ type: 'node_failed', nodeId: 't1', error: 'boom' });

            // t1 fails, and parent sequence 'main' also transitions to failed
            const t1Failed = failed.find((e) => e.nodeId === 't1');
            expect(t1Failed).toBeDefined();
            expect(t1Failed!.error).toContain('t1');

            const mainFailed = failed.find((e) => e.nodeId === 'main');
            expect(mainFailed).toBeDefined();
        });

        it('should return completed action when all tasks done', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1')]),
            });
            const bus = new EventBus();
            const engine = new Engine(def, makeState(def), makeContext(), bus);

            engine.start();
            const action = engine.handleEvent({ type: 'node_completed', nodeId: 't1' });

            expect(action.type).toBe('completed');
        });

        it('should track state through multiple steps', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1'), makeTask('t2'), makeTask('t3')]),
            });
            const bus = new EventBus();
            const engine = new Engine(def, makeState(def), makeContext(), bus);

            engine.start();
            engine.handleEvent({ type: 'node_completed', nodeId: 't1' });
            engine.handleEvent({ type: 'node_completed', nodeId: 't2' });
            const action = engine.handleEvent({ type: 'node_completed', nodeId: 't3' });

            expect(action.type).toBe('completed');
            const state = engine.getState();
            expect(state.nodes['t1'].status).toBe('completed');
            expect(state.nodes['t2'].status).toBe('completed');
            expect(state.nodes['t3'].status).toBe('completed');
        });
    });

    // ─── Parallel dispatch events ───

    describe('parallel dispatch events', () => {
        it('should emit node.activated for each parallel child', () => {
            const def = makeDefinition({
                root: makeParallel('par', [makeTask('p1', 'developer'), makeTask('p2', 'architect')]),
            });
            const bus = new EventBus();
            const activated: NodeActivatedEvent[] = [];
            bus.on('node.activated', (e) => activated.push(e));

            const engine = new Engine(def, makeState(def), makeContext(), bus);
            engine.start();

            // Should have node.activated for p1 and p2 (may also have par itself via dispatch)
            const childActivations = activated.filter((a) => a.nodeId === 'p1' || a.nodeId === 'p2');
            expect(childActivations).toHaveLength(2);

            const nodeIds = childActivations.map((a) => a.nodeId).sort();
            expect(nodeIds).toEqual(['p1', 'p2']);

            const roles = childActivations.map((a) => a.role).sort();
            expect(roles).toEqual(['architect', 'developer']);
        });
    });

    // ─── Accessors ───

    describe('accessors', () => {
        it('getDefinition should return the workflow definition', () => {
            const def = makeDefinition({ name: 'my-workflow' });
            const bus = new EventBus();
            const engine = new Engine(def, makeState(def), makeContext(), bus);

            expect(engine.getDefinition()).toBe(def);
            expect(engine.getDefinition().name).toBe('my-workflow');
        });

        it('getNextAction should compute current action without side effects', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1')]),
            });
            const bus = new EventBus();
            const engine = new Engine(def, makeState(def), makeContext(), bus);

            engine.start();

            // getNextAction should reflect current state
            const action = engine.getNextAction();
            expect(action.type).toBe('dispatch');
            expect(action.nodeId).toBe('t1');
        });
    });
});
