import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../src/core/event-bus.js';
import type {
    NodeActivatedEvent,
    NodeCompletedEvent,
    NodeFailedEvent,
    ArtifactWrittenEvent,
    ArtifactApprovedEvent,
    GateEvaluatedEvent,
    TaskDispatchedEvent,
    TaskTimeoutEvent,
} from '../src/core/event-bus.js';

// ─── Tests ───

describe('EventBus', () => {
    // ─── Basic emit / on ───

    describe('on / emit', () => {
        it('should deliver payload to a registered listener', () => {
            const bus = new EventBus();
            const received: NodeCompletedEvent[] = [];
            bus.on('node.completed', (e) => received.push(e));

            const payload: NodeCompletedEvent = { nodeId: 'n1', role: 'dev', ts: 1000 };
            bus.emit('node.completed', payload);

            expect(received).toHaveLength(1);
            expect(received[0]).toEqual(payload);
        });

        it('should deliver to multiple listeners', () => {
            const bus = new EventBus();
            const a: string[] = [];
            const b: string[] = [];
            bus.on('node.activated', (e) => a.push(e.nodeId));
            bus.on('node.activated', (e) => b.push(e.nodeId));

            bus.emit('node.activated', { nodeId: 'x', role: 'r', ts: 1 });

            expect(a).toEqual(['x']);
            expect(b).toEqual(['x']);
        });

        it('should not deliver events of a different type', () => {
            const bus = new EventBus();
            const received: NodeCompletedEvent[] = [];
            bus.on('node.completed', (e) => received.push(e));

            bus.emit('node.failed', { nodeId: 'n1', role: 'dev', error: 'oops', ts: 1 });

            expect(received).toHaveLength(0);
        });

        it('should return true when there are listeners', () => {
            const bus = new EventBus();
            bus.on('node.completed', () => {});
            expect(bus.emit('node.completed', { nodeId: 'n', role: 'r', ts: 1 })).toBe(true);
        });

        it('should return false when there are no listeners', () => {
            const bus = new EventBus();
            expect(bus.emit('node.completed', { nodeId: 'n', role: 'r', ts: 1 })).toBe(false);
        });
    });

    // ─── once ───

    describe('once', () => {
        it('should fire listener only once', () => {
            const bus = new EventBus();
            const received: string[] = [];
            bus.once('node.activated', (e) => received.push(e.nodeId));

            bus.emit('node.activated', { nodeId: 'a', role: 'r', ts: 1 });
            bus.emit('node.activated', { nodeId: 'b', role: 'r', ts: 2 });

            expect(received).toEqual(['a']);
        });
    });

    // ─── off ───

    describe('off', () => {
        it('should remove a specific listener', () => {
            const bus = new EventBus();
            const received: string[] = [];
            const listener = (e: NodeCompletedEvent) => received.push(e.nodeId);

            bus.on('node.completed', listener);
            bus.emit('node.completed', { nodeId: 'a', role: 'r', ts: 1 });

            bus.off('node.completed', listener);
            bus.emit('node.completed', { nodeId: 'b', role: 'r', ts: 2 });

            expect(received).toEqual(['a']);
        });

        it('should not affect other listeners on the same event', () => {
            const bus = new EventBus();
            const a: string[] = [];
            const b: string[] = [];
            const listenerA = (e: NodeCompletedEvent) => a.push(e.nodeId);
            const listenerB = (e: NodeCompletedEvent) => b.push(e.nodeId);

            bus.on('node.completed', listenerA);
            bus.on('node.completed', listenerB);
            bus.off('node.completed', listenerA);

            bus.emit('node.completed', { nodeId: 'x', role: 'r', ts: 1 });

            expect(a).toEqual([]);
            expect(b).toEqual(['x']);
        });
    });

    // ─── removeAllListeners ───

    describe('removeAllListeners', () => {
        it('should remove all listeners for a specific event', () => {
            const bus = new EventBus();
            bus.on('node.completed', () => {});
            bus.on('node.completed', () => {});
            bus.on('node.failed', () => {});

            bus.removeAllListeners('node.completed');

            expect(bus.listenerCount('node.completed')).toBe(0);
            expect(bus.listenerCount('node.failed')).toBe(1);
        });

        it('should remove all listeners when no event specified', () => {
            const bus = new EventBus();
            bus.on('node.completed', () => {});
            bus.on('node.failed', () => {});
            bus.on('node.activated', () => {});

            bus.removeAllListeners();

            expect(bus.listenerCount('node.completed')).toBe(0);
            expect(bus.listenerCount('node.failed')).toBe(0);
            expect(bus.listenerCount('node.activated')).toBe(0);
        });
    });

    // ─── listenerCount ───

    describe('listenerCount', () => {
        it('should return 0 for events with no listeners', () => {
            const bus = new EventBus();
            expect(bus.listenerCount('gate.evaluated')).toBe(0);
        });

        it('should reflect added and removed listeners', () => {
            const bus = new EventBus();
            const fn = () => {};

            bus.on('gate.evaluated', fn);
            expect(bus.listenerCount('gate.evaluated')).toBe(1);

            bus.on('gate.evaluated', () => {});
            expect(bus.listenerCount('gate.evaluated')).toBe(2);

            bus.off('gate.evaluated', fn);
            expect(bus.listenerCount('gate.evaluated')).toBe(1);
        });
    });

    // ─── Chaining ───

    describe('chaining', () => {
        it('should support method chaining for on/once/off', () => {
            const bus = new EventBus();
            const fn = () => {};
            const result = bus.on('node.activated', fn).once('node.completed', fn).off('node.activated', fn);
            expect(result).toBe(bus);
        });
    });

    // ─── All event types ───

    describe('all event types', () => {
        it('should handle node.activated events', () => {
            const bus = new EventBus();
            let received: NodeActivatedEvent | undefined;
            bus.on('node.activated', (e) => {
                received = e;
            });
            bus.emit('node.activated', { nodeId: 'n1', role: 'architect', ts: 100 });
            expect(received).toEqual({ nodeId: 'n1', role: 'architect', ts: 100 });
        });

        it('should handle node.failed events', () => {
            const bus = new EventBus();
            let received: NodeFailedEvent | undefined;
            bus.on('node.failed', (e) => {
                received = e;
            });
            bus.emit('node.failed', { nodeId: 'n1', role: 'dev', error: 'timeout', ts: 200 });
            expect(received?.error).toBe('timeout');
        });

        it('should handle artifact.written events', () => {
            const bus = new EventBus();
            let received: ArtifactWrittenEvent | undefined;
            bus.on('artifact.written', (e) => {
                received = e;
            });
            bus.emit('artifact.written', { artifactId: 'prd', nodeId: 'n1', path: '/tmp/prd.md', ts: 300 });
            expect(received?.artifactId).toBe('prd');
        });

        it('should handle artifact.approved events', () => {
            const bus = new EventBus();
            let received: ArtifactApprovedEvent | undefined;
            bus.on('artifact.approved', (e) => {
                received = e;
            });
            bus.emit('artifact.approved', { artifactId: 'prd', approvedBy: 'coordinator', ts: 400 });
            expect(received?.approvedBy).toBe('coordinator');
        });

        it('should handle gate.evaluated events', () => {
            const bus = new EventBus();
            let received: GateEvaluatedEvent | undefined;
            bus.on('gate.evaluated', (e) => {
                received = e;
            });
            bus.emit('gate.evaluated', { nodeId: 'g1', passed: true, ts: 500 });
            expect(received?.passed).toBe(true);
        });

        it('should handle task.dispatched events', () => {
            const bus = new EventBus();
            let received: TaskDispatchedEvent | undefined;
            bus.on('task.dispatched', (e) => {
                received = e;
            });
            bus.emit('task.dispatched', {
                nodeId: 'n1',
                role: 'dev',
                dispatchId: 'd-001',
                agentType: 'opencode',
                ts: 600,
            });
            expect(received?.dispatchId).toBe('d-001');
        });

        it('should handle task.timeout events', () => {
            const bus = new EventBus();
            let received: TaskTimeoutEvent | undefined;
            bus.on('task.timeout', (e) => {
                received = e;
            });
            bus.emit('task.timeout', { nodeId: 'n1', dispatchId: 'd-001', elapsed: 300, ts: 700 });
            expect(received?.elapsed).toBe(300);
        });
    });
});
