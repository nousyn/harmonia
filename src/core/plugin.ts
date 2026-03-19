/**
 * Plugin system — discovery, loading, and registration of workflow plugins.
 *
 * A workflow plugin is a directory containing:
 *   workflow.json  — Node tree definition + artifact definitions
 *   roles/*.md     — Role prompts with YAML frontmatter
 *   schemas/*.json — Artifact schemas for validation
 *   hooks.ts       — Optional, exports createHooks()
 *   tools.ts       — Optional, exports registerActions()
 *
 * Loading flow:
 * 1. Read workflow.json → parse node tree + artifact definitions
 * 2. Validate via workflow-validator
 * 3. Scan roles/ → parse role files
 * 4. Scan schemas/ → load artifact schemas
 * 5. If tools.ts exists → dynamic import, register actions
 * 6. If hooks.ts exists → record hook creator (not executed yet)
 */

import { readFile, readdir, access } from 'node:fs/promises';
import { join, parse } from 'node:path';
import * as YAML from 'yaml';
import { validateWorkflow } from './workflow-validator.js';
import type {
    WorkflowPlugin,
    WorkflowDefinition,
    RoleDefinition,
    RoleFrontmatter,
    RoleCapability,
    ArtifactSchema,
    ArtifactDefinition,
    ActionHandler,
    PluginEntry,
    GlobalConfig,
    HookCreator,
} from './types.js';

// ─── Errors ───

export class PluginLoadError extends Error {
    constructor(pluginPath: string, reason: string) {
        super(`Failed to load plugin from "${pluginPath}": ${reason}`);
        this.name = 'PluginLoadError';
    }
}

export class PluginValidationError extends Error {
    public errors: { type: string; message: string; nodeId?: string }[];

    constructor(pluginPath: string, errors: { type: string; message: string; nodeId?: string }[]) {
        const summary = errors.map((e) => `  - [${e.type}] ${e.message}`).join('\n');
        super(`Workflow validation failed for "${pluginPath}":\n${summary}`);
        this.name = 'PluginValidationError';
        this.errors = errors;
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

// ─── Loading Steps ───

/**
 * Load workflow definition from workflow.json.
 * Also extracts artifact definitions from the 'artifacts' field.
 */
async function loadDefinition(
    pluginPath: string,
): Promise<{ definition: WorkflowDefinition; artifactDefinitions: Record<string, ArtifactDefinition> }> {
    const workflowJsonPath = join(pluginPath, 'workflow.json');

    if (!(await fileExists(workflowJsonPath))) {
        throw new PluginLoadError(pluginPath, 'workflow.json not found');
    }

    const content = await readFile(workflowJsonPath, 'utf-8');
    const raw = JSON.parse(content) as Record<string, unknown>;

    // Extract artifact definitions (not part of WorkflowDefinition type)
    const artifactDefinitions: Record<string, ArtifactDefinition> = {};
    if (raw.artifacts && typeof raw.artifacts === 'object') {
        for (const [id, def] of Object.entries(raw.artifacts as Record<string, unknown>)) {
            artifactDefinitions[id] = def as ArtifactDefinition;
        }
    }

    // Build WorkflowDefinition (without artifacts — that's plugin-level)
    const definition: WorkflowDefinition = {
        name: raw.name as string,
        description: raw.description as string,
        version: raw.version as string | undefined,
        author: raw.author as string | undefined,
        coordinator: raw.coordinator as string,
        root: raw.root as WorkflowDefinition['root'],
        floatingNodes: raw.floatingNodes as WorkflowDefinition['floatingNodes'],
    };

    return { definition, artifactDefinitions };
}

/**
 * Load role definitions from roles/ directory.
 */
async function loadRoles(pluginPath: string): Promise<Record<string, RoleDefinition>> {
    const rolesDir = join(pluginPath, 'roles');
    const roles: Record<string, RoleDefinition> = {};

    try {
        const files = await readdir(rolesDir);
        for (const file of files) {
            if (!file.endsWith('.md')) continue;
            const roleId = parse(file).name;
            const content = await readFile(join(rolesDir, file), 'utf-8');
            roles[roleId] = parseRoleFile(roleId, content);
        }
    } catch (err) {
        // roles/ directory not found is normal; file parse errors should be logged
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn(`[harmonia] Warning: failed to load roles from ${rolesDir}:`, err);
        }
    }

    return roles;
}

/**
 * Load artifact schemas from schemas/ directory.
 * Schema files are named: <artifactId>.json or <artifactId>.<stepId>.json
 */
async function loadSchemas(pluginPath: string): Promise<Record<string, ArtifactSchema>> {
    const schemasDir = join(pluginPath, 'schemas');
    const schemas: Record<string, ArtifactSchema> = {};

    try {
        const files = await readdir(schemasDir);
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            const schemaId = parse(file).name; // e.g., "prd" or "prd.draft"
            const content = await readFile(join(schemasDir, file), 'utf-8');
            schemas[schemaId] = JSON.parse(content) as ArtifactSchema;
        }
    } catch (err) {
        // schemas/ directory not found is normal; parse errors should be logged
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn(`[harmonia] Warning: failed to load schemas from ${schemasDir}:`, err);
        }
    }

    return schemas;
}

/**
 * Try to load actions from tools.ts (optional).
 * The tools.ts module should export a registerActions function.
 */
