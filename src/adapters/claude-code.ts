/**
 * Claude Code agent adapter.
 *
 * Dispatches tasks by spawning `claude -p` as a child process.
 * The prompt is passed via the `-p` flag.
 *
 * CLI reference (from 003-agent-adapters.md):
 *   claude -p "prompt" --output-format json [--max-turns 20] [--system-prompt "..."]
 *
 * Output: JSON on stdout.
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

/** Claude Code specific configuration. */
export interface ClaudeCodeConfig extends CliAdapterConfig {
    /** Maximum conversation turns (default: no limit). */
    maxTurns?: number;
    /** System prompt to prepend. */
    systemPrompt?: string;
    /**
     * Skip permission prompts.
     * Defaults to `true` because Harmonia runs non-interactively — without this
     * flag Claude Code would hang waiting for user confirmation.
     */
    dangerouslySkipPermissions?: boolean;
    /** Maximum budget in USD (e.g. 5.00). Passed as `--max-budget-usd`. */
    maxBudgetUsd?: number;
}

// ─── Adapter ───

export class ClaudeCodeAdapter implements AgentAdapter {
    private readonly config: ClaudeCodeConfig;
    private handle: CliProcessHandle | null = null;

    constructor(config: ClaudeCodeConfig) {
        this.config = config;
    }

    async dispatchTask(payload: TaskPayload): Promise<TaskResult> {
        const command = this.config.command ?? 'claude';
        const skipPermissions = this.config.dangerouslySkipPermissions ?? true;
        const args = [
            '-p',
            payload.prompt,
            '--output-format',
            'json',
            ...(this.config.maxTurns ? ['--max-turns', String(this.config.maxTurns)] : []),
            ...(this.config.systemPrompt ? ['--system-prompt', this.config.systemPrompt] : []),
            ...(skipPermissions ? ['--dangerously-skip-permissions'] : []),
            ...(this.config.maxBudgetUsd != null ? ['--max-budget-usd', String(this.config.maxBudgetUsd)] : []),
            ...(this.config.extraArgs ?? []),
        ];

        const spawnOpts = resolveSpawnOptions(this.config, payload.timeout);

        this.handle = spawnCliProcess(command, args, spawnOpts);
        const result = await this.handle.result;

        if (result.timedOut) {
            return {
                status: 'failed',
                artifacts: [],
                error: `Claude Code process timed out after ${spawnOpts.timeoutSeconds}s`,
                metadata: { exitCode: result.exitCode, timedOut: true },
            };
        }

        if (result.exitCode !== 0) {
            return {
                status: 'failed',
                artifacts: [],
                error: `Claude Code exited with code ${result.exitCode}: ${result.stderr.slice(0, 1000)}`,
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

export class ClaudeCodeAdapterFactory implements AgentAdapterFactory {
    create(config: CliAdapterConfig): AgentAdapter {
        return new ClaudeCodeAdapter(config as ClaudeCodeConfig);
    }
}
