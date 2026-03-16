/**
 * Hook installation — entry point for installing/uninstalling agent hooks.
 *
 * Detects the host agent type and installs the appropriate hook definitions
 * using agent-kit's installHooks API. Hook content is generated with baked-in
 * project parameters (data dir, project name, project dir).
 */

import { createKit, type AgentType, type HookInstallResult } from '@s_s/agent-kit';
import type { HookParams } from './content.js';
import { createClaudeCodeHooks } from './claude-code.js';
import { createOpenCodeHooks } from './opencode.js';
import { createOpenClawHooks } from './openclaw.js';

/** Shared kit instance for hook management */
const kit = createKit('harmonia');

/**
 * Install Harmonia hooks for the detected agent.
 *
 * Generates agent-specific hook content with baked-in project parameters,
 * then delegates to agent-kit for file writing and config merging.
 *
 * @param agentType - The host agent type (detected or user-specified)
 * @param params - Project-specific parameters to bake into hook content
 * @returns Installation result from agent-kit
 */
export async function installHooks(agentType: AgentType, params: HookParams): Promise<HookInstallResult> {
    const hooks = createHooksForAgent(agentType, params);
    return kit.installHooks(agentType, hooks);
}

/**
 * Uninstall Harmonia hooks for the given agent.
 *
 * Removes hook files and config entries installed by Harmonia.
 */
export async function uninstallHooks(
    agentType: AgentType,
): Promise<{ success: boolean; removed: string[]; error?: string }> {
    return kit.uninstallHooks(agentType);
}

/**
 * Check if Harmonia hooks are installed for the given agent.
 */
export async function hasHooksInstalled(agentType: AgentType): Promise<boolean> {
    return kit.hasHooksInstalled(agentType);
}

/**
 * Create hook definitions for a specific agent type.
 *
 * @internal — exposed for testing
 */
export function createHooksForAgent(agentType: AgentType, params: HookParams) {
    switch (agentType) {
        case 'claude-code':
        case 'codex':
            return createClaudeCodeHooks(params);
        case 'opencode':
            return createOpenCodeHooks(params);
        case 'openclaw':
            return createOpenClawHooks(params);
        default: {
            // Exhaustive check — should never reach here
            const _exhaustive: never = agentType;
            throw new Error(`Unsupported agent type: ${_exhaustive}`);
        }
    }
}
