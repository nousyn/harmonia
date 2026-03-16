/**
 * Workflow loader — two-layer resolution for workflow definitions.
 *
 * Lookup priority:
 *   1. <data_dir>/.workflows/<name>/   (user custom — can override built-in)
 *   2. <package>/workflows/<name>/      (built-in fallback)
 */

import { readFile, readdir, access } from 'node:fs/promises';
import { join, parse } from 'node:path';
import YAML from 'yaml';
import type { LoadedWorkflow, RoleCapability, RoleDefinition, RoleFrontmatter, WorkflowDefinition } from './types.js';

// ─── Errors ───

export class WorkflowNotFoundError extends Error {
    constructor(name: string, searched: string[]) {
        const dirs = searched.map((d) => `  - ${d}`).join('\n');
        super(`工作流 "${name}" 不存在。已搜索:\n${dirs}`);
        this.name = 'WorkflowNotFoundError';
    }
}

// ─── Internal helpers ───

/**
 * Check if a file exists (async, no throw).
 */
async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Resolve the actual directory for a workflow name.
 * Custom dir takes priority over built-in dir.
 * Returns the resolved directory path.
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
 * Parse a role markdown file.
 * Format: YAML frontmatter (---\n...\n---) followed by markdown prompt.
 */
function parseRoleFile(id: string, content: string): RoleDefinition {
    const fmRegex = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
    const match = content.match(fmRegex);

    if (!match) {
        return {
            id,
            frontmatter: { model: 'medium', session: 'none', parallel: false },
            prompt: content.trim(),
        };
    }

    const yamlBlock = match[1];
    const prompt = match[2].trim();

    const parsed = YAML.parse(yamlBlock) as Record<string, unknown> | null;
    const fm = parsed ?? {};

    const capabilities = Array.isArray(fm.capabilities) ? (fm.capabilities as RoleCapability[]) : undefined;

    const frontmatter: RoleFrontmatter = {
        model: (fm.model as string) ?? 'medium',
        session: (fm.session as RoleFrontmatter['session']) ?? 'none',
        parallel: (fm.parallel as boolean) ?? false,
        ...(capabilities ? { capabilities } : {}),
    };

    return { id, frontmatter, prompt };
}

// ─── Public API ───

/**
 * Load a single workflow by name using two-layer resolution.
 *
 * @param builtinDir - Package built-in workflows directory
 * @param customDir  - User custom workflows directory (<data_dir>/.workflows)
 * @param name       - Workflow name (directory name)
 */
export async function loadWorkflow(builtinDir: string, customDir: string, name: string): Promise<LoadedWorkflow> {
    const workflowDir = await resolveWorkflowDir(builtinDir, customDir, name);

    // Load workflow.json
    const workflowJson = await readFile(join(workflowDir, 'workflow.json'), 'utf-8');
    const definition: WorkflowDefinition = JSON.parse(workflowJson);

    // Load roles
    const rolesDir = join(workflowDir, 'roles');
    let roleFiles: string[] = [];
    try {
        roleFiles = await readdir(rolesDir);
    } catch {
        // roles/ directory is optional for custom workflows
    }
    const roles: Record<string, RoleDefinition> = {};

    for (const file of roleFiles) {
        if (!file.endsWith('.md')) continue;
        const roleId = parse(file).name;
        const content = await readFile(join(rolesDir, file), 'utf-8');
        roles[roleId] = parseRoleFile(roleId, content);
    }

    return { definition, roles };
}

/**
 * List all available workflow names, merging custom and built-in.
 * Custom workflows override built-in ones with the same name.
 *
 * @param builtinDir - Package built-in workflows directory
 * @param customDir  - User custom workflows directory (<data_dir>/.workflows)
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
