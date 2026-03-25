/**
 * Event system for Harmonia orchestrator.
 *
 * Typed EventEmitter that carries all business events.
 * Replaces the old "coordinator pushes events" model:
 * events are now produced and consumed internally by the orchestrator.
 *
 * Existing `WorkflowEvent` (types.ts) is the data definition for engine
 * state transitions. `BusEvent` here is the runtime event envelope that
 * the EventBus transports — the two are complementary, not competing.
 */

import { EventEmitter } from 'node:events';

// ─── Event payload types ───

/** Node activated — ready for dispatch */
export interface NodeActivatedEvent {
    nodeId: string;
    role: string;
    /** Timestamp (epoch ms) */
    ts: number;
}

/** Node completed successfully */
export interface NodeCompletedEvent {
    nodeId: string;
    role: string;
    result?: unknown;
    ts: number;
}

/** Node failed */
export interface NodeFailedEvent {
    nodeId: string;
    role: string;
    error: string;
    ts: number;
}

/** Artifact written and collected from agent output */
export interface ArtifactWrittenEvent {
    artifactId: string;
    nodeId: string;
    path: string;
    ts: number;
}

/** Artifact approved via review */
export interface ArtifactApprovedEvent {
    artifactId: string;
    approvedBy: string;
    ts: number;
}

/** Gate condition evaluated */
export interface GateEvaluatedEvent {
    nodeId: string;
    passed: boolean;
    ts: number;
}

// ─── Phase 2+ event payloads (type-only, handlers deferred) ───

/** Task dispatched to an agent */
export interface TaskDispatchedEvent {
    nodeId: string;
    role: string;
    dispatchId: string;
    agentType: string;
    ts: number;
}

/** Task timed out (timer fired) */
export interface TaskTimeoutEvent {
    nodeId: string;
    dispatchId: string;
    elapsed: number;
    ts: number;
}

/** Agent alive but no progress detected */
export interface TaskStalledEvent {
    nodeId: string;
    dispatchId: string;
    ts: number;
}

/** Agent unreachable (process exited / connection lost) */
export interface AgentUnreachableEvent {
    agentType: string;
    agentId: string;
    reason: string;
    ts: number;
}

// ─── Event map ───

/** Complete map of event name → payload. */
export interface BusEventMap {
    // Phase 1 — implemented with producers and consumers
    'node.activated': NodeActivatedEvent;
    'node.completed': NodeCompletedEvent;
    'node.failed': NodeFailedEvent;
    'artifact.written': ArtifactWrittenEvent;
    'artifact.approved': ArtifactApprovedEvent;
    'gate.evaluated': GateEvaluatedEvent;

    // Phase 2+ — types defined, handlers deferred
    'task.dispatched': TaskDispatchedEvent;
    'task.timeout': TaskTimeoutEvent;
    'task.stalled': TaskStalledEvent;
    'agent.unreachable': AgentUnreachableEvent;
}

/** Union of all event names */
export type BusEventName = keyof BusEventMap;

// ─── Typed EventBus ───

/**
 * Strongly-typed event bus built on Node.js EventEmitter.
 *
 * Usage:
 * ```ts
 * const bus = new EventBus();
 * bus.on('node.completed', (e) => { console.log(e.nodeId); });
 * bus.emit('node.completed', { nodeId: 'n1', role: 'dev', ts: Date.now() });
 * ```
 */
export class EventBus {
    private readonly emitter = new EventEmitter();

    constructor() {
        // Suppress Node's default "no listener" warning for error-like events.
        // We handle errors through the normal event flow, not through 'error'.
        this.emitter.setMaxListeners(50);
    }

    /** Register an event listener. */
    on<K extends BusEventName>(event: K, listener: (payload: BusEventMap[K]) => void): this {
        this.emitter.on(event, listener as (...args: unknown[]) => void);
        return this;
    }

    /** Register a one-time event listener. */
    once<K extends BusEventName>(event: K, listener: (payload: BusEventMap[K]) => void): this {
        this.emitter.once(event, listener as (...args: unknown[]) => void);
        return this;
    }

    /** Remove a previously registered listener. */
    off<K extends BusEventName>(event: K, listener: (payload: BusEventMap[K]) => void): this {
        this.emitter.off(event, listener as (...args: unknown[]) => void);
        return this;
    }

    /** Emit an event. Returns true if there were listeners. */
    emit<K extends BusEventName>(event: K, payload: BusEventMap[K]): boolean {
        return this.emitter.emit(event, payload);
    }

    /** Return the number of listeners for a given event. */
    listenerCount<K extends BusEventName>(event: K): number {
        return this.emitter.listenerCount(event);
    }

    /** Remove all listeners, optionally for a specific event. */
    removeAllListeners(event?: BusEventName): this {
        if (event !== undefined) {
            this.emitter.removeAllListeners(event);
        } else {
            this.emitter.removeAllListeners();
        }
        return this;
    }
}
