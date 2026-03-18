/**
 * Workflow loader — compatibility wrapper around plugin.ts.
 *
 * Preserves the old two-layer resolution API (builtinDir + customDir)
 * while delegating to the new plugin system internally.
 *
 * This module will be removed once all callers migrate to plugin.ts directly (Phase 3+).
 *
 * @deprecated Use plugin.ts (loadPlugin / loadPluginByName) directly.
 */

import { readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPlugin } from './plugin.js';
import type { WorkflowPlugin } from './types.js';

// ─── Errors ───

export class WorkflowNotFoundError extends Error {
    constructor(name: string, searched: string[]) {
        const dirs = searched.map((d) => `  - ${d}`).join('\n');
        super(`工作流 "${name}" 不存在。已搜索:\n${dirs}`);
        this.name = 'WorkflowNotFoundError';
    }
}

// ─── Internal helpers ───

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

// ─── Public API ───

/**
 * Resolve the actual directory for a workflow name.
 * Custom dir takes priority over built-in dir.
 *
 * @deprecated Will be removed when callers migrate to plugin.ts
 */
export async function resolveWorkflowDir(builtinDir: string, customDir: string, name: string): Promise<string> {
    const customPath = join(customDir, name, 'workflow.json');
    if (await fileExists(customPath)) {
        return join(customDir, name);
    }

    const builtinPath = join(builtinDir, name, 'workflow.json');
    if (await fileExists(builtinPath)) {
        return join(builtinDir, name);
    }

    throw new WorkflowNotFoundError(name, [join(customDir, name), join(builtinDir, name)]);
}

/**
 * Load a single workflow by name using two-layer resolution.
 * Delegates to plugin.ts loadPlugin() internally.
 *
 * Note: skipValidation is always true because the dev workflow
 * hasn't been fully migrated yet (Phase 4). Once migrated,
 * validation will be enabled by default.
 *
 * @param builtinDir - Package built-in workflows directory
 * @param customDir  - User custom workflows directory (<data_dir>/.workflows)
 * @param name       - Workflow name (directory name)
 *
 * @deprecated Use loadPlugin() or loadPluginByName() from plugin.ts
 */
export async function loadWorkflow(builtinDir: string, customDir: string, name: string): Promise<WorkflowPlugin> {
    const workflowDir = await resolveWorkflowDir(builtinDir, customDir, name);
    // skipValidation=true: dev workflow not fully migrated yet (roles/coordinator.md missing)
    return loadPlugin(workflowDir, undefined, true);
}

/**
 * List all available workflow names, merging custom and built-in.
 * Custom workflows override built-in ones with the same name.
 *
 * @param builtinDir - Package built-in workflows directory
 * @param customDir  - User custom workflows directory (<data_dir>/.workflows)
 *
 * @deprecated Will be replaced by discoverPlugins() from plugin.ts
 */
export async function listWorkflows(builtinDir: string, customDir: string): Promise<string[]> {
    const names = new Set<string>();

    // Built-in workflows
    try {
        const entries = await readdir(builtinDir, { withFileTypes: true });
        for (const e of entries) {
            if (e.isDirectory()) names.add(e.name);
        }
    } catch {
        // built-in dir missing is unexpected but not fatal
    }

    // Custom workflows (can add new or override built-in)
    try {
        const entries = await readdir(customDir, { withFileTypes: true });
        for (const e of entries) {
            if (e.isDirectory()) names.add(e.name);
        }
    } catch {
        // custom dir doesn't exist yet — that's fine
    }

    return [...names].sort();
}
