/**
 * CLI command: harmonia setup
 *
 * Registers a project in the Harmonia registry and creates the project data directory.
 * In the new architecture (HTTP API-based), this is the CLI equivalent of POST /api/projects.
 *
 * Usage:
 *   harmonia setup <project_name> [options]
 *
 * Options:
 *   --dir <path>         Project source directory (default: cwd)
 *   --workflow <name>    Workflow to use (default: dev)
 */

import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkflow, listWorkflows } from '../core/plugin.js';
import { registerProject, getProject, getGlobalDir } from '../core/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface SetupOptions {
    projectName: string;
    dir?: string;
    workflow?: string;
}

/** Parse CLI flags from argv (starting after 'setup'). */
export function parseSetupArgs(args: string[]): SetupOptions {
    let projectName: string | undefined;
    let dir: string | undefined;
    let workflow: string | undefined;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const next = args[i + 1];

        if (arg === '--dir') {
            if (!next) throw new Error('--dir requires a value');
            dir = next;
            i++;
        } else if (arg === '--workflow') {
            if (!next) throw new Error('--workflow requires a value');
            workflow = next;
            i++;
        } else if (arg.startsWith('-')) {
            throw new Error(
                `Unknown option: ${arg}\n\nUsage: harmonia setup <project_name> [--dir <path>] [--workflow <name>]`,
            );
        } else if (!projectName) {
            projectName = arg;
        } else {
            throw new Error(
                `Unexpected argument: ${arg}\n\nUsage: harmonia setup <project_name> [--dir <path>] [--workflow <name>]`,
            );
        }
    }

    if (!projectName) {
        throw new Error(
            'Project name is required.\n\nUsage: harmonia setup <project_name> [--dir <path>] [--workflow <name>]',
        );
    }

    return { projectName, dir, workflow };
}

/** Execute the setup command. */
export async function runSetup(opts: SetupOptions): Promise<void> {
    const projectDir = resolve(opts.dir ?? process.cwd());
    const workflowName = opts.workflow ?? 'dev';

    console.log(`\nHarmonia Setup`);
    console.log(`──────────────────────────────`);

    // Check if already registered
    const existing = await getProject(opts.projectName);
    if (existing) {
        console.log(`  Project "${opts.projectName}" is already registered.`);
        console.log(`  Directory: ${existing.dir}`);
        console.log(`  Workflow: ${existing.workflow}`);
        console.log(`\n  No changes made.\n`);
        return;
    }

    // Validate workflow exists
    const workflowsDir = join(getGlobalDir(), '.workflows');
    try {
        await loadWorkflow(workflowsDir, workflowName);
    } catch {
        // Try built-in workflows
        const builtinDir = resolve(__dirname, '..', '..', 'workflows');
        try {
            await loadWorkflow(builtinDir, workflowName);
        } catch {
            const available = await listWorkflows(workflowsDir).catch(() => []);
            const builtinAvailable = await listWorkflows(builtinDir).catch(() => []);
            const all = [...new Set([...available, ...builtinAvailable])];
            throw new Error(
                `Workflow "${workflowName}" not found. Available: ${all.length > 0 ? all.join(', ') : '(none — run harmonia serve first to copy built-in workflows)'}`,
            );
        }
    }

    // Register project
    await registerProject(opts.projectName, projectDir, workflowName);

    console.log(`  Project: ${opts.projectName}`);
    console.log(`  Directory: ${projectDir}`);
    console.log(`  Workflow: ${workflowName}`);
    console.log(`\n  Registered. Start the server with 'harmonia serve' to begin.\n`);
}
