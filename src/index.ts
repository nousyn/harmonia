#!/usr/bin/env node

/**
 * Harmonia — Multi-agent orchestration MCP server with pluggable workflows.
 *
 * Entry point with two modes:
 *   - `harmonia`         → Start MCP stdio server (for agent consumers)
 *   - `harmonia setup`   → CLI project setup (for humans)
 *
 * All project data is stored under the Harmonia data directory (platform-specific).
 * Project source directories contain code only — no Harmonia artifacts.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Built-in workflows directory (package root, sibling to build/)
const BUILTIN_WORKFLOWS_DIR = resolve(join(__dirname, '..', 'workflows'));

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
Harmonia — Multi-agent orchestration MCP server

Usage:
  harmonia                    Start MCP stdio server
  harmonia setup              Inject PM prompt + install hooks in current directory
  harmonia unregister <name>  Remove project from registry and delete data (default)
  harmonia unregister <name> --keep-data  Remove from registry but keep data files
  harmonia --help             Show this help message

Setup options:
  --agent <type>           opencode | claude-code | codex | openclaw (default: auto-detect)
`);
} else if (subcommand && subcommand !== '--version' && subcommand !== '-v') {
    console.error(`Unknown command: ${subcommand}\nRun 'harmonia --help' for usage.`);
    process.exit(1);
} else if (subcommand === '--version' || subcommand === '-v') {
    // Read version from package.json
    const { readFile } = await import('node:fs/promises');
    try {
        const pkg = JSON.parse(await readFile(join(__dirname, '..', 'package.json'), 'utf-8'));
        console.log(pkg.version);
    } catch {
        console.log('unknown');
    }
} else {
    // Default: MCP stdio server mode
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const { getGlobalDir } = await import('./core/registry.js');

    const { registerProjectInit } = await import('./tools/project-init.js');
    const { registerIterationStart } = await import('./tools/iteration-start.js');
    const { registerGetRolePrompt } = await import('./tools/get-role-prompt.js');
    const { registerArtifactTools } = await import('./tools/artifact-tools.js');
    const { registerGetProjectStatus } = await import('./tools/get-project-status.js');
    const { registerApproveArtifact } = await import('./tools/approve-artifact.js');
    const { registerDispatchRole } = await import('./tools/dispatch-role.js');
    const { registerReportDispatch } = await import('./tools/report-dispatch.js');
    const { registerPatchStart } = await import('./tools/patch-start.js');
    const { registerIssueTools } = await import('./tools/issue-tools.js');
    const { registerArtifactSchema } = await import('./tools/artifact-schema.js');

    // Custom workflows directory: <data_dir>/.workflows
    const CUSTOM_WORKFLOWS_DIR = join(getGlobalDir(), '.workflows');

    const server = new McpServer({
        name: 'harmonia',
        version: '0.1.0',
    });

    // Register all tools
    registerProjectInit(server, BUILTIN_WORKFLOWS_DIR, CUSTOM_WORKFLOWS_DIR);
    registerIterationStart(server, BUILTIN_WORKFLOWS_DIR, CUSTOM_WORKFLOWS_DIR);
    registerGetRolePrompt(server, BUILTIN_WORKFLOWS_DIR, CUSTOM_WORKFLOWS_DIR);
    registerArtifactTools(server, BUILTIN_WORKFLOWS_DIR, CUSTOM_WORKFLOWS_DIR);
    registerGetProjectStatus(server, BUILTIN_WORKFLOWS_DIR, CUSTOM_WORKFLOWS_DIR);
    registerApproveArtifact(server, BUILTIN_WORKFLOWS_DIR, CUSTOM_WORKFLOWS_DIR);
    registerDispatchRole(server, BUILTIN_WORKFLOWS_DIR, CUSTOM_WORKFLOWS_DIR);
    registerReportDispatch(server, BUILTIN_WORKFLOWS_DIR, CUSTOM_WORKFLOWS_DIR);
    registerPatchStart(server, BUILTIN_WORKFLOWS_DIR, CUSTOM_WORKFLOWS_DIR);
    registerIssueTools(server);
    registerArtifactSchema(server, BUILTIN_WORKFLOWS_DIR, CUSTOM_WORKFLOWS_DIR);

    // Connect via stdio
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
