/**
 * Dev workflow plugin — hook bridge.
 *
 * This JS module bridges the plugin hook interface to the compiled
 * hook creators in build/hooks/install.js. It adapts the HookCreator
 * signature (agentType, context) to the existing createHooksForAgent
 * function (agentType, params).
 *
 * This file is intentionally .js (not .ts) because it lives outside
 * the src/ directory and is loaded via dynamic import() by the plugin
 * system at runtime.
 */

import { createHooksForAgent } from '../../build/hooks/install.js';

/**
 * Create hooks for the dev workflow.
 *
 * @param {string} agentType - Agent type (opencode, claude-code, openclaw, codex)
 * @param {{ defineHooks: Function, dataDir: string, projectName: string }} context
 * @returns {import('@s_s/agent-kit').HookSet} Hook set for the agent
 */
export function createHooks(agentType, context) {
    return createHooksForAgent(agentType, { dataDir: context.dataDir });
}
