/**
 * Workflow loader — reads workflow definitions and role prompts from the
 * workflows/ directory bundled with Harmonia.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, parse } from 'node:path';
import type { LoadedWorkflow, RoleDefinition, RoleFrontmatter, WorkflowDefinition } from './types.js';

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

    // Simple YAML key: value parser (no nested objects needed)
    const frontmatter: Record<string, string | boolean> = {};
    for (const line of yamlBlock.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        const rawVal = line.slice(colonIdx + 1).trim();
        if (rawVal === 'true') frontmatter[key] = true;
        else if (rawVal === 'false') frontmatter[key] = false;
        else frontmatter[key] = rawVal;
    }

    return {
        id,
        frontmatter: {
            model: (frontmatter.model as string) ?? 'medium',
            session: (frontmatter.session as RoleFrontmatter['session']) ?? 'none',
            parallel: (frontmatter.parallel as boolean) ?? false,
        },
        prompt,
    };
}

/**
 * Load a single workflow by name from the given workflows root directory.
 */
export async function loadWorkflow(workflowsDir: string, name: string): Promise<LoadedWorkflow> {
    const workflowDir = join(workflowsDir, name);

    // Load workflow.json
    const workflowJson = await readFile(join(workflowDir, 'workflow.json'), 'utf-8');
    const definition: WorkflowDefinition = JSON.parse(workflowJson);

    // Load roles
    const rolesDir = join(workflowDir, 'roles');
    const roleFiles = await readdir(rolesDir);
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
 * List all available workflow names.
 */
export async function listWorkflows(workflowsDir: string): Promise<string[]> {
    const entries = await readdir(workflowsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}
