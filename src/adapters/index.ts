/**
 * Adapter layer — public API.
 *
 * Re-exports all adapter types, factories, and registry.
 */

// Types
export type {
    AgentAdapter,
    AdapterConfig,
    AgentAdapterFactory,
    AdapterRegistry,
    AgentType,
    CliAdapterConfig,
    CliProcessResult,
    CliProcessHandle,
    TaskPayload,
    TaskResult,
    AgentStatus,
} from './types.js';

// CLI runner
export { spawnCliProcess, runCliProcess, resolveSpawnOptions } from './cli-runner.js';

// Adapters
export { OpenCodeAdapter, OpenCodeAdapterFactory } from './opencode.js';
export { OpenClawAdapter, OpenClawAdapterFactory } from './openclaw.js';
export { ClaudeCodeAdapter, ClaudeCodeAdapterFactory } from './claude-code.js';
export type { ClaudeCodeConfig } from './claude-code.js';
export { CodexAdapter, CodexAdapterFactory } from './codex.js';
export type { CodexConfig } from './codex.js';

// Registry
export { DefaultAdapterRegistry, createDefaultRegistry } from './registry.js';
