/**
 * Adapter registry — manages agent adapter factories by type string key.
 *
 * The default registry (`createDefaultRegistry()`) hard-codes four adapters:
 * opencode, openclaw, claude-code, codex. Code structure supports adding
 * more adapters without modifying this file (use `registry.register()`).
 */

import type { AdapterRegistry, AgentAdapterFactory } from './types.js';
import { OpenCodeAdapterFactory } from './opencode.js';
import { OpenClawAdapterFactory } from './openclaw.js';
import { ClaudeCodeAdapterFactory } from './claude-code.js';
import { CodexAdapterFactory } from './codex.js';

// ─── DefaultAdapterRegistry ───

export class DefaultAdapterRegistry implements AdapterRegistry {
    private readonly factories = new Map<string, AgentAdapterFactory>();

    register(agentType: string, factory: AgentAdapterFactory): void {
        this.factories.set(agentType, factory);
    }

    getFactory(agentType: string): AgentAdapterFactory | undefined {
        return this.factories.get(agentType);
    }

    listTypes(): string[] {
        return [...this.factories.keys()];
    }
}

/**
 * Create a registry pre-populated with all built-in adapter factories.
 *
 * Built-in adapters:
 * - `opencode` — OpenCode CLI (`opencode run`)
 * - `openclaw` — OpenClaw CLI (`openclaw agent`) with `pushMessage` support
 * - `claude-code` — Claude Code CLI (`claude -p`)
 * - `codex` — Codex CLI (`codex exec`)
 */
export function createDefaultRegistry(): AdapterRegistry {
    const registry = new DefaultAdapterRegistry();
    registry.register('opencode', new OpenCodeAdapterFactory());
    registry.register('openclaw', new OpenClawAdapterFactory());
    registry.register('claude-code', new ClaudeCodeAdapterFactory());
    registry.register('codex', new CodexAdapterFactory());
    return registry;
}
