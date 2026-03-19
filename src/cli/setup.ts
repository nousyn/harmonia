/**
 * CLI command: harmonia setup
 *
 * Prompt injection only.
 * No project registration, no state init, no hook installation.
 * Coordinator does project registration at runtime via MCP tools (project_init),
 * which also handles hook installation.
 *
 * Usage:
 *   harmonia setup [options]
 *
 * Options:
 *   --agent <type>       Agent type: opencode | claude-code | codex | openclaw (default: auto-detect)
 */

import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, readdir, stat, mkdir } from 'node:fs/promises';
import type { AgentType } from '@s_s/agent-kit';
import { detectHostAgent, injectPrompt } from '../setup/inject.js';
import { getGlobalDir } from '../core/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const VALID_AGENTS = ['opencode', 'claude-code', 'codex', 'openclaw'] as const;

interface SetupOptions {
    agent?: AgentType;
}

/** Parse CLI flags from argv (starting after 'setup'). */
export function parseSetupArgs(args: string[]): SetupOptions {
    const opts: SetupOptions = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const next = args[i + 1];

        switch (arg) {
            case '--agent':
                if (!next || !(VALID_AGENTS as readonly string[]).includes(next)) {
                    throw new Error(`--agent must be one of: ${VALID_AGENTS.join(', ')}`);
                }
                opts.agent = next as AgentType;
                i++;
                break;
            default:
                throw new Error(
                    `Unknown option: ${arg}\n\nUsage: harmonia setup [--agent opencode|claude-code|codex|openclaw]`,
                );
        }
    }

    return opts;
}

/** Execute the setup command. */
export async function runSetup(opts: SetupOptions): Promise<void> {
    const projectDir = resolve(process.cwd());

    console.log(`\nHarmonia Setup`);
    console.log(`──────────────────────────────`);

    // 1. Detect agent
    const agentType: AgentType = opts.agent ?? (await detectHostAgent(projectDir));
    console.log(`  Agent: ${agentType}`);

    // 2. Inject prompt (global scope — project-agnostic)
    const result = await injectPrompt(agentType);

    const action = result.created ? 'Created' : result.replaced ? 'Updated' : 'Appended to';
    console.log(`  [done] ${action} ${result.filePath}`);

    // 3. Copy built-in workflows to user data directory (skip existing)
    const builtinWorkflowsRoot = resolve(__dirname, '..', '..', 'workflows');
    const targetWorkflowsDir = join(getGlobalDir(), '.workflows');

    try {
        const entries = await readdir(builtinWorkflowsRoot);
        const workflowDirs = [];
        for (const entry of entries) {
            const entryPath = join(builtinWorkflowsRoot, entry);
            const s = await stat(entryPath);
            if (s.isDirectory()) workflowDirs.push(entry);
        }

        if (workflowDirs.length > 0) {
            await mkdir(targetWorkflowsDir, { recursive: true });

            let copied = 0;
            let skipped = 0;
            for (const dir of workflowDirs) {
                const dest = join(targetWorkflowsDir, dir);
                try {
                    await stat(dest);
                    // Already exists — skip
                    skipped++;
                } catch {
                    // Does not exist — copy
                    await cp(join(builtinWorkflowsRoot, dir), dest, { recursive: true });
                    copied++;
                }
            }
            if (copied > 0) console.log(`  [done] Copied ${copied} built-in workflow(s) to ${targetWorkflowsDir}`);
            if (skipped > 0) console.log(`  [skip] ${skipped} workflow(s) already exist in ${targetWorkflowsDir}`);
        }
    } catch {
        // Built-in workflows dir may not exist (e.g. development environment) — not fatal
        console.log(`  [warn] Could not read built-in workflows from ${builtinWorkflowsRoot}`);
    }

    // 4. Summary
    console.log(`\n  Ready. Run your agent and call project_init() to register a project.\n`);
}
