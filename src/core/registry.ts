/**
 * Global registry — manages ~/.harmonia/ and project name → directory mappings.
 *
 * Structure:
 *   ~/.harmonia/
 *   ├── registry.json        # { projects: { "my-app": { dir: "/path/to/src", ... } } }
 *   ├── my-app/
 *   │   ├── state.json
 *   │   ├── docs/
 *   │   ├── sessions/
 *   │   └── ...
 *   └── another-project/
 *       └── ...
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HARMONIA_DIR_NAME = '.harmonia';
const REGISTRY_FILE = 'registry.json';

export interface ProjectEntry {
    /** Absolute path to the project source directory */
    dir: string;
    /** Workflow name used by this project */
    workflow: string;
    /** When the project was registered */
    createdAt: string;
}

export interface Registry {
    projects: Record<string, ProjectEntry>;
}

/**
 * Get the global Harmonia directory path.
 * Supports HARMONIA_HOME env var override for testing.
 */
export function getGlobalDir(): string {
    return process.env.HARMONIA_HOME ?? join(homedir(), HARMONIA_DIR_NAME);
}

/**
 * Get the data directory for a specific project within the global dir.
 */
export function getProjectDataDir(projectName: string): string {
    return join(getGlobalDir(), projectName);
}

/**
 * Read the global registry. Returns empty registry if file doesn't exist.
 */
export async function readRegistry(): Promise<Registry> {
    try {
        const content = await readFile(join(getGlobalDir(), REGISTRY_FILE), 'utf-8');
        return JSON.parse(content) as Registry;
    } catch {
        return { projects: {} };
    }
}

/**
 * Write the global registry to disk.
 */
export async function writeRegistry(registry: Registry): Promise<void> {
    const globalDir = getGlobalDir();
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(globalDir, REGISTRY_FILE), JSON.stringify(registry, null, 2) + '\n', 'utf-8');
}

/**
 * Register a new project. Creates the project data directory.
 */
export async function registerProject(projectName: string, projectDir: string, workflow: string): Promise<void> {
    const registry = await readRegistry();

    if (registry.projects[projectName]) {
        throw new Error(
            `Project "${projectName}" already exists. Use a different name or remove the existing project first.`,
        );
    }

    registry.projects[projectName] = {
        dir: projectDir,
        workflow,
        createdAt: new Date().toISOString(),
    };

    // Create project data directory structure under global dir
    const dataDir = getProjectDataDir(projectName);
    await mkdir(join(dataDir, 'docs'), { recursive: true });
    await mkdir(join(dataDir, 'adr'), { recursive: true });
    await mkdir(join(dataDir, 'sessions'), { recursive: true });
    await mkdir(join(dataDir, 'messages'), { recursive: true });
    await mkdir(join(dataDir, 'tasks'), { recursive: true });

    // Create the project source directory if it doesn't exist
    await mkdir(projectDir, { recursive: true });

    await writeRegistry(registry);
}

/**
 * Look up a project by name. Returns null if not found.
 */
export async function getProject(projectName: string): Promise<ProjectEntry | null> {
    const registry = await readRegistry();
    return registry.projects[projectName] ?? null;
}

/**
 * List all registered project names.
 */
export async function listProjects(): Promise<string[]> {
    const registry = await readRegistry();
    return Object.keys(registry.projects);
}

/**
 * Remove a project from the registry (does NOT delete files).
 */
export async function unregisterProject(projectName: string): Promise<void> {
    const registry = await readRegistry();
    delete registry.projects[projectName];
    await writeRegistry(registry);
}
