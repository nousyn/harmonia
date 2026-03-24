/**
 * OpenClaw agent adapter.
 *
 * OpenClaw is the only adapter that implements `pushMessage()` — it can inject
 * messages into an active coordinator session via the `--deliver` flag.
 *
 * CLI reference (from 003-agent-adapters.md):
 *   Dispatch:  openclaw agent --message "prompt" --timeout 300
 *   Push:      openclaw agent --session-id <id> --message "..." --deliver
 *
 * Output: JSON-RPC response on stdout.
 */

import { spawnCliProcess, runCliProcess, resolveSpawnOptions } from './cli-runner.js';
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

export class OpenClawAdapter implements AgentAdapter {
    private readonly config: CliAdapterConfig;
    private sessionId: string | undefined;
    private handle: CliProcessHandle | null = null;

    constructor(config: CliAdapterConfig) {
        this.config = config;
    }

    async dispatchTask(payload: TaskPayload): Promise<TaskResult> {
        const command = this.config.command ?? 'openclaw';
        const spawnOpts = resolveSpawnOptions(this.config, payload.timeout);

        const args = [
            'agent',
            '--message',
            payload.prompt,
            ...(spawnOpts.timeoutSeconds ? ['--timeout', String(spawnOpts.timeoutSeconds)] : []),
            ...(this.config.extraArgs ?? []),
        ];

        this.handle = spawnCliProcess(command, args, spawnOpts);
        const result = await this.handle.result;

        if (result.timedOut) {
            return {
                status: 'failed',
                artifacts: [],
                error: `OpenClaw process timed out after ${spawnOpts.timeoutSeconds}s`,
                metadata: { exitCode: result.exitCode, timedOut: true },
            };
        }

        // Try to extract session ID from response for pushMessage use
        this.tryExtractSessionId(result.stdout);

        if (result.exitCode !== 0) {
            return {
                status: 'failed',
                artifacts: [],
                error: `OpenClaw exited with code ${result.exitCode}: ${result.stderr.slice(0, 1000)}`,
                metadata: { exitCode: result.exitCode, stderr: result.stderr },
            };
        }

        return {
            status: 'completed',
            artifacts: [],
            metadata: { exitCode: 0, stdout: result.stdout, sessionId: this.sessionId },
        };
    }

    /**
     * Push a message to the active coordinator session.
     * Uses `openclaw agent --session-id <id> --message "..." --deliver`.
     */
    async pushMessage(message: string): Promise<void> {
        if (!this.sessionId) {
            throw new Error('Cannot push message: no active session ID. Dispatch a task first.');
        }

        const command = this.config.command ?? 'openclaw';
        const args = ['agent', '--session-id', this.sessionId, '--message', message, '--deliver'];

        const result = await runCliProcess(command, args, {
            cwd: this.config.cwd,
            env: this.config.env,
            timeoutSeconds: 30, // Short timeout for push operations
        });

        if (result.exitCode !== 0) {
            throw new Error(
                `Failed to push message to OpenClaw session ${this.sessionId}: ${result.stderr.slice(0, 500)}`,
            );
        }
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
        this.sessionId = undefined;
    }

    // ─── Internal ───

    /**
     * Attempt to extract a session ID from the JSON-RPC response.
     * Best-effort — if parsing fails, sessionId remains undefined.
     */
    private tryExtractSessionId(stdout: string): void {
        try {
            const parsed = JSON.parse(stdout);
            if (parsed?.result?.sessionId) {
                this.sessionId = String(parsed.result.sessionId);
            } else if (parsed?.sessionId) {
                this.sessionId = String(parsed.sessionId);
            }
        } catch {
            // Not valid JSON — ignore
        }
    }
}

// ─── Factory ───

export class OpenClawAdapterFactory implements AgentAdapterFactory {
    create(config: CliAdapterConfig): AgentAdapter {
        return new OpenClawAdapter(config);
    }
}
