/**
 * Dispatch & Session tracking — manages:
 *   <context_dir>/sessions.json
 *   <context_dir>/dispatches.json
 *
 * context_dir is typically iter-<n>/ or patch-<n>/ under the project data dir.
 *
 * Sessions represent agent instances (can be reused across dispatches).
 * Dispatches represent individual task assignments to a role.
 * Relationship: Session 1:N Dispatch (a persistent session can receive multiple dispatches).
 *
 * The pure CRUD functions below are the stateless core (preserved for backward
 * compatibility and direct testing). `DispatchManager` wraps them with EventBus
 * integration and timeout management for the orchestrator architecture.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { AgentType, SessionRecord, SessionStatus, DispatchRecord, DispatchStatus } from './types.js';

const SESSIONS_FILE = 'sessions.json';
const DISPATCHES_FILE = 'dispatches.json';

function sessionsPath(projectName: string, iteration: number, contextDir?: string): string {
    return join(contextDir!, SESSIONS_FILE);
}

function dispatchesPath(projectName: string, iteration: number, contextDir?: string): string {
    return join(contextDir!, DISPATCHES_FILE);
}

// ─── Session CRUD ───

export async function readSessions(
    projectName: string,
    iteration: number,
    contextDir?: string,
): Promise<SessionRecord[]> {
    try {
        const content = await readFile(sessionsPath(projectName, iteration, contextDir), 'utf-8');
        return JSON.parse(content) as SessionRecord[];
    } catch {
        return [];
    }
}

async function writeSessions(
    projectName: string,
    iteration: number,
    sessions: SessionRecord[],
    contextDir?: string,
): Promise<void> {
    const filePath = sessionsPath(projectName, iteration, contextDir);
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
    contextDir?: string,
): Promise<SessionRecord> {
    const sessions = await readSessions(projectName, iteration, contextDir);
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
    await writeSessions(projectName, iteration, sessions, contextDir);
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
    contextDir?: string,
): Promise<SessionRecord> {
    const sessions = await readSessions(projectName, iteration, contextDir);
    const session = sessions.find((s) => s.id === sessionId);

    if (!session) {
        throw new Error(`Session "${sessionId}" not found in project "${projectName}"`);
    }

    if (updates.status !== undefined) session.status = updates.status;
    if (updates.agentSessionId !== undefined) session.agentSessionId = updates.agentSessionId;
    if (updates.agentType !== undefined) session.agentType = updates.agentType;
    if (updates.label !== undefined) session.label = updates.label;
    session.lastActiveAt = new Date().toISOString();

    await writeSessions(projectName, iteration, sessions, contextDir);
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
    contextDir?: string,
): Promise<SessionRecord | null> {
    const sessions = await readSessions(projectName, iteration, contextDir);
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
    contextDir?: string,
): Promise<SessionRecord | null> {
    const sessions = await readSessions(projectName, iteration, contextDir);
    return sessions.find((s) => s.role === role && s.agentSessionId === agentSessionId) ?? null;
}

// ─── Dispatch CRUD ───

export async function readDispatches(
    projectName: string,
    iteration: number,
    contextDir?: string,
): Promise<DispatchRecord[]> {
    try {
        const content = await readFile(dispatchesPath(projectName, iteration, contextDir), 'utf-8');
        return JSON.parse(content) as DispatchRecord[];
    } catch {
        return [];
    }
}

async function writeDispatches(
    projectName: string,
    iteration: number,
    dispatches: DispatchRecord[],
    contextDir?: string,
): Promise<void> {
    const filePath = dispatchesPath(projectName, iteration, contextDir);
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
    contextDir?: string,
    nodeId?: string,
): Promise<DispatchRecord> {
    const dispatches = await readDispatches(projectName, iteration, contextDir);
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
        ...(nodeId ? { nodeId } : {}),
    };

    dispatches.push(dispatch);
    await writeDispatches(projectName, iteration, dispatches, contextDir);
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
    contextDir?: string,
): Promise<DispatchRecord> {
    const dispatches = await readDispatches(projectName, iteration, contextDir);
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

    await writeDispatches(projectName, iteration, dispatches, contextDir);
    return dispatch;
}

/**
 * Get a single dispatch record by ID.
 */
