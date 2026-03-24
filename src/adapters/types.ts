/**
 * Adapter layer type definitions.
 *
 * These interfaces were originally defined as placeholders in
 * `src/core/orchestrator.ts` (Phase 1). Phase 2 moves them here as the
 * canonical location and adds adapter-specific configuration types.
 */

import type { TaskPayload, TaskResult, AgentStatus } from '../core/types.js';

// ─── Core Adapter Interfaces ───

/**
 * Unified interface for all agent adapters.
 *
 * Every adapter must implement `dispatchTask`, `checkStatus`, and `terminate`.
 * `pushMessage` is optional — only agents that support mid-session message
 * injection (currently only OpenClaw) implement it.
 */
export interface AgentAdapter {
    /** Dispatch a task to the agent and wait for completion. */
    dispatchTask(payload: TaskPayload): Promise<TaskResult>;
    /** Push a message to the agent (optional — only some agents support this). */
    pushMessage?(message: string): Promise<void>;
    /** Check current agent status. */
    checkStatus(): Promise<AgentStatus>;
    /** Terminate the agent. */
    terminate(): Promise<void>;
}

/** Configuration passed to adapter factory when creating an instance. */
export interface AdapterConfig {
    /** Working directory for the agent process. */
    cwd?: string;
    /** Environment variables to pass to the agent process. */
    env?: Record<string, string>;
    /** Agent-specific options (model, timeout, sandbox mode, etc.). */
    [key: string]: unknown;
}

/** Factory for creating agent adapter instances. */
export interface AgentAdapterFactory {
    /** Create a new adapter instance with the given configuration. */
    create(config: AdapterConfig): AgentAdapter;
}

/**
 * Registry of available agent adapter factories.
 * Adapters are registered by agent type string key (e.g. 'opencode', 'openclaw').
 */
export interface AdapterRegistry {
    register(agentType: string, factory: AgentAdapterFactory): void;
    getFactory(agentType: string): AgentAdapterFactory | undefined;
    listTypes(): string[];
}

// ─── CLI Adapter Shared Types ───

/** Supported agent type identifiers. */
export type AgentType = 'opencode' | 'openclaw' | 'claude-code' | 'codex';

/** Common configuration for CLI-based adapters (spawn a child process). */
export interface CliAdapterConfig extends AdapterConfig {
    /** Override the CLI command name (defaults to the agent's standard binary). */
    command?: string;
    /** Additional CLI arguments to prepend. */
    extraArgs?: string[];
    /** Timeout in seconds for the spawned process (overrides TaskPayload.timeout). */
    timeout?: number;
}

/**
 * Result of a spawned CLI process.
 * Adapters parse this into a TaskResult.
 */
export interface CliProcessResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

/**
 * Handle to a running CLI process.
 * Exposes the ChildProcess for status checks and termination,
 * plus a promise that resolves when the process exits.
 */
export interface CliProcessHandle {
    /** The underlying child process — use for checkStatus/terminate. */
    pid: number | undefined;
    /** Whether the process is still running. */
    isRunning(): boolean;
    /** Kill the process (SIGTERM, then SIGKILL after grace period). */
    kill(): void;
    /** Promise that resolves when the process exits or times out. */
    result: Promise<CliProcessResult>;
}

// Re-export core types for convenience
export type { TaskPayload, TaskResult, AgentStatus };
