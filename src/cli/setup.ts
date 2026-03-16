/**
 * CLI command: harmonia setup
 *
 * Prompt injection + hook installation only.
 * No project registration, no state init — PM does that at runtime via MCP tools.
 *
 * Usage:
 *   harmonia setup [options]
 *
 * Options:
 *   --agent <type>       Agent type: opencode | claude-code | codex | openclaw (default: auto-detect)
 */

import { resolve } from 'node:path';
import type { AgentType } from '@s_s/agent-kit';
import { detectHostAgent, injectPrompt } from '../setup/inject.js';
import { installHooks } from '../hooks/install.js';
import { getGlobalDir } from '../core/registry.js';

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
    console.log(`  Dir: ${projectDir}`);

    // 1. Detect agent
    const agentType: AgentType = opts.agent ?? (await detectHostAgent(projectDir));
    console.log(`  Agent: ${agentType}`);

    // 2. Inject prompt (project-agnostic — no params needed)
    const result = await injectPrompt(projectDir, agentType);

    const action = result.created ? 'Created' : result.replaced ? 'Updated' : 'Appended to';
    console.log(`  [done] ${action} ${result.filePath}`);

    // 3. Install hooks
    try {
        const hookResult = await installHooks(agentType, {
            dataDir: getGlobalDir(),
        });
        if (hookResult.success) {
            console.log(`  [done] Hooks installed (${hookResult.filesWritten.length} files)`);
            for (const w of hookResult.warnings) {
                console.log(`  [warn] ${w}`);
            }
        } else {
            console.log(`  [fail] Hook install failed: ${hookResult.error ?? 'unknown'}`);
        }
    } catch (err) {
        console.log(`  [fail] Hook install error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 4. Summary
    console.log(`\n  Ready. Run your agent and call project_status() to begin.\n`);
}
