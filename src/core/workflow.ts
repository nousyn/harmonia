/**
 * Workflow loader — reads workflow definitions and role prompts from the
 * workflows/ directory bundled with Harmonia.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, parse } from 'node:path';
import YAML from 'yaml';
import type { LoadedWorkflow, RoleCapability, RoleDefinition, RoleFrontmatter, WorkflowDefinition } from './types.js';

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