export async function getDispatch(
    projectName: string,
    iteration: number,
    dispatchId: string,
    contextDir?: string,
): Promise<DispatchRecord | null> {
    const dispatches = await readDispatches(projectName, iteration, contextDir);
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

/**
 * Check if a role has any running dispatches (status: 'dispatched' or 'running').
 * Used by parallel dispatch logic to decide whether to force a new session.
 */
export async function hasRunningDispatch(
    projectName: string,
    iteration: number,
    role: string,
    contextDir?: string,
): Promise<boolean> {
    const dispatches = await readDispatches(projectName, iteration, contextDir);
    return dispatches.some((d) => d.role === role && (d.status === 'dispatched' || d.status === 'running'));
}

// ─── DispatchManager (orchestrator integration) ───

import type { EventBus } from './event-bus.js';

/** Options for creating a dispatch through the manager. */
export interface ManagedDispatchOptions {
    projectName: string;
    iteration: number;
    role: string;
    taskBrief: string;
    expectedOutputs: string[];
    nodeId: string;
    agentType: string;
    contextDir: string;
    /** Timeout in seconds. When elapsed, triggers status check flow. */
    timeout?: number;
    sessionId?: string;
}

/** Active timeout tracker. */
interface TimeoutEntry {
    dispatchId: string;
    nodeId: string;
    timer: ReturnType<typeof setTimeout>;
    startedAt: number;
}

/**
 * Wraps pure dispatch CRUD with EventBus integration and timeout management.
 *
 * - Emits `task.dispatched` when a dispatch is created
 * - Emits `node.completed` / `node.failed` on terminal status transitions
 * - Manages per-dispatch timeout timers
 * - Provides `onTimeout` callback for the Orchestrator to handle stall/fail logic
 */
export class DispatchManager {
    private readonly timeouts = new Map<string, TimeoutEntry>();
    private onTimeoutCallback?: (dispatchId: string, nodeId: string, elapsed: number) => void;

    constructor(private readonly eventBus: EventBus) {}

    /** Register a callback invoked when a dispatch timeout fires. */
    onTimeout(cb: (dispatchId: string, nodeId: string, elapsed: number) => void): void {
        this.onTimeoutCallback = cb;
    }

    /**
     * Create a dispatch record and emit `task.dispatched`.
     * Optionally starts a timeout timer.
     */
    async dispatch(opts: ManagedDispatchOptions): Promise<DispatchRecord> {
        const record = await createDispatch(
            opts.projectName,
            opts.iteration,
            opts.role,
            opts.taskBrief,
            opts.expectedOutputs,
            opts.sessionId,
            opts.contextDir,
            opts.nodeId,
        );

        this.eventBus.emit('task.dispatched', {
            nodeId: opts.nodeId,
            role: opts.role,
            dispatchId: record.id,
            agentType: opts.agentType,
            ts: Date.now(),
        });

        // Register timeout timer if configured
        if (opts.timeout && opts.timeout > 0) {
            this.registerTimeout(record.id, opts.nodeId, opts.timeout);
        }

        return record;
    }

    /**
     * Update a dispatch status. Emits events on terminal transitions
     * and clears timeout timers.
     */
    async updateStatus(
        projectName: string,
        iteration: number,
        dispatchId: string,
        status: DispatchStatus,
        contextDir: string,
        note?: string,
    ): Promise<DispatchRecord> {
        const record = await updateDispatch(projectName, iteration, dispatchId, { status, note }, contextDir);

        // Clear timeout on terminal status
        if (isTerminalStatus(status)) {
            this.clearTimeout(dispatchId);
        }

        return record;
    }

    /** Clear all active timeout timers (e.g. on shutdown). */
    clearAllTimeouts(): void {
        for (const entry of this.timeouts.values()) {
            clearTimeout(entry.timer);
        }
        this.timeouts.clear();
    }

    // ─── Private ───

    private registerTimeout(dispatchId: string, nodeId: string, timeoutSeconds: number): void {
        const timer = setTimeout(() => {
            this.timeouts.delete(dispatchId);
            const elapsed = timeoutSeconds;
            this.eventBus.emit('task.timeout', {
                nodeId,
                dispatchId,
                elapsed,
                ts: Date.now(),
            });
            this.onTimeoutCallback?.(dispatchId, nodeId, elapsed);
        }, timeoutSeconds * 1000);

        // Allow Node.js to exit even if timer is pending (unref)
        if (typeof timer === 'object' && 'unref' in timer) {
            timer.unref();
        }

        this.timeouts.set(dispatchId, {
            dispatchId,
            nodeId,
            timer,
            startedAt: Date.now(),
        });
    }

    private clearTimeout(dispatchId: string): void {
        const entry = this.timeouts.get(dispatchId);
        if (entry) {
            clearTimeout(entry.timer);
            this.timeouts.delete(dispatchId);
        }
    }
}
