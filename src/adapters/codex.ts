/**
 * Codex agent adapter.
 *
 * Dispatches tasks by spawning `codex exec` as a child process.
 *
 * CLI reference (from 003-agent-adapters.md):
 *   codex exec "prompt" --json --full-auto --sandbox workspace-write
 *
 * Output: JSON Lines (progress on stderr, result on stdout).
 * Codex also supports `--output-schema schema.json` for structured output.
 */

import { spawnCliProcess, resolveSpawnOptions } from './cli-runner.js';
import type {
    AgentAdapter,
    AgentAdapterFactory,
    CliAdapterConfig,
    CliProcessHandle,
    TaskPayload,
    TaskResult,
    AgentStatus,
} from './types.js';

/** Codex specific configuration. */
export interface CodexConfig extends CliAdapterConfig {
    /** Sandbox mode: 'workspace-write' (default) or 'danger-full-access'. */
    sandbox?: 'workspace-write' | 'danger-full-access';
}

// ─── Adapter ───

export class CodexAdapter implements AgentAdapter {
    private readonly config: CodexConfig;
    private handle: CliProcessHandle | null = null;

    constructor(config: CodexConfig) {
        this.config = config;
    }

    async dispatchTask(payload: TaskPayload): Promise<TaskResult> {
        const command = this.config.command ?? 'codex';
        const sandbox = this.config.sandbox ?? 'workspace-write';

        const args = [
            'exec',
            payload.prompt,
            '--json',
            '--full-auto',
            '--sandbox',
            sandbox,
            ...(this.config.extraArgs ?? []),
        ];

        const spawnOpts = resolveSpawnOptions(this.config, payload.timeout);

        this.handle = spawnCliProcess(command, args, spawnOpts);
        const result = await this.handle.result;

        if (result.timedOut) {
            return {
                status: 'failed',
                artifacts: [],
                error: `Codex process timed out after ${spawnOpts.timeoutSeconds}s`,
                metadata: { exitCode: result.exitCode, timedOut: true },
            };
        }

        if (result.exitCode !== 0) {
            return {
                status: 'failed',
                artifacts: [],
                error: `Codex exited with code ${result.exitCode}: ${result.stderr.slice(0, 1000)}`,
                metadata: { exitCode: result.exitCode, stderr: result.stderr },
            };
        }

        return {
            status: 'completed',
            artifacts: [],
            metadata: { exitCode: 0, stdout: result.stdout },
        };
    }

    async checkStatus(): Promise<AgentStatus> {
        if (!this.handle) return 'idle';
        if (this.handle.isRunning()) return 'running';
        return 'exited';
    }

    async terminate(): Promise<void> {
        if (this.handle) {
            this.handle.kill();
        }
    }
}

// ─── Factory ───

export class CodexAdapterFactory implements AgentAdapterFactory {
    create(config: CliAdapterConfig): AgentAdapter {
        return new CodexAdapter(config as CodexConfig);
    }
}
