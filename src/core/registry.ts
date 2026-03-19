/**
 * Global registry — manages Harmonia data directory and project name → directory mappings.
 *
 * Data directory follows system conventions (see getGlobalDir()):
 *   macOS:   ~/Library/Application Support/harmonia
 *   Linux:   $XDG_DATA_HOME/harmonia  (defaults to ~/.local/share/harmonia)
 *   Windows: %APPDATA%/harmonia
 *   Override: HARMONIA_DATA_DIR env var
 *
 * Structure:
 *   <data_dir>/
 *   ├── registry.json        # { projects: { "my-app": { dir: "/path/to/src", ... } } }
 *   ├── my-app/
 *   │   ├── overrides.json   # project-level overrides (optional)
 *   │   ├── issues.json      # project-level issue tracking (optional)
 *   │   ├── iter-1/
 *   │   │   ├── state.json
 *   │   │   ├── artifacts/
 *   │   │   ├── reviews.json
 *   │   │   └── ...
 *   │   ├── iter-2/
 *   │   │   └── ...
 *   │   ├── patch-1/
 *   │   │   ├── state.json   # type: "patch", clarify/design skipped
 *   │   │   ├── artifacts/
 *   │   │   └── ...
 *   └── another-project/
 *       └── ...
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createKit } from '@s_s/agent-kit';

const REGISTRY_FILE = 'registry.json';

/** Shared kit instance for data directory resolution */
const kit = createKit('harmonia');

export interface ProjectEntry {
    /** Absolute path to the project source directory */
    dir: string;
    /** Workflow name used by this project */
    workflow: string;
    /** When the project was registered */
    createdAt: string;
    /** Currently active iteration number (starts at 1, 0 means no iteration started yet) */
    currentIteration: number;
    /** Total number of iterations created so far */
    totalIterations: number;
    /** Currently active patch number (starts at 1, 0 means no patch started yet) */
    currentPatch: number;
    /** Total number of patches created so far */
    totalPatches: number;
    /** Active context identifier, e.g. "iter-1" or "patch-2". Empty string means no context. */
    activeContext: string;
}

export interface Registry {
    projects: Record<string, ProjectEntry>;
}

/**
 * Get the global Harmonia data directory, following system conventions.
 *
 * Delegates to @s_s/agent-kit which handles:
 *   1. HARMONIA_DATA_DIR env var (explicit override)
 *   2. Platform default:
 *      - macOS:   ~/Library/Application Support/harmonia
 *      - Windows: %APPDATA%/harmonia
 *      - Linux:   $XDG_DATA_HOME/harmonia (defaults to ~/.local/share/harmonia)
 */
export function getGlobalDir(): string {
    return kit.getDataDir();
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
 * Note: Does NOT create iteration directories or state files.
 * Use startIteration() after registration to begin the first iteration.
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
        currentIteration: 0,
        totalIterations: 0,
        currentPatch: 0,
        totalPatches: 0,
        activeContext: '',
    };

    // Create project data directory under global dir
    const dataDir = getProjectDataDir(projectName);
    await mkdir(dataDir, { recursive: true });

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
 * Remove a project from the registry.
 * By default, also deletes the project data directory.
 * Pass keepData: true to only remove the registry entry.
 */
export async function unregisterProject(projectName: string, keepData = false): Promise<void> {
    const registry = await readRegistry();
    delete registry.projects[projectName];
    await writeRegistry(registry);

    if (!keepData) {
        const { rm } = await import('node:fs/promises');
        const dataDir = getProjectDataDir(projectName);
        await rm(dataDir, { recursive: true, force: true });
    }
}

/**
 * Get the iteration directory for a specific project iteration.
 * Pure path concatenation — does NOT check if the directory exists.
 */
export function getIterationDir(projectName: string, iteration: number): string {
    return join(getProjectDataDir(projectName), `iter-${iteration}`);
}

/**
 * Start a new iteration for a project.
 * Creates the iteration directory (with artifacts/ subdirectory) and updates the registry.
 *
 * @returns The new iteration number
 */
export async function startIteration(projectName: string): Promise<number> {
    const registry = await readRegistry();
    const entry = registry.projects[projectName];

    if (!entry) {
        throw new Error(`Project "${projectName}" not found in registry.`);
    }

    const newIteration = entry.totalIterations + 1;
    entry.currentIteration = newIteration;
    entry.totalIterations = newIteration;
    entry.activeContext = `iter-${newIteration}`;

    // Create iteration directory with artifacts subdirectory
    const iterDir = getIterationDir(projectName, newIteration);
    await mkdir(join(iterDir, 'artifacts'), { recursive: true });

    await writeRegistry(registry);
    return newIteration;
}

/**
 * Get the patch directory for a specific project patch.
 * Pure path concatenation — does NOT check if the directory exists.
 */
export function getPatchDir(projectName: string, patch: number): string {
    return join(getProjectDataDir(projectName), `patch-${patch}`);
}

/**
 * Start a new patch for a project.
 * Creates the patch directory (with artifacts/ subdirectory) and updates the registry.
 *
 * @returns The new patch number
 */
export async function startPatch(projectName: string): Promise<number> {
    const registry = await readRegistry();
    const entry = registry.projects[projectName];

    if (!entry) {
        throw new Error(`Project "${projectName}" not found in registry.`);
    }

    const newPatch = entry.totalPatches + 1;
    entry.currentPatch = newPatch;
    entry.totalPatches = newPatch;
    entry.activeContext = `patch-${newPatch}`;

    // Create patch directory with artifacts subdirectory
    const patchDir = getPatchDir(projectName, newPatch);
    await mkdir(join(patchDir, 'artifacts'), { recursive: true });

    await writeRegistry(registry);
    return newPatch;
}

/**
 * Resolve the active context directory for a project.
 * Parses activeContext string (e.g. "iter-1", "patch-2") into an absolute path.
 *
 * @returns { dir: string, type: 'iteration' | 'patch', number: number } or null if no active context
 */
export function resolveContextDir(
    projectName: string,
    activeContext: string,
): { dir: string; type: 'iteration' | 'patch'; number: number } | null {
    if (!activeContext) return null;

    const iterMatch = activeContext.match(/^iter-(\d+)$/);
    if (iterMatch) {
        const num = parseInt(iterMatch[1], 10);
        return { dir: getIterationDir(projectName, num), type: 'iteration', number: num };
    }

    const patchMatch = activeContext.match(/^patch-(\d+)$/);
    if (patchMatch) {
        const num = parseInt(patchMatch[1], 10);
        return { dir: getPatchDir(projectName, num), type: 'patch', number: num };
    }

    return null;
}
