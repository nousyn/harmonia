/**
 * Shared CLI process runner for agent adapters.
 *
 * Provides two levels of API:
 * - `spawnCliProcess()` — returns a CliProcessHandle with access to the
 *   running process (for checkStatus/terminate) plus a result promise.
 * - `runCliProcess()` — convenience wrapper that spawns and awaits the result.
 *
 * Each adapter maps its agent-specific CLI invocation to this runner,
 * then parses the CliProcessResult into a TaskResult.
 */

import { spawn } from 'node:child_process';
import type { CliProcessResult, CliProcessHandle, CliAdapterConfig } from './types.js';

/** Options shared by spawnCliProcess and runCliProcess. */
export interface CliSpawnOptions {
    cwd?: string;
    env?: Record<string, string>;
    timeoutSeconds?: number;
    stdin?: string;
}

/**
 * Spawn a CLI command and return a handle to the running process.
 *
 * The handle exposes:
 * - `isRunning()` — check if the process is still alive
 * - `kill()` — send SIGTERM (then SIGKILL after 5s grace period)
 * - `result` — promise that resolves when the process exits or times out
 * - `pid` — the process ID (undefined if spawn failed before assignment)
 */
export function spawnCliProcess(command: string, args: string[], options: CliSpawnOptions = {}): CliProcessHandle {
    const env = options.env ? { ...process.env, ...options.env } : process.env;

    const child = spawn(command, args, {
        cwd: options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    let exited = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const result = new Promise<CliProcessResult>((resolve, reject) => {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

        if (options.timeoutSeconds && options.timeoutSeconds > 0) {
            timer = setTimeout(() => {
                timedOut = true;
                child.kill('SIGTERM');
                graceTimer = setTimeout(() => {
                    if (!exited) child.kill('SIGKILL');
                }, 5_000);
            }, options.timeoutSeconds * 1_000);
        }

        child.on('error', (err) => {
            if (timer) clearTimeout(timer);
            if (graceTimer) clearTimeout(graceTimer);
            exited = true;
            reject(err);
        });

        child.on('close', (exitCode) => {
            if (timer) clearTimeout(timer);
            if (graceTimer) clearTimeout(graceTimer);
            exited = true;
            resolve({
                exitCode,
                stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
                stderr: Buffer.concat(stderrChunks).toString('utf-8'),
                timedOut,
            });
        });

        // Write stdin if provided, then close
        if (options.stdin !== undefined) {
            child.stdin.write(options.stdin);
            child.stdin.end();
        } else {
            child.stdin.end();
        }
    });

    return {
        pid: child.pid,
        isRunning() {
            return !exited && !child.killed;
        },
        kill() {
            if (!exited && !child.killed) {
                child.kill('SIGTERM');
                graceTimer = setTimeout(() => {
                    if (!exited) child.kill('SIGKILL');
                }, 5_000);
            }
        },
        result,
    };
}

/**
 * Spawn a CLI command, wait for it to exit, and return the result.
 * Convenience wrapper around `spawnCliProcess()`.
 */
export async function runCliProcess(
    command: string,
    args: string[],
    options: CliSpawnOptions = {},
): Promise<CliProcessResult> {
    const handle = spawnCliProcess(command, args, options);
    return handle.result;
}

/**
 * Extract common spawn options from adapter config and optional payload timeout.
 */
export function resolveSpawnOptions(config: CliAdapterConfig, payloadTimeout?: number): CliSpawnOptions {
    return {
        cwd: config.cwd,
        env: config.env,
        // Config timeout overrides payload timeout
        timeoutSeconds: config.timeout ?? payloadTimeout,
    };
}
