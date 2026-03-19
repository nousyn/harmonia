/**
 * Dev workflow plugin — hook creator.
 *
 * Self-contained entry point for hook creation. Contains the agent-type
 * routing logic and imports the compiled hook generators for each agent.
 *
 * This file is intentionally .js (not .ts) because it lives outside
 * the src/ directory and is loaded via dynamic import() by the plugin
 * system at runtime.
 *
 * Hook generators are compiled from src/hooks/ to build/hooks/ by tsc.
 */

import { createClaudeCodeHooks } from '../../build/hooks/claude-code.js';
import { createOpenCodeHooks } from '../../build/hooks/opencode.js';
import { createOpenClawHooks } from '../../build/hooks/openclaw.js';

/**
 * Create hook definitions for a specific agent type.
 *
 * Routes to the appropriate agent-specific hook generator.
 * This is the agent routing logic that was previously in src/hooks/install.ts.
 *
 * @param {string} agentType - Agent type (opencode, claude-code, openclaw, codex)
 * @param {{ dataDir: string }} params - Parameters to bake into hook content
 * @returns {import('@s_s/agent-kit').HookSet} Hook set for the agent
 */
function createHooksForAgent(agentType, params) {
    switch (agentType) {
        case 'claude-code':
        case 'codex':
            return createClaudeCodeHooks(params);
        case 'opencode':
            return createOpenCodeHooks(params);
        case 'openclaw':
            return createOpenClawHooks(params);
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
    return createHooksForAgent(agentType, { dataDir: context.dataDir });
}

// Also export createHooksForAgent for testing
export { createHooksForAgent };
