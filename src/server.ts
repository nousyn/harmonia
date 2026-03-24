/**
 * HTTP Server — Harmonia orchestrator service entry point.
 *
 * Uses Hono framework with @hono/node-server for serving.
 * Responsible for:
 * - Creating the Hono app with API routes
 * - Ensuring workflows are available
 * - Starting the HTTP listener
 */

import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, readdir, stat, mkdir } from 'node:fs/promises';
import { getGlobalDir } from './core/registry.js';
import { createApiRoutes } from './api/routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServerOptions {
    /** Port to listen on (default: 4600) */
    port?: number;
    /** Hostname to bind to (default: 127.0.0.1) */
    hostname?: string;
}

/**
 * Ensure built-in workflows are copied to the user data directory.
 * Skips existing workflows (no overwrite).
 */
async function ensureWorkflows(): Promise<{ workflowsDir: string; copied: number; skipped: number }> {
    const builtinWorkflowsRoot = resolve(__dirname, '..', 'workflows');
    const targetWorkflowsDir = join(getGlobalDir(), '.workflows');

    let copied = 0;
    let skipped = 0;

    try {
        const entries = await readdir(builtinWorkflowsRoot);
        const workflowDirs: string[] = [];
        for (const entry of entries) {
            const entryPath = join(builtinWorkflowsRoot, entry);
            const s = await stat(entryPath);
            if (s.isDirectory()) workflowDirs.push(entry);
        }

        if (workflowDirs.length > 0) {
            await mkdir(targetWorkflowsDir, { recursive: true });

            for (const dir of workflowDirs) {
                const dest = join(targetWorkflowsDir, dir);
                try {
                    await stat(dest);
                    skipped++;
                } catch {
                    await cp(join(builtinWorkflowsRoot, dir), dest, { recursive: true });
                    copied++;
                }
            }
        }
    } catch {
        // Built-in workflows dir may not exist — not fatal
    }

    return { workflowsDir: targetWorkflowsDir, copied, skipped };
}

/**
 * Create and configure the Hono application.
 */
export function createApp(workflowsDir: string): Hono {
    const app = new Hono();

    // Health check
    app.get('/health', (c) => c.json({ status: 'ok' }));

    // Mount API routes
    const api = createApiRoutes(workflowsDir);
    app.route('/api', api);

    return app;
}

/**
 * Start the Harmonia HTTP server.
 *
 * 1. Ensure built-in workflows are in user data dir
 * 2. Create Hono app with API routes
 * 3. Start listening
 */
export async function startServer(options: ServerOptions = {}): Promise<{
    server: ServerType;
    port: number;
    hostname: string;
    workflowsDir: string;
}> {
    const port = options.port ?? 4600;
    const hostname = options.hostname ?? '127.0.0.1';

    // Ensure workflows
    const wfResult = await ensureWorkflows();

    if (wfResult.copied > 0) {
        console.log(`  Copied ${wfResult.copied} built-in workflow(s)`);
    }
    if (wfResult.skipped > 0) {
        console.log(`  ${wfResult.skipped} workflow(s) already exist`);
    }

    // Create app
    const app = createApp(wfResult.workflowsDir);

    // Start server
    const server = serve({
        fetch: app.fetch,
        port,
        hostname,
    });

    return { server, port, hostname, workflowsDir: wfResult.workflowsDir };
}
