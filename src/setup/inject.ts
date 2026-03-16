/**
 * Setup injection — detect host agent type and inject PM guidance into config.
 *
 * Delegates to @s_s/agent-kit for agent detection, prompt injection, and
 * marker management. Harmonia provides the prompt content via templates.ts.
 */

import { readFile } from 'node:fs/promises';
import { createKit, detectAgent, type AgentType } from '@s_s/agent-kit';
import { generatePmPrompt, type PromptTemplateParams } from './templates.js';

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
 * Inject the Harmonia PM guidance block into a config file.
 * If a harmonia block already exists, it is replaced (idempotent).
 * If the file doesn't exist, it is created.
 *
 * Uses agent-kit's injectPrompt which manages <!-- harmonia:start/end --> markers.
 */
export async function injectPrompt(
    projectDir: string,
    agentType: AgentType,
    params: PromptTemplateParams,
): Promise<{ filePath: string; created: boolean; replaced: boolean }> {
    const prompt = generatePmPrompt(params);

    // Check pre-existing state for return value
    const hasExisting = await kit.hasPromptInjected(agentType, { scope: 'project', projectRoot: projectDir });

    // Determine if the config file exists (for created flag)
    let fileExists = true;
    try {
        // agent-kit resolves the config path internally; we replicate the check
        // by looking for an existing injection or reading the resolved file
        const configFileName = agentType === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md';
        await readFile(`${projectDir}/${configFileName}`, 'utf-8');
    } catch {
        fileExists = false;
    }

    // Inject via agent-kit (handles create, append, and idempotent replace)
    await kit.injectPrompt(agentType, prompt, { scope: 'project', projectRoot: projectDir });

    const configFileName = agentType === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md';

    return {
        filePath: `${projectDir}/${configFileName}`,
        created: !fileExists,
        replaced: hasExisting,
    };
}
