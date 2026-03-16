/**
 * Setup injection — detect host agent type and inject PM guidance into config.
 *
 * Delegates to @s_s/agent-kit for agent detection, prompt injection, and
 * marker management. Harmonia provides the prompt content via templates.ts.
 *
 * Always uses global scope — PM prompt is project-agnostic and should be
 * written to the agent's global config directory (e.g. ~/.openclaw/workspace/AGENTS.md).
 */

import { createKit, detectAgent, type AgentType } from '@s_s/agent-kit';
import { readFile } from 'node:fs/promises';
import { generatePmPrompt } from './templates.js';

/** Shared kit instance — binds all marker tags to "harmonia" */
const kit = createKit('harmonia');

/** Marker constants for external use (tests, etc.) */
export const HARMONIA_MARKER_START = '<!-- harmonia:start -->';
export const HARMONIA_MARKER_END = '<!-- harmonia:end -->';

/**
 * Detect the host agent type for a given project directory.
 *
 * Delegates to agent-kit's detectAgent() which checks file-system
 * characteristics in order: opencode → claude-code → openclaw → codex.
 * Falls back to 'opencode' if no agent is detected.
 */
export async function detectHostAgent(projectDir: string): Promise<AgentType> {
    const detected = await detectAgent(projectDir);
    return detected ?? 'opencode';
}

/**
 * Inject the Harmonia PM guidance block into the agent's **global** config file.
 * If a harmonia block already exists, it is replaced (idempotent).
 * If the file doesn't exist, it is created.
 *
 * Uses global scope because PM prompt is project-agnostic.
 * This writes to the agent's global config directory:
 *   - opencode:    ~/.config/opencode/AGENTS.md
 *   - claude-code: ~/.claude/CLAUDE.md
 *   - openclaw:    ~/.openclaw/workspace/AGENTS.md
 *   - codex:       ~/.codex/AGENTS.md
 */
export async function injectPrompt(
    agentType: AgentType,
): Promise<{ filePath: string; created: boolean; replaced: boolean }> {
    const prompt = generatePmPrompt();
    const globalScope = { scope: 'global' as const };

    // Check pre-existing state for return value
    const hasExisting = await kit.hasPromptInjected(agentType, globalScope);

    // Resolve the actual file path for reporting
    const { configFile: filePath } = kit.resolvePaths(agentType, globalScope);

    // Determine if the config file exists (for created flag)
    let fileExists = true;
    try {
        await readFile(filePath, 'utf-8');
    } catch {
        fileExists = false;
    }

    // Inject via agent-kit (handles create, append, and idempotent replace)
    await kit.injectPrompt(agentType, prompt, globalScope);

    return {
        filePath,
        created: !fileExists,
        replaced: hasExisting,
    };
}
