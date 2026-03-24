#!/usr/bin/env node

/**
 * Harmonia — Multi-agent orchestrator with pluggable workflows.
 *
 * Entry point with modes:
 *   - `harmonia` or `harmonia serve` → Start HTTP API server
 *   - `harmonia setup`              → CLI project setup (for humans)
 *   - `harmonia unregister <name>`  → Remove project from registry
 *
 * All project data is stored under the Harmonia data directory (platform-specific).
 * Project source directories contain code only — no Harmonia artifacts.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const subcommand = process.argv[2];

if (subcommand === 'setup') {
    // CLI mode — human-facing project setup
    const { parseSetupArgs, runSetup } = await import('./cli/setup.js');
    try {
        const opts = parseSetupArgs(process.argv.slice(3));
        await runSetup(opts);
    } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
} else if (subcommand === 'unregister') {
    // CLI mode — unregister a project from the registry
    const args = process.argv.slice(3);
    const keepData = args.includes('--keep-data');
    const projectName = args.find((a) => !a.startsWith('--'));
    if (!projectName) {
        console.error('Usage: harmonia unregister <project_name> [--keep-data]');
        process.exit(1);
    }
    const { getProject, unregisterProject } = await import('./core/registry.js');
    const entry = await getProject(projectName);
    if (!entry) {
        console.error(`Project "${projectName}" not found in registry.`);
        process.exit(1);
    }
    await unregisterProject(projectName, keepData);
    if (keepData) {
        console.log(`Project "${projectName}" unregistered. Data files were kept.`);
    } else {
        console.log(`Project "${projectName}" unregistered. Data directory has been deleted.`);
    }
} else if (subcommand === '--help' || subcommand === '-h') {
    console.log(`
Harmonia — Multi-agent orchestrator

Usage:
  harmonia                    Start HTTP API server (default port: 4600)
  harmonia serve              Same as above
  harmonia serve --port 8080  Start on a custom port
  harmonia setup <name>       Register a project in the Harmonia registry
  harmonia unregister <name>  Remove project from registry and delete data
  harmonia unregister <name> --keep-data  Remove from registry but keep data files
  harmonia --help             Show this help message
  harmonia --version          Show version

Serve options:
  --port <number>          Port to listen on (default: 4600)
  --host <address>         Hostname to bind to (default: 127.0.0.1)

Setup options:
  --dir <path>             Project source directory (default: cwd)
  --workflow <name>        Workflow to use (default: dev)
`);
} else if (subcommand === '--version' || subcommand === '-v') {
    // Read version from package.json
    const { readFile } = await import('node:fs/promises');
    try {
        const pkg = JSON.parse(await readFile(join(__dirname, '..', 'package.json'), 'utf-8'));
        console.log(pkg.version);
    } catch {
        console.log('unknown');
    }
} else if (!subcommand || subcommand === 'serve') {
    // Default: HTTP API server mode
    const { readFile } = await import('node:fs/promises');
    const { startServer } = await import('./server.js');

    // Parse serve options
    const args = process.argv.slice(subcommand === 'serve' ? 3 : 2);
    let port: number | undefined;
    let hostname: string | undefined;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const next = args[i + 1];
        if (arg === '--port' && next) {
            port = parseInt(next, 10);
            if (isNaN(port)) {
                console.error(`Invalid port: ${next}`);
                process.exit(1);
            }
            i++;
        } else if (arg === '--host' && next) {
            hostname = next;
            i++;
        }
    }

    // Read version for banner
    let version = 'unknown';
    try {
        const pkg = JSON.parse(await readFile(join(__dirname, '..', 'package.json'), 'utf-8'));
        version = pkg.version;
    } catch {
        // ignore
    }

    console.log(`\nHarmonia v${version}`);
    console.log(`──────────────────────────────`);

    try {
        const result = await startServer({ port, hostname });
        console.log(`  HTTP server listening on http://${result.hostname}:${result.port}`);
        console.log(`  Workflows: ${result.workflowsDir}`);
        console.log();
    } catch (err) {
        console.error(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
} else {
    console.error(`Unknown command: ${subcommand}\nRun 'harmonia --help' for usage.`);
    process.exit(1);
}
