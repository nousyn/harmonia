/**
 * Dev workflow plugin — hook creator.
 *
 * Self-contained entry point for hook creation. All hook generation logic
 * lives in sibling files within this directory — no cross-directory imports.
 *
 * This file is intentionally .js (not .ts) because it lives outside
 * the src/ directory and is loaded via dynamic import() by the plugin
 * system at runtime.
 *
 * The defineHooks function is received from Core via context — this module
 * does NOT directly depend on @s_s/agent-kit.
 */

import { createClaudeCodeHooks } from './hooks-claude.js';
import { createOpenCodeHooks } from './hooks-opencode.js';
import { createOpenClawHooks } from './hooks-openclaw.js';

/**
 * Create hook definitions for a specific agent type.
 *
 * Routes to the appropriate agent-specific hook generator,
 * passing through the defineHooks function from context.
 *
 * @param {Function} defineHooks - defineHooks function from agent-kit (passed via context)
 * @param {string} agentType - Agent type (opencode, claude-code, openclaw, codex)
 * @param {{ dataDir: string }} params - Parameters to bake into hook content
 * @returns {import('@s_s/agent-kit').HookSet} Hook set for the agent
 */
function createHooksForAgent(defineHooks, agentType, params) {
    switch (agentType) {
        case 'claude-code':
        case 'codex':
            return createClaudeCodeHooks(defineHooks, params);
        case 'opencode':
            return createOpenCodeHooks(defineHooks, params);
        case 'openclaw':
            return createOpenClawHooks(defineHooks, params);
        default:
            throw new Error(`Unsupported agent type: ${agentType}`);
    }
}

/**
 * Create hooks for the dev workflow.
 *
 * Matches the HookCreator signature: (agentType, context) => HookSet.
 * Called by the plugin system during project_init.
 *
 * @param {string} agentType - Agent type (opencode, claude-code, openclaw, codex)
 * @param {{ defineHooks: Function, dataDir: string, projectName: string }} context
 * @returns {import('@s_s/agent-kit').HookSet} Hook set for the agent
 */
export function createHooks(agentType, context) {
    return createHooksForAgent(context.defineHooks, agentType, { dataDir: context.dataDir });
}