async function loadActions(pluginPath: string): Promise<Record<string, ActionHandler>> {
    const toolsPath = join(pluginPath, 'tools.ts');
    const toolsJsPath = join(pluginPath, 'tools.js');

    // Try .js first (compiled), then .ts
    const actualPath = (await fileExists(toolsJsPath)) ? toolsJsPath : (await fileExists(toolsPath)) ? toolsPath : null;

    if (!actualPath) {
        return {};
    }

    try {
        const mod = await import(actualPath);
        if (typeof mod.registerActions === 'function') {
            const actions: Record<string, ActionHandler> = {};
            mod.registerActions({
                register: (name: string, handler: ActionHandler) => {
                    actions[name] = handler;
                },
            });
            return actions;
        }
    } catch (err) {
        console.warn(`[harmonia] Warning: failed to load actions from ${actualPath}:`, err);
    }

    return {};
}

/**
 * Try to load hook creator from hooks.ts (optional).
 * The hooks.ts module should export a createHooks function.
 */
async function loadHookCreator(pluginPath: string): Promise<HookCreator | undefined> {
    const hooksPath = join(pluginPath, 'hooks.ts');
    const hooksJsPath = join(pluginPath, 'hooks.js');

    const actualPath = (await fileExists(hooksJsPath)) ? hooksJsPath : (await fileExists(hooksPath)) ? hooksPath : null;

    if (!actualPath) {
        return undefined;
    }

    try {
        const mod = await import(actualPath);
        if (typeof mod.createHooks === 'function') {
            return mod.createHooks as HookCreator;
        }
    } catch (err) {
        console.warn(`[harmonia] Warning: failed to load hooks from ${actualPath}:`, err);
    }

    return undefined;
}

// ─── Public API ───

/**
 * Load a workflow plugin from a directory.
 *
 * Full loading flow:
 * 1. Read workflow.json → parse definition + artifact definitions
 * 2. Validate the workflow definition (static analysis)
 * 3. Load roles from roles/
 * 4. Load schemas from schemas/
 * 5. Optionally load actions from tools.ts
 * 6. Optionally load hook creator from hooks.ts
 *
 * @param pluginPath - Absolute path to the plugin directory
 * @param config - Optional plugin configuration
 * @param skipValidation - Skip workflow validation (for testing)
 */
export async function loadPlugin(
    pluginPath: string,
    config?: unknown,
    skipValidation = false,
): Promise<WorkflowPlugin> {
    // Step 1: Load definition
    const { definition, artifactDefinitions } = await loadDefinition(pluginPath);

    // Step 2: Load roles
    const roles = await loadRoles(pluginPath);

    // Step 3: Validate (using role IDs for reference checking)
    if (!skipValidation) {
        const roleIds = new Set(Object.keys(roles));
        const errors = validateWorkflow(definition, roleIds);

        if (errors.length > 0) {
            throw new PluginValidationError(pluginPath, errors);
        }
    }

    // Step 4: Load schemas
    const artifactSchemas = await loadSchemas(pluginPath);

    // Step 5: Load actions (optional)
    const actions = await loadActions(pluginPath);

    // Step 6: Load hook creator (optional)
    const hooks = await loadHookCreator(pluginPath);

    return {
        name: definition.name,
        definition,
        roles,
        artifactSchemas,
        artifactDefinitions,
        actions,
        hooks,
        config,
        pluginDir: pluginPath,
    };
}

/**
 * Discover registered plugins from a config.json file.
 *
 * Config format:
 * ```json
 * {
 *   "workflows": {
 *     "dev": { "path": "/path/to/dev/plugin" },
 *     "custom": { "path": "/path/to/custom", "config": { ... } }
 *   }
 * }
 * ```
 */
export async function discoverPlugins(configPath: string): Promise<PluginEntry[]> {
    if (!(await fileExists(configPath))) {
        return [];
    }

    try {
        const content = await readFile(configPath, 'utf-8');
        const config = JSON.parse(content) as GlobalConfig;

        if (!config.workflows || typeof config.workflows !== 'object') {
            return [];
        }

        return Object.entries(config.workflows).map(([name, entry]) => ({
            name,
            path: entry.path,
            config: entry.config,
        }));
    } catch {
        return [];
    }
}

/**
 * Load a plugin by name using the config.json registry.
 * Falls back to the built-in workflows directory if not found in config.
 *
 * @param configPath - Path to config.json
 * @param builtinDir - Built-in workflows directory (package-level)
 * @param name - Workflow name to load
 * @param skipValidation - Skip workflow validation (for partially migrated plugins)
 */
export async function loadPluginByName(
    configPath: string,
    builtinDir: string,
    name: string,
    skipValidation = false,
): Promise<WorkflowPlugin> {
    // First check config.json
    const entries = await discoverPlugins(configPath);
    const entry = entries.find((e) => e.name === name);

    if (entry) {
        return loadPlugin(entry.path, entry.config, skipValidation);
    }

    // Fall back to built-in directory
    const builtinPath = join(builtinDir, name);
    if (await fileExists(join(builtinPath, 'workflow.json'))) {
        return loadPlugin(builtinPath, undefined, skipValidation);
    }

    throw new PluginLoadError(name, `Workflow "${name}" not found in config or built-in directory`);
}
