/**
 * OpenCode agent adapter.
 *
 * Dispatches tasks by spawning `opencode run` as a child process.
 * The full prompt is passed via stdin to avoid shell argument length limits.
 *
 * CLI reference (from 003-agent-adapters.md):
 *   opencode run "prompt" --format json [--model <model>] [--session <id>]
 *
 * Output: JSON event stream on stdout.
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

// ─── Adapter ───

export class OpenCodeAdapter implements AgentAdapter {
    private readonly config: CliAdapterConfig;
    private handle: CliProcessHandle | null = null;

    constructor(config: CliAdapterConfig) {
        this.config = config;
    }

    async dispatchTask(payload: TaskPayload): Promise<TaskResult> {
        const command = this.config.command ?? 'opencode';
        const args = ['run', '--format', 'json', ...(this.config.extraArgs ?? [])];

        const spawnOpts = resolveSpawnOptions(this.config, payload.timeout);

        this.handle = spawnCliProcess(command, args, {
            ...spawnOpts,
            stdin: payload.prompt,
        });

        const result = await this.handle.result;

        if (result.timedOut) {
            return {
                status: 'failed',
                artifacts: [],
                error: `OpenCode process timed out after ${spawnOpts.timeoutSeconds}s`,
                metadata: { exitCode: result.exitCode, timedOut: true },
            };
        }

        if (result.exitCode !== 0) {
            return {
                status: 'failed',
                artifacts: [],
                error: `OpenCode exited with code ${result.exitCode}: ${result.stderr.slice(0, 1000)}`,
                metadata: { exitCode: result.exitCode, stderr: result.stderr },
            };
        }

        // OpenCode outputs JSON events — for now we treat exit code 0 as success.
        // Artifact collection is handled by the Orchestrator after dispatch.
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

export class OpenCodeAdapterFactory implements AgentAdapterFactory {
    create(config: CliAdapterConfig): AgentAdapter {
        return new OpenCodeAdapter(config);
    }
}
