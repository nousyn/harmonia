/**
 * Tests for P1 Tool Guard logic.
 *
 * Tests the pure-function guard helpers exported from core/dispatch.ts.
 * These unit tests cover the extracted state machine logic.
 */

import { describe, it, expect } from 'vitest';
import { DISPATCH_TRANSITIONS, isValidTransition, isTerminalStatus } from '../src/core/dispatch.js';
import type { DispatchStatus } from '../src/core/types.js';

// ─── Dispatch State Machine ───

describe('dispatch state machine', () => {
    describe('DISPATCH_TRANSITIONS', () => {
        it('should define transitions for all dispatch statuses', () => {
            const allStatuses: DispatchStatus[] = ['dispatched', 'running', 'completed', 'failed', 'cancelled'];
            for (const status of allStatuses) {
                expect(DISPATCH_TRANSITIONS).toHaveProperty(status);
                expect(Array.isArray(DISPATCH_TRANSITIONS[status])).toBe(true);
            }
        });

        it('should allow dispatched → running', () => {
            expect(DISPATCH_TRANSITIONS.dispatched).toContain('running');
        });

        it('should allow dispatched → cancelled', () => {
            expect(DISPATCH_TRANSITIONS.dispatched).toContain('cancelled');
        });

        it('should allow running → completed', () => {
            expect(DISPATCH_TRANSITIONS.running).toContain('completed');
        });

        it('should allow running → failed', () => {
            expect(DISPATCH_TRANSITIONS.running).toContain('failed');
        });

        it('should allow running → cancelled', () => {
            expect(DISPATCH_TRANSITIONS.running).toContain('cancelled');
        });

        it('should have no transitions from completed', () => {
            expect(DISPATCH_TRANSITIONS.completed).toEqual([]);
        });

        it('should have no transitions from failed', () => {
            expect(DISPATCH_TRANSITIONS.failed).toEqual([]);
        });

        it('should have no transitions from cancelled', () => {
            expect(DISPATCH_TRANSITIONS.cancelled).toEqual([]);
        });
    });

    describe('isValidTransition', () => {
        // Valid transitions
        it('dispatched → running is valid', () => {
            expect(isValidTransition('dispatched', 'running')).toBe(true);
        });

        it('dispatched → cancelled is valid', () => {
            expect(isValidTransition('dispatched', 'cancelled')).toBe(true);
        });

        it('running → completed is valid', () => {
            expect(isValidTransition('running', 'completed')).toBe(true);
        });

        it('running → failed is valid', () => {
            expect(isValidTransition('running', 'failed')).toBe(true);
        });

        it('running → cancelled is valid', () => {
            expect(isValidTransition('running', 'cancelled')).toBe(true);
        });

        // Invalid transitions
        it('dispatched → completed is invalid (must go through running)', () => {
            expect(isValidTransition('dispatched', 'completed')).toBe(false);
        });

        it('dispatched → failed is invalid', () => {
            expect(isValidTransition('dispatched', 'failed')).toBe(false);
        });

        it('dispatched → dispatched is invalid (self-transition)', () => {
            expect(isValidTransition('dispatched', 'dispatched')).toBe(false);
        });

        it('running → dispatched is invalid (backward)', () => {
            expect(isValidTransition('running', 'dispatched')).toBe(false);
        });

        it('running → running is invalid (self-transition)', () => {
            expect(isValidTransition('running', 'running')).toBe(false);
        });

        // Terminal state transitions (all invalid)
        it('completed → running is invalid (terminal)', () => {
            expect(isValidTransition('completed', 'running')).toBe(false);
        });

        it('completed → dispatched is invalid (terminal)', () => {
            expect(isValidTransition('completed', 'dispatched')).toBe(false);
        });

        it('completed → failed is invalid (terminal)', () => {
            expect(isValidTransition('completed', 'failed')).toBe(false);
        });

        it('completed → cancelled is invalid (terminal)', () => {
            expect(isValidTransition('completed', 'cancelled')).toBe(false);
        });

        it('failed → running is invalid (terminal)', () => {
            expect(isValidTransition('failed', 'running')).toBe(false);
        });

        it('failed → completed is invalid (terminal)', () => {
            expect(isValidTransition('failed', 'completed')).toBe(false);
        });

        it('cancelled → running is invalid (terminal)', () => {
            expect(isValidTransition('cancelled', 'running')).toBe(false);
        });

        it('cancelled → dispatched is invalid (terminal)', () => {
            expect(isValidTransition('cancelled', 'dispatched')).toBe(false);
        });
    });

    describe('isTerminalStatus', () => {
        it('completed is terminal', () => {
            expect(isTerminalStatus('completed')).toBe(true);
        });

        it('failed is terminal', () => {
            expect(isTerminalStatus('failed')).toBe(true);
        });

        it('cancelled is terminal', () => {
            expect(isTerminalStatus('cancelled')).toBe(true);
        });

        it('dispatched is NOT terminal', () => {
            expect(isTerminalStatus('dispatched')).toBe(false);
        });

        it('running is NOT terminal', () => {
            expect(isTerminalStatus('running')).toBe(false);
        });
    });

    describe('full transition matrix', () => {
        const allStatuses: DispatchStatus[] = ['dispatched', 'running', 'completed', 'failed', 'cancelled'];

        // Expected valid transitions as a set of "from→to" strings
        const expectedValid = new Set([
            'dispatched→running',
            'dispatched→cancelled',
            'running→completed',
            'running→failed',
            'running→cancelled',
        ]);

        for (const from of allStatuses) {
            for (const to of allStatuses) {
                const key = `${from}→${to}`;
                const shouldBeValid = expectedValid.has(key);

                it(`${key} should be ${shouldBeValid ? 'valid' : 'invalid'}`, () => {
                    expect(isValidTransition(from, to)).toBe(shouldBeValid);
                });
            }
        }
    });
});
