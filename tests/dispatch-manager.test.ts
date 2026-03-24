/**
 * Tests for the DispatchManager class (orchestrator integration layer).
 *
 * Verifies:
 * - dispatch() creates a record and emits task.dispatched
 * - updateStatus() transitions dispatch status and clears timeouts on terminal
 * - Timeout timers fire task.timeout event and invoke onTimeout callback
 * - clearAllTimeouts() cancels all pending timers
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DispatchManager } from '../src/core/dispatch.js';
import type { ManagedDispatchOptions } from '../src/core/dispatch.js';
import { EventBus } from '../src/core/event-bus.js';
import type { TaskDispatchedEvent, TaskTimeoutEvent } from '../src/core/event-bus.js';

const TEST_PROJECT = 'test-project';
const ITER = 1;

// ─── Helpers ───

function makeDispatchOpts(contextDir: string, overrides: Partial<ManagedDispatchOptions> = {}): ManagedDispatchOptions {
    return {
        projectName: TEST_PROJECT,
        iteration: ITER,
        role: 'developer',
        taskBrief: 'Implement feature X',
        expectedOutputs: ['code'],
        nodeId: 'task-1',
        agentType: 'opencode',
        contextDir,
        ...overrides,
    };
}

// ─── Tests ───

describe('DispatchManager', () => {
    let harmoniaHome: string;
    let iterDir: string;

    beforeEach(async () => {
        harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-dm-'));
        iterDir = join(harmoniaHome, TEST_PROJECT, `iter-${ITER}`);
        await mkdir(iterDir, { recursive: true });
    });

    afterEach(async () => {
        await rm(harmoniaHome, { recursive: true, force: true });
    });

    // ─── dispatch() ───

    describe('dispatch', () => {
        it('should create a dispatch record', async () => {
            const bus = new EventBus();
            const dm = new DispatchManager(bus);

            const record = await dm.dispatch(makeDispatchOpts(iterDir));

            expect(record.id).toBe('dispatch-001');
            expect(record.role).toBe('developer');
            expect(record.status).toBe('dispatched');
            expect(record.taskBrief).toBe('Implement feature X');
        });

        it('should emit task.dispatched event', async () => {
            const bus = new EventBus();
            const dispatched: TaskDispatchedEvent[] = [];
            bus.on('task.dispatched', (e) => dispatched.push(e));

            const dm = new DispatchManager(bus);
            await dm.dispatch(makeDispatchOpts(iterDir));

            expect(dispatched).toHaveLength(1);
            expect(dispatched[0].nodeId).toBe('task-1');
            expect(dispatched[0].role).toBe('developer');
            expect(dispatched[0].agentType).toBe('opencode');
            expect(dispatched[0].dispatchId).toBe('dispatch-001');
        });

        it('should auto-increment dispatch IDs', async () => {
            const bus = new EventBus();
            const dm = new DispatchManager(bus);

            const r1 = await dm.dispatch(makeDispatchOpts(iterDir));
            const r2 = await dm.dispatch(makeDispatchOpts(iterDir, { role: 'architect', nodeId: 'task-2' }));

            expect(r1.id).toBe('dispatch-001');
            expect(r2.id).toBe('dispatch-002');
        });
    });

    // ─── updateStatus() ───

    describe('updateStatus', () => {
        it('should update dispatch status to running', async () => {
            const bus = new EventBus();
            const dm = new DispatchManager(bus);

            const record = await dm.dispatch(makeDispatchOpts(iterDir));
            const updated = await dm.updateStatus(TEST_PROJECT, ITER, record.id, 'running', iterDir);

            expect(updated.status).toBe('running');
        });

        it('should update dispatch status to completed', async () => {
            const bus = new EventBus();
            const dm = new DispatchManager(bus);

            const record = await dm.dispatch(makeDispatchOpts(iterDir));
            const updated = await dm.updateStatus(TEST_PROJECT, ITER, record.id, 'completed', iterDir);

            expect(updated.status).toBe('completed');
        });

        it('should update dispatch status to failed with note', async () => {
            const bus = new EventBus();
            const dm = new DispatchManager(bus);

            const record = await dm.dispatch(makeDispatchOpts(iterDir));
            const updated = await dm.updateStatus(TEST_PROJECT, ITER, record.id, 'failed', iterDir, 'Agent crashed');

            expect(updated.status).toBe('failed');
            expect(updated.note).toBe('Agent crashed');
        });
    });

    // ─── Timeout ───

    describe('timeout', () => {
        it('should emit task.timeout when timer fires', async () => {
            vi.useFakeTimers();
            try {
                const bus = new EventBus();
                const timeoutEvents: TaskTimeoutEvent[] = [];
                bus.on('task.timeout', (e) => timeoutEvents.push(e));

                const dm = new DispatchManager(bus);
                await dm.dispatch(makeDispatchOpts(iterDir, { timeout: 5 }));

                expect(timeoutEvents).toHaveLength(0);

                vi.advanceTimersByTime(5000);

                expect(timeoutEvents).toHaveLength(1);
                expect(timeoutEvents[0].nodeId).toBe('task-1');
                expect(timeoutEvents[0].dispatchId).toBe('dispatch-001');
                expect(timeoutEvents[0].elapsed).toBe(5);
            } finally {
                vi.useRealTimers();
            }
        });

        it('should invoke onTimeout callback when timer fires', async () => {
            vi.useFakeTimers();
            try {
                const bus = new EventBus();
                const dm = new DispatchManager(bus);
                const calls: Array<{ dispatchId: string; nodeId: string; elapsed: number }> = [];
                dm.onTimeout((dispatchId, nodeId, elapsed) => {
                    calls.push({ dispatchId, nodeId, elapsed });
                });

                await dm.dispatch(makeDispatchOpts(iterDir, { timeout: 10 }));
                vi.advanceTimersByTime(10_000);

                expect(calls).toHaveLength(1);
                expect(calls[0].dispatchId).toBe('dispatch-001');
                expect(calls[0].nodeId).toBe('task-1');
                expect(calls[0].elapsed).toBe(10);
            } finally {
                vi.useRealTimers();
            }
        });

        it('should not set timer when timeout is undefined', async () => {
            vi.useFakeTimers();
            try {
                const bus = new EventBus();
                const timeoutEvents: TaskTimeoutEvent[] = [];
                bus.on('task.timeout', (e) => timeoutEvents.push(e));

                const dm = new DispatchManager(bus);
                await dm.dispatch(makeDispatchOpts(iterDir)); // no timeout

                vi.advanceTimersByTime(60_000); // advance far

                expect(timeoutEvents).toHaveLength(0);
            } finally {
                vi.useRealTimers();
            }
        });

        it('should clear timeout on terminal status update', async () => {
            vi.useFakeTimers();
            try {
                const bus = new EventBus();
                const timeoutEvents: TaskTimeoutEvent[] = [];
                bus.on('task.timeout', (e) => timeoutEvents.push(e));

                const dm = new DispatchManager(bus);
                const record = await dm.dispatch(makeDispatchOpts(iterDir, { timeout: 10 }));

                // Complete the dispatch before timeout fires
                await dm.updateStatus(TEST_PROJECT, ITER, record.id, 'completed', iterDir);

                vi.advanceTimersByTime(15_000);

                // Timeout should not fire because dispatch completed
                expect(timeoutEvents).toHaveLength(0);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    // ─── clearAllTimeouts() ───

    describe('clearAllTimeouts', () => {
        it('should cancel all pending timers', async () => {
            vi.useFakeTimers();
            try {
                const bus = new EventBus();
                const timeoutEvents: TaskTimeoutEvent[] = [];
                bus.on('task.timeout', (e) => timeoutEvents.push(e));

                const dm = new DispatchManager(bus);
                await dm.dispatch(makeDispatchOpts(iterDir, { timeout: 5, nodeId: 'n1' }));
                await dm.dispatch(makeDispatchOpts(iterDir, { timeout: 10, nodeId: 'n2' }));

                dm.clearAllTimeouts();

                vi.advanceTimersByTime(15_000);

                expect(timeoutEvents).toHaveLength(0);
            } finally {
                vi.useRealTimers();
            }
        });
    });
});
