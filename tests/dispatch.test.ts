import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    createSession,
    updateSession,
    findIdleSession,
    findSessionByAgentId,
    readSessions,
    createDispatch,
    updateDispatch,
    getDispatch,
    readDispatches,
} from '../src/core/dispatch.js';

const TEST_PROJECT = 'test-project';
const TEST_PROJECT_B = 'test-project-b';
const ITER = 1;

describe('dispatch & session tracking', () => {
    let harmoniaHome: string;

    beforeEach(async () => {
        harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-dispatch-'));
        process.env.HARMONIA_DATA_DIR = harmoniaHome;
        // Create the iteration dirs (normally done by startIteration)
        await mkdir(join(harmoniaHome, TEST_PROJECT, `iter-${ITER}`), { recursive: true });
        await mkdir(join(harmoniaHome, TEST_PROJECT_B, `iter-${ITER}`), { recursive: true });
    });

    afterEach(async () => {
        delete process.env.HARMONIA_DATA_DIR;
        await rm(harmoniaHome, { recursive: true, force: true });
    });

    // ─── Session CRUD ───

    describe('sessions', () => {
        it('should return empty array when no sessions exist', async () => {
            const sessions = await readSessions(TEST_PROJECT, ITER);
            expect(sessions).toEqual([]);
        });

        it('should create a session with auto-incremented ID', async () => {
            const s1 = await createSession(TEST_PROJECT, ITER, 'architect', 'opencode');
            expect(s1.id).toBe('ses-001');
            expect(s1.role).toBe('architect');
            expect(s1.agentType).toBe('opencode');
            expect(s1.status).toBe('active');
            expect(s1.createdAt).toBeDefined();
            expect(s1.lastActiveAt).toBeDefined();

            const s2 = await createSession(TEST_PROJECT, ITER, 'developer', 'opencode', 'dev-auth');
            expect(s2.id).toBe('ses-002');
            expect(s2.label).toBe('dev-auth');
        });

        it('should update session fields', async () => {
            const s = await createSession(TEST_PROJECT, ITER, 'architect');
            const updated = await updateSession(TEST_PROJECT, ITER, s.id, {
                status: 'idle',
                agentSessionId: 'agent-abc-123',
                agentType: 'opencode',
                label: 'arch-main',
            });

            expect(updated.status).toBe('idle');
            expect(updated.agentSessionId).toBe('agent-abc-123');
            expect(updated.agentType).toBe('opencode');
            expect(updated.label).toBe('arch-main');
            // lastActiveAt is always set on update
            expect(updated.lastActiveAt).toBeDefined();
        });

        it('should throw when updating non-existent session', async () => {
            await expect(updateSession(TEST_PROJECT, ITER, 'ses-999', { status: 'idle' })).rejects.toThrow(
                'Session "ses-999" not found',
            );
        });

        it('should find idle session for a role', async () => {
            await createSession(TEST_PROJECT, ITER, 'architect');
            const s2 = await createSession(TEST_PROJECT, ITER, 'architect');
            // Make s2 idle
            await updateSession(TEST_PROJECT, ITER, s2.id, { status: 'idle' });

            const found = await findIdleSession(TEST_PROJECT, ITER, 'architect');
            expect(found).not.toBeNull();
            expect(found!.id).toBe('ses-002');
            expect(found!.status).toBe('idle');
        });

        it('should return null when no idle session for role', async () => {
            await createSession(TEST_PROJECT, ITER, 'architect'); // active, not idle
            const found = await findIdleSession(TEST_PROJECT, ITER, 'architect');
            expect(found).toBeNull();
        });

        it('should not find idle session for different role', async () => {
            const s = await createSession(TEST_PROJECT, ITER, 'architect');
            await updateSession(TEST_PROJECT, ITER, s.id, { status: 'idle' });

            const found = await findIdleSession(TEST_PROJECT, ITER, 'developer');
            expect(found).toBeNull();
        });

        it('should find session by agent session ID', async () => {
            const s = await createSession(TEST_PROJECT, ITER, 'architect');
            await updateSession(TEST_PROJECT, ITER, s.id, { agentSessionId: 'agent-xyz' });

            const found = await findSessionByAgentId(TEST_PROJECT, ITER, 'architect', 'agent-xyz');
            expect(found).not.toBeNull();
            expect(found!.id).toBe(s.id);
        });

        it('should return null when agent session ID not found', async () => {
            const found = await findSessionByAgentId(TEST_PROJECT, ITER, 'architect', 'nonexistent');
            expect(found).toBeNull();
        });

        it('should find most recently active idle session', async () => {
            const s1 = await createSession(TEST_PROJECT, ITER, 'developer');
            const s2 = await createSession(TEST_PROJECT, ITER, 'developer');
            await updateSession(TEST_PROJECT, ITER, s1.id, { status: 'idle' });
            // Small delay to ensure s2 gets a later lastActiveAt timestamp
            await new Promise((r) => setTimeout(r, 10));
            await updateSession(TEST_PROJECT, ITER, s2.id, { status: 'idle' });

            const found = await findIdleSession(TEST_PROJECT, ITER, 'developer');
            // s2 was updated more recently
            expect(found!.id).toBe('ses-002');
        });
    });

    // ─── Dispatch CRUD ───

    describe('dispatches', () => {
        it('should return empty array when no dispatches exist', async () => {
            const dispatches = await readDispatches(TEST_PROJECT, ITER);
            expect(dispatches).toEqual([]);
        });

        it('should create a dispatch with auto-incremented ID', async () => {
            const d1 = await createDispatch(TEST_PROJECT, ITER, 'architect', 'Design the system', [
                'tech-design',
                'task-breakdown',
            ]);
            expect(d1.id).toBe('dispatch-001');
            expect(d1.role).toBe('architect');
            expect(d1.taskBrief).toBe('Design the system');
            expect(d1.status).toBe('dispatched');
            expect(d1.expectedOutputs).toEqual(['tech-design', 'task-breakdown']);
            expect(d1.createdAt).toBeDefined();
            expect(d1.updatedAt).toBeDefined();
            expect(d1.sessionId).toBeUndefined();

            const d2 = await createDispatch(TEST_PROJECT, ITER, 'developer', 'Implement auth', ['code'], 'ses-001');
            expect(d2.id).toBe('dispatch-002');
            expect(d2.sessionId).toBe('ses-001');
        });

        it('should update dispatch status', async () => {
            const d = await createDispatch(TEST_PROJECT, ITER, 'architect', 'Design', ['tech-design']);
            const updated = await updateDispatch(TEST_PROJECT, ITER, d.id, { status: 'running' });

            expect(updated.status).toBe('running');
            expect(updated.completedAt).toBeUndefined();
        });

        it('should set completedAt on terminal status', async () => {
            const d = await createDispatch(TEST_PROJECT, ITER, 'architect', 'Design', ['tech-design']);
            await updateDispatch(TEST_PROJECT, ITER, d.id, { status: 'running' });
            const completed = await updateDispatch(TEST_PROJECT, ITER, d.id, { status: 'completed' });

            expect(completed.status).toBe('completed');
            expect(completed.completedAt).toBeDefined();
        });

        it('should set completedAt on failed status', async () => {
            const d = await createDispatch(TEST_PROJECT, ITER, 'developer', 'Implement', []);
            const failed = await updateDispatch(TEST_PROJECT, ITER, d.id, {
                status: 'failed',
                note: 'Agent crashed',
            });

            expect(failed.status).toBe('failed');
            expect(failed.completedAt).toBeDefined();
            expect(failed.note).toBe('Agent crashed');
        });

        it('should throw when updating non-existent dispatch', async () => {
            await expect(updateDispatch(TEST_PROJECT, ITER, 'dispatch-999', { status: 'running' })).rejects.toThrow(
                'Dispatch "dispatch-999" not found',
            );
        });

        it('should get a single dispatch by ID', async () => {
            await createDispatch(TEST_PROJECT, ITER, 'architect', 'Design', ['tech-design']);
            const d = await getDispatch(TEST_PROJECT, ITER, 'dispatch-001');
            expect(d).not.toBeNull();
            expect(d!.role).toBe('architect');
        });

        it('should return null for non-existent dispatch', async () => {
            const d = await getDispatch(TEST_PROJECT, ITER, 'dispatch-999');
            expect(d).toBeNull();
        });

        it('should update dispatch sessionId', async () => {
            const d = await createDispatch(TEST_PROJECT, ITER, 'architect', 'Design', []);
            const updated = await updateDispatch(TEST_PROJECT, ITER, d.id, { sessionId: 'ses-001' });
            expect(updated.sessionId).toBe('ses-001');
        });
    });

    // ─── Project Isolation ───

    describe('project isolation', () => {
        it('should isolate sessions between projects', async () => {
            await createSession(TEST_PROJECT, ITER, 'architect');
            await createSession(TEST_PROJECT_B, ITER, 'architect');

            const sessionsA = await readSessions(TEST_PROJECT, ITER);
            const sessionsB = await readSessions(TEST_PROJECT_B, ITER);

            expect(sessionsA).toHaveLength(1);
            expect(sessionsB).toHaveLength(1);
            // Both get ses-001 since they are independent
            expect(sessionsA[0].id).toBe('ses-001');
            expect(sessionsB[0].id).toBe('ses-001');
        });

        it('should isolate dispatches between projects', async () => {
            await createDispatch(TEST_PROJECT, ITER, 'architect', 'Task A', []);
            await createDispatch(TEST_PROJECT_B, ITER, 'developer', 'Task B', []);

            const dispA = await readDispatches(TEST_PROJECT, ITER);
            const dispB = await readDispatches(TEST_PROJECT_B, ITER);

            expect(dispA).toHaveLength(1);
            expect(dispA[0].role).toBe('architect');
            expect(dispB).toHaveLength(1);
            expect(dispB[0].role).toBe('developer');
        });

        it('should not find idle session from another project', async () => {
            const s = await createSession(TEST_PROJECT, ITER, 'architect');
            await updateSession(TEST_PROJECT, ITER, s.id, { status: 'idle' });

            const found = await findIdleSession(TEST_PROJECT_B, ITER, 'architect');
            expect(found).toBeNull();
        });
    });

    // ─── Full Lifecycle ───

    describe('full dispatch lifecycle', () => {
        it('should support dispatch → launch → complete flow', async () => {
            // Step 1: Create dispatch
            const dispatch = await createDispatch(TEST_PROJECT, ITER, 'architect', 'Design the system', [
                'tech-design',
            ]);
            expect(dispatch.status).toBe('dispatched');

            // Step 2: PM launches agent, creates session
            const session = await createSession(TEST_PROJECT, ITER, 'architect', 'opencode');
            await updateSession(TEST_PROJECT, ITER, session.id, { agentSessionId: 'agent-abc' });

            // Step 3: Associate session with dispatch, mark running
            await updateDispatch(TEST_PROJECT, ITER, dispatch.id, { sessionId: session.id, status: 'running' });

            // Step 4: Agent completes
            await updateDispatch(TEST_PROJECT, ITER, dispatch.id, { status: 'completed' });
            await updateSession(TEST_PROJECT, ITER, session.id, { status: 'idle' });

            // Verify final state
            const finalDispatch = await getDispatch(TEST_PROJECT, ITER, dispatch.id);
            expect(finalDispatch!.status).toBe('completed');
            expect(finalDispatch!.sessionId).toBe(session.id);
            expect(finalDispatch!.completedAt).toBeDefined();

            const sessions = await readSessions(TEST_PROJECT, ITER);
            expect(sessions[0].status).toBe('idle');
        });

        it('should support session reuse across multiple dispatches', async () => {
            // First dispatch
            const session = await createSession(TEST_PROJECT, ITER, 'architect', 'opencode');
            await updateSession(TEST_PROJECT, ITER, session.id, { agentSessionId: 'agent-abc', status: 'idle' });

            const d1 = await createDispatch(
                TEST_PROJECT,
                ITER,
                'architect',
                'Initial design',
                ['tech-design'],
                session.id,
            );
            await updateDispatch(TEST_PROJECT, ITER, d1.id, { status: 'running' });
            await updateSession(TEST_PROJECT, ITER, session.id, { status: 'active' });
            await updateDispatch(TEST_PROJECT, ITER, d1.id, { status: 'completed' });
            await updateSession(TEST_PROJECT, ITER, session.id, { status: 'idle' });

            // Second dispatch — reuse the same session
            const idle = await findIdleSession(TEST_PROJECT, ITER, 'architect');
            expect(idle).not.toBeNull();
            expect(idle!.id).toBe(session.id);

            const d2 = await createDispatch(
                TEST_PROJECT,
                ITER,
                'architect',
                'Revise design',
                ['tech-design'],
                idle!.id,
            );
            expect(d2.sessionId).toBe(session.id);

            // Verify both dispatches reference the same session
            const dispatches = await readDispatches(TEST_PROJECT, ITER);
            expect(dispatches).toHaveLength(2);
            expect(dispatches[0].sessionId).toBe(session.id);
            expect(dispatches[1].sessionId).toBe(session.id);
        });

        it('should support parallel developer dispatches with separate sessions', async () => {
            const s1 = await createSession(TEST_PROJECT, ITER, 'developer', 'opencode', 'dev-auth');
            const s2 = await createSession(TEST_PROJECT, ITER, 'developer', 'opencode', 'dev-export');

            const d1 = await createDispatch(TEST_PROJECT, ITER, 'developer', 'Implement auth module', ['code'], s1.id);
            const d2 = await createDispatch(
                TEST_PROJECT,
                ITER,
                'developer',
                'Implement export module',
                ['code'],
                s2.id,
            );

            await updateDispatch(TEST_PROJECT, ITER, d1.id, { status: 'running' });
            await updateDispatch(TEST_PROJECT, ITER, d2.id, { status: 'running' });

            // Complete one, the other still running
            await updateDispatch(TEST_PROJECT, ITER, d1.id, { status: 'completed' });
            await updateSession(TEST_PROJECT, ITER, s1.id, { status: 'idle' });

            const dispatches = await readDispatches(TEST_PROJECT, ITER);
            expect(dispatches.find((d) => d.id === d1.id)!.status).toBe('completed');
            expect(dispatches.find((d) => d.id === d2.id)!.status).toBe('running');

            const sessions = await readSessions(TEST_PROJECT, ITER);
            expect(sessions.find((s) => s.id === s1.id)!.status).toBe('idle');
            expect(sessions.find((s) => s.id === s2.id)!.status).toBe('active');
        });
    });
});
