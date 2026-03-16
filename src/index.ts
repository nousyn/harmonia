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

// Workflows directory is at the package root, sibling to build/
const WORKFLOWS_DIR = process.env.HARMONIA_WORKFLOWS_DIR ?? resolve(join(__dirname, '..', 'workflows'));

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
} else if (subcommand === '--help' || subcommand === '-h') {
    console.log(`
Harmonia — Multi-agent orchestration MCP server

Usage:
  harmonia                Start MCP stdio server
  harmonia setup          Inject PM prompt + install hooks in current directory
  harmonia --help         Show this help message

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

    const { registerProjectInit } = await import('./tools/project-init.js');
    const { registerSetScale } = await import('./tools/set-scale.js');
    const { registerGetRolePrompt } = await import('./tools/get-role-prompt.js');
    const { registerUpdatePhase } = await import('./tools/update-phase.js');
    const { registerDocTools } = await import('./tools/doc-tools.js');
    const { registerGetProjectStatus } = await import('./tools/get-project-status.js');
    const { registerApproveDoc } = await import('./tools/approve-doc.js');
    const { registerOverrideTools } = await import('./tools/override-tools.js');
    const { registerDispatchRole } = await import('./tools/dispatch-role.js');
    const { registerReportDispatch } = await import('./tools/report-dispatch.js');
    const server = new McpServer({
        name: 'harmonia',
        version: '0.1.0',
    });

    // Register all tools
    registerProjectInit(server, WORKFLOWS_DIR);
    registerSetScale(server, WORKFLOWS_DIR);
    registerGetRolePrompt(server, WORKFLOWS_DIR);
    registerUpdatePhase(server, WORKFLOWS_DIR);
    registerDocTools(server, WORKFLOWS_DIR);
    registerGetProjectStatus(server, WORKFLOWS_DIR);
    registerApproveDoc(server);
    registerOverrideTools(server);
    registerDispatchRole(server, WORKFLOWS_DIR);
    registerReportDispatch(server, WORKFLOWS_DIR);

    // Connect via stdio
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
