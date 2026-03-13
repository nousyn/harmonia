#!/usr/bin/env node

/**
 * Harmonia — Multi-agent orchestration MCP server with pluggable workflows.
 *
 * All project data is stored under ~/.harmonia/<project_name>/ (global directory).
 * Project source directories contain code only — no Harmonia artifacts.
 *
 * Provides tools for managing projects:
 * - project_init: Register a project and create ~/.harmonia/<project_name>/ data dirs
 * - get_project_status: View current project phase and progress
 * - get_role_prompt: Get role prompts for agent setup
 * - update_phase: Advance project phases
 * - write_doc / read_doc / list_docs: Manage project documents
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { registerProjectInit } from './tools/project-init.js';
import { registerGetRolePrompt } from './tools/get-role-prompt.js';
import { registerUpdatePhase } from './tools/update-phase.js';
import { registerDocTools } from './tools/doc-tools.js';
import { registerGetProjectStatus } from './tools/get-project-status.js';
import { registerApproveDoc } from './tools/approve-doc.js';
import { registerOverrideTools } from './tools/override-tools.js';
import { registerDispatchRole } from './tools/dispatch-role.js';
import { registerSetupProject } from './tools/setup-project.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Workflows directory is at the package root, sibling to build/
const WORKFLOWS_DIR = process.env.HARMONIA_WORKFLOWS_DIR ?? resolve(join(__dirname, '..', 'workflows'));

const server = new McpServer({
    name: 'harmonia',
    version: '0.1.0',
});

// Register all tools
registerProjectInit(server, WORKFLOWS_DIR);
registerGetRolePrompt(server, WORKFLOWS_DIR);
registerUpdatePhase(server);
registerDocTools(server, WORKFLOWS_DIR);
registerGetProjectStatus(server, WORKFLOWS_DIR);
registerApproveDoc(server);
registerOverrideTools(server);
registerDispatchRole(server, WORKFLOWS_DIR);
registerSetupProject(server);

// Connect via stdio
async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
