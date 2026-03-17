/**
 * Dispatch & Session tracking — manages:
 *   <data_dir>/<project_name>/iter-<n>/sessions.json
 *   <data_dir>/<project_name>/iter-<n>/dispatches.json
 *
 * Sessions represent agent instances (can be reused across dispatches).
 * Dispatches represent individual task assignments to a role.
 * Relationship: Session 1:N Dispatch (a persistent session can receive multiple dispatches).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getIterationDir } from './registry.js';
import type { AgentType, SessionRecord, SessionStatus, DispatchRecord, DispatchStatus } from './types.js';

const SESSIONS_FILE = 'sessions.json';
const DISPATCHES_FILE = 'dispatches.json';

function sessionsPath(projectName: string, iteration: number): string {
    return join(getIterationDir(projectName, iteration), SESSIONS_FILE);
}

function dispatchesPath(projectName: string, iteration: number): string {
    return join(getIterationDir(projectName, iteration), DISPATCHES_FILE);
}

// ─── Session CRUD ───

export async function readSessions(projectName: string, iteration: number): Promise<SessionRecord[]> {
    try {
        const content = await readFile(sessionsPath(projectName, iteration), 'utf-8');
        return JSON.parse(content) as SessionRecord[];
    } catch {
        return [];
    }
}

async function writeSessions(projectName: string, iteration: number, sessions: SessionRecord[]): Promise<void> {
    const filePath = sessionsPath(projectName, iteration);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(sessions, null, 2) + '\n', 'utf-8');
}

function nextSessionId(sessions: SessionRecord[]): string {
    const num = sessions.length + 1;
    return `ses-${String(num).padStart(3, '0')}`;
}

export async function createSession(
    projectName: string,
    iteration: number,
    role: string,
    agentType?: AgentType,
    label?: string,
): Promise<SessionRecord> {
    const sessions = await readSessions(projectName, iteration);
    const now = new Date().toISOString();

    const session: SessionRecord = {
        id: nextSessionId(sessions),
        role,
        agentType,
        status: 'active',
        label,
        createdAt: now,
        lastActiveAt: now,
    };

    sessions.push(session);
    await writeSessions(projectName, iteration, sessions);
    return session;
}

export async function updateSession(
    projectName: string,
    iteration: number,
    sessionId: string,
    updates: {
        status?: SessionStatus;
        agentSessionId?: string;
        agentType?: AgentType;
        label?: string;
    },
): Promise<SessionRecord> {
    const sessions = await readSessions(projectName, iteration);
    const session = sessions.find((s) => s.id === sessionId);

    if (!session) {
        throw new Error(`Session "${sessionId}" not found in project "${projectName}"`);
    }

    if (updates.status !== undefined) session.status = updates.status;
    if (updates.agentSessionId !== undefined) session.agentSessionId = updates.agentSessionId;
    if (updates.agentType !== undefined) session.agentType = updates.agentType;
    if (updates.label !== undefined) session.label = updates.label;
    session.lastActiveAt = new Date().toISOString();

    await writeSessions(projectName, iteration, sessions);
    return session;
}

/**
 * Find an idle session for a given role (for session reuse).
 * Returns the most recently active idle session, or null if none found.
 */
export async function findIdleSession(
    projectName: string,
    iteration: number,
    role: string,
): Promise<SessionRecord | null> {
    const sessions = await readSessions(projectName, iteration);
    const idle = sessions
        .filter((s) => s.role === role && s.status === 'idle')
        .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
    return idle[0] ?? null;
}

/**
 * Find a session by its agent session ID (for correlating external sessions).
 */
export async function findSessionByAgentId(
    projectName: string,
    iteration: number,
    role: string,
    agentSessionId: string,
): Promise<SessionRecord | null> {
    const sessions = await readSessions(projectName, iteration);
    return sessions.find((s) => s.role === role && s.agentSessionId === agentSessionId) ?? null;
}

// ─── Dispatch CRUD ───

export async function readDispatches(projectName: string, iteration: number): Promise<DispatchRecord[]> {
    try {
        const content = await readFile(dispatchesPath(projectName, iteration), 'utf-8');
        return JSON.parse(content) as DispatchRecord[];
    } catch {
        return [];
    }
}

async function writeDispatches(projectName: string, iteration: number, dispatches: DispatchRecord[]): Promise<void> {
    const filePath = dispatchesPath(projectName, iteration);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(dispatches, null, 2) + '\n', 'utf-8');
}

function nextDispatchId(dispatches: DispatchRecord[]): string {
    const num = dispatches.length + 1;
    return `dispatch-${String(num).padStart(3, '0')}`;
}

export async function createDispatch(
    projectName: string,
    iteration: number,
    role: string,
    taskBrief: string,
    expectedOutputs: string[],
    sessionId?: string,
): Promise<DispatchRecord> {
    const dispatches = await readDispatches(projectName, iteration);
    const now = new Date().toISOString();

    const dispatch: DispatchRecord = {
        id: nextDispatchId(dispatches),
        role,
        taskBrief,
        status: 'dispatched',
        expectedOutputs,
        createdAt: now,
        updatedAt: now,
        ...(sessionId ? { sessionId } : {}),
    };

    dispatches.push(dispatch);
    await writeDispatches(projectName, iteration, dispatches);
    return dispatch;
}

export async function updateDispatch(
    projectName: string,
    iteration: number,
    dispatchId: string,
    updates: {
        status?: DispatchStatus;
        sessionId?: string;
        note?: string;
    },
): Promise<DispatchRecord> {
    const dispatches = await readDispatches(projectName, iteration);
    const dispatch = dispatches.find((d) => d.id === dispatchId);

    if (!dispatch) {
        throw new Error(`Dispatch "${dispatchId}" not found in project "${projectName}"`);
    }

    const now = new Date().toISOString();

    if (updates.status !== undefined) {
        dispatch.status = updates.status;
        if (updates.status === 'completed' || updates.status === 'failed' || updates.status === 'cancelled') {
            dispatch.completedAt = now;
        }
    }
    if (updates.sessionId !== undefined) dispatch.sessionId = updates.sessionId;
    if (updates.note !== undefined) dispatch.note = updates.note;
    dispatch.updatedAt = now;

    await writeDispatches(projectName, iteration, dispatches);
    return dispatch;
}

/**
 * Get a single dispatch record by ID.
 */
export async function getDispatch(
    projectName: string,
    iteration: number,
    dispatchId: string,
): Promise<DispatchRecord | null> {
    const dispatches = await readDispatches(projectName, iteration);
    return dispatches.find((d) => d.id === dispatchId) ?? null;
}

// ─── Dispatch State Machine ───

/** Valid state transitions for dispatch status. */
export const DISPATCH_TRANSITIONS: Record<DispatchStatus, DispatchStatus[]> = {
    dispatched: ['running', 'cancelled'],
    running: ['completed', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
};

/**
 * Check if a dispatch status transition is valid.
 */
export function isValidTransition(from: DispatchStatus, to: DispatchStatus): boolean {
    return DISPATCH_TRANSITIONS[from].includes(to);
}

/**
 * Check if a dispatch status is terminal (no further transitions allowed).
 */
export function isTerminalStatus(status: DispatchStatus): boolean {
    return DISPATCH_TRANSITIONS[status].length === 0;
}
