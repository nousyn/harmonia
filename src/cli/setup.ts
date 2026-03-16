/**
 * CLI command: harmonia setup
 *
 * One-shot project initialization from the terminal.
 * Equivalent to project_init + project_setup via MCP, but for humans.
 *
 * Usage:
 *   harmonia setup [options]
 *
 * Options:
 *   --name <name>       Project name (default: directory name)
 *   --workflow <name>    Workflow to use (default: dev)
 *   --scale <size>       Project scale: small | medium | large (default: small)
 *   --agent <type>       Agent type: opencode | claude-code | codex | openclaw (default: auto-detect)
 */

import { resolve, basename } from 'node:path';
import type { AgentType } from '@s_s/agent-kit';
import { loadWorkflow } from '../core/workflow.js';
import { initProjectState, readState, projectStateExists } from '../core/state.js';
import { registerProject, getProject, getGlobalDir } from '../core/registry.js';
import { detectHostAgent, injectPrompt } from '../setup/inject.js';
import { installHooks } from '../hooks/install.js';
import type { ProjectScale } from '../core/types.js';

const VALID_SCALES = ['small', 'medium', 'large'] as const;
const VALID_AGENTS = ['opencode', 'claude-code', 'codex', 'openclaw'] as const;

interface SetupOptions {
    name?: string;
    workflow: string;
    scale: ProjectScale;
    agent?: AgentType;
    workflowsDir: string;
}

/** Parse CLI flags from argv (starting after 'setup'). */
export function parseSetupArgs(args: string[]): Omit<SetupOptions, 'workflowsDir'> {
    const opts: Omit<SetupOptions, 'workflowsDir'> = {
        workflow: 'dev',
        scale: 'small',
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const next = args[i + 1];

        switch (arg) {
            case '--name':
                if (!next) throw new Error('--name requires a value');
                opts.name = next;
                i++;
                break;
            case '--workflow':
                if (!next) throw new Error('--workflow requires a value');
                opts.workflow = next;
                i++;
                break;
            case '--scale':
                if (!next || !(VALID_SCALES as readonly string[]).includes(next)) {
                    throw new Error(`--scale must be one of: ${VALID_SCALES.join(', ')}`);
                }
                opts.scale = next as ProjectScale;
                i++;
                break;
            case '--agent':
                if (!next || !(VALID_AGENTS as readonly string[]).includes(next)) {
                    throw new Error(`--agent must be one of: ${VALID_AGENTS.join(', ')}`);
                }
                opts.agent = next as AgentType;
                i++;
                break;
            default:
                throw new Error(
                    `Unknown option: ${arg}\n\nUsage: harmonia setup [--name <name>] [--workflow <name>] [--scale small|medium|large] [--agent opencode|claude-code|codex|openclaw]`,
                );
        }
    }

    return opts;
}

/** Execute the setup command. */
export async function runSetup(opts: SetupOptions): Promise<void> {
    const projectDir = resolve(process.cwd());
    const projectName = opts.name ?? basename(projectDir);

    console.log(`\nHarmonia Setup`);
    console.log(`──────────────────────────────`);
    console.log(`  Project:  ${projectName}`);
    console.log(`  Dir:      ${projectDir}`);
    console.log(`  Workflow: ${opts.workflow}`);
    console.log(`  Scale:    ${opts.scale}`);

    // 1. Load workflow
    const wf = await loadWorkflow(opts.workflowsDir, opts.workflow);

    // 2. Init project (skip if already exists)
    const existing = await getProject(projectName);
    if (existing) {
        console.log(`\n  [skip] Project already registered.`);
    } else {
        await registerProject(projectName, projectDir, opts.workflow);
        await initProjectState(projectName, projectDir, wf, opts.scale);
        console.log(`\n  [done] Project initialized.`);
    }

    // 3. Detect agent
    const agentType: AgentType = opts.agent ?? (await detectHostAgent(projectDir));
    console.log(`  Agent:    ${agentType}`);

    // 4. Inject prompt
    const state = await readState(projectName);
    const result = await injectPrompt(projectDir, agentType, {
        projectName: state.projectName,
        projectDir: state.projectDir,
        workflow: state.workflow,
        scale: state.scale,
    });

    const action = result.created ? 'Created' : result.replaced ? 'Updated' : 'Appended to';
    console.log(`  [done] ${action} ${result.filePath}`);

    // 5. Install hooks
    try {
        const hookResult = await installHooks(agentType, {
            dataDir: getGlobalDir(),
            projectName: state.projectName,
            projectDir: state.projectDir,
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

    // 6. Summary
    const docCount = Object.keys(wf.definition.docs).length;
    const roleCount = Object.keys(wf.roles).length;
    console.log(`\n  Ready. ${roleCount} roles, ${docCount} doc types, ${wf.definition.phases.length} phases.`);
    console.log(`  Run your agent and call project_status to begin.\n`);
}
