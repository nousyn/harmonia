/**
 * Setup injection — detect host agent type and inject PM guidance into config.
 *
 * V1 supports only OpenCode (AGENTS.md injection).
 * The injection is idempotent — re-running replaces existing harmonia block.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import {
    generateOpenCodePrompt,
    HARMONIA_MARKER_START,
    HARMONIA_MARKER_END,
    type PromptTemplateParams,
} from './templates.js';

/** Supported host agent types */
export type HostAgentType = 'opencode' | 'claude-code' | 'codex';

/**
 * Detect the host agent type for a given project directory.
 *
 * V1 heuristic:
 * - Check for AGENTS.md → opencode
 * - Check for .claude/ dir → claude-code
 * - Default to opencode (most common)
 *
 * Future: accept explicit override via parameter.
 */
export async function detectHostAgent(projectDir: string): Promise<HostAgentType> {
    // Check for .claude directory (Claude Code)
    try {
        await readFile(join(projectDir, '.claude', 'settings.json'), 'utf-8');
        return 'claude-code';
    } catch {
        // not claude-code
    }

    // Default to opencode
    return 'opencode';
}

/**
 * Get the config file path for a host agent type.
 */
function getConfigPath(projectDir: string, agentType: HostAgentType): string {
    switch (agentType) {
        case 'opencode':
            return join(projectDir, 'AGENTS.md');
        case 'claude-code':
            return join(projectDir, 'CLAUDE.md');
        case 'codex':
            return join(projectDir, 'AGENTS.md');
    }
}

/**
 * Inject the Harmonia PM guidance block into a config file.
 * If a harmonia block already exists, it is replaced (idempotent).
 * If the file doesn't exist, it is created.
 */
export async function injectPrompt(
    projectDir: string,
    agentType: HostAgentType,
    params: PromptTemplateParams,
): Promise<{ filePath: string; created: boolean; replaced: boolean }> {
    const filePath = getConfigPath(projectDir, agentType);
    const prompt = generateOpenCodePrompt(params);

    let existingContent = '';
    let fileExists = true;

    try {
        existingContent = await readFile(filePath, 'utf-8');
    } catch {
        fileExists = false;
    }

    let replaced = false;
    let newContent: string;

    if (fileExists && existingContent.includes(HARMONIA_MARKER_START)) {
        // Replace existing harmonia block
        const startIdx = existingContent.indexOf(HARMONIA_MARKER_START);
        const endIdx = existingContent.indexOf(HARMONIA_MARKER_END) + HARMONIA_MARKER_END.length;

        if (endIdx > startIdx) {
            newContent = existingContent.substring(0, startIdx) + prompt + existingContent.substring(endIdx);
            replaced = true;
        } else {
            // Malformed markers — append
            newContent = existingContent + '\n\n' + prompt + '\n';
        }
    } else if (fileExists) {
        // Append to existing file
        newContent = existingContent + '\n\n' + prompt + '\n';
    } else {
        // Create new file
        newContent = prompt + '\n';
    }

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, newContent, 'utf-8');

    return { filePath, created: !fileExists, replaced };
}

/**
 * Remove the Harmonia block from a config file.
 */
export async function removePrompt(projectDir: string, agentType: HostAgentType): Promise<boolean> {
    const filePath = getConfigPath(projectDir, agentType);

    try {
        const content = await readFile(filePath, 'utf-8');
        if (!content.includes(HARMONIA_MARKER_START)) return false;

        const startIdx = content.indexOf(HARMONIA_MARKER_START);
        const endIdx = content.indexOf(HARMONIA_MARKER_END) + HARMONIA_MARKER_END.length;

        if (endIdx <= startIdx) return false;

        // Remove the block and any surrounding blank lines
        let newContent = content.substring(0, startIdx) + content.substring(endIdx);
        newContent = newContent.replace(/\n{3,}/g, '\n\n').trim();

        if (newContent.length === 0) {
            // File would be empty — could delete it, but safer to leave empty
            newContent = '';
        }

        await writeFile(filePath, newContent + '\n', 'utf-8');
        return true;
    } catch {
        return false;
    }
}
