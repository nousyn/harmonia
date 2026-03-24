/**
 * Tests for the shared CLI process runner.
 *
 * Spawns a real `node -e` process (no mocking of spawn itself) to verify:
 * - stdout/stderr capture
 * - exit code handling
 * - stdin piping
 * - timeout + SIGTERM
 */

import { describe, it, expect } from 'vitest';
import { runCliProcess } from '../src/adapters/cli-runner.js';

describe('runCliProcess', () => {
    it('should capture stdout from a successful process', async () => {
        const result = await runCliProcess('node', ['-e', 'console.log("hello")']);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('hello');
        expect(result.stderr).toBe('');
        expect(result.timedOut).toBe(false);
    });

    it('should capture stderr', async () => {
        const result = await runCliProcess('node', ['-e', 'console.error("oops")']);
        expect(result.exitCode).toBe(0);
        expect(result.stderr.trim()).toBe('oops');
    });

    it('should report non-zero exit code', async () => {
        const result = await runCliProcess('node', ['-e', 'process.exit(42)']);
        expect(result.exitCode).toBe(42);
        expect(result.timedOut).toBe(false);
    });

    it('should pipe stdin to the process', async () => {
        const result = await runCliProcess(
            'node',
            [
                '-e',
                `
            let data = '';
            process.stdin.on('data', c => data += c);
            process.stdin.on('end', () => console.log('got:' + data));
        `,
            ],
            { stdin: 'test-input' },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('got:test-input');
    });

    it('should time out and kill a long-running process', async () => {
        const result = await runCliProcess(
            'node',
            [
                '-e',
                `
            setTimeout(() => {}, 60000);
        `,
            ],
            { timeoutSeconds: 1 },
        );
        expect(result.timedOut).toBe(true);
    }, 10_000);

    it('should reject when command does not exist', async () => {
        await expect(runCliProcess('nonexistent-command-xyz', [])).rejects.toThrow();
    });

    it('should pass environment variables', async () => {
        const result = await runCliProcess('node', ['-e', 'console.log(process.env.TEST_VAR)'], {
            env: { TEST_VAR: 'hello-env' },
        });
        expect(result.stdout.trim()).toBe('hello-env');
    });
});
