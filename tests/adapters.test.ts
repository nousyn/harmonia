/**
 * Tests for agent adapters and the adapter registry.
 *
 * Adapter tests mock `spawnCliProcess` and `runCliProcess` to avoid spawning
 * real agent CLIs. Registry tests verify factory registration and lookup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskPayload, CliProcessResult, CliProcessHandle } from '../src/adapters/types.js';

// Mock the CLI runner module before importing adapters
vi.mock('../src/adapters/cli-runner.js', () => ({
    spawnCliProcess: vi.fn(),
    runCliProcess: vi.fn(),
    resolveSpawnOptions: vi.fn((config: Record<string, unknown>, payloadTimeout?: number) => ({
        cwd: config.cwd,
        env: config.env,
        timeoutSeconds: config.timeout ?? payloadTimeout,
    })),
}));

import { spawnCliProcess, runCliProcess } from '../src/adapters/cli-runner.js';
import { OpenCodeAdapter, OpenCodeAdapterFactory } from '../src/adapters/opencode.js';
import { OpenClawAdapter, OpenClawAdapterFactory } from '../src/adapters/openclaw.js';
import { ClaudeCodeAdapter, ClaudeCodeAdapterFactory } from '../src/adapters/claude-code.js';
import { CodexAdapter, CodexAdapterFactory } from '../src/adapters/codex.js';
import { DefaultAdapterRegistry, createDefaultRegistry } from '../src/adapters/registry.js';

const mockSpawnCli = vi.mocked(spawnCliProcess);
const mockRunCli = vi.mocked(runCliProcess);

// ─── Helpers ───

function makePayload(overrides: Partial<TaskPayload> = {}): TaskPayload {
    return {
        nodeId: 'task-1',
        role: 'developer',
        prompt: 'Implement feature X',
        inputArtifacts: [],
        outputExpectations: [],
        timeout: 300,
        ...overrides,
    };
}

function makeCliResult(overrides: Partial<CliProcessResult> = {}): CliProcessResult {
    return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        ...overrides,
    };
}

/**
 * Create a mock CliProcessHandle that resolves with the given result.
 * The `running` parameter controls the initial `isRunning()` state;
 * after the result promise resolves, isRunning returns false.
 */
function makeHandle(result: CliProcessResult, options: { running?: boolean } = {}): CliProcessHandle {
    let running = options.running ?? false;
    let killed = false;
    const resultPromise = Promise.resolve(result).then((r) => {
        running = false;
        return r;
    });
    return {
        pid: 12345,
        isRunning: () => running && !killed,
        kill: () => {
            killed = true;
            running = false;
        },
        result: resultPromise,
    };
}

/**
 * Create a handle that stays running until explicitly resolved.
 * Used for testing checkStatus/terminate during execution.
 */
function makeLongRunningHandle(): {
    handle: CliProcessHandle;
    resolve: (result: CliProcessResult) => void;
} {
    let running = true;
    let killed = false;
    let resolveResult!: (result: CliProcessResult) => void;
    const resultPromise = new Promise<CliProcessResult>((resolve) => {
        resolveResult = (r: CliProcessResult) => {
            running = false;
            resolve(r);
        };
    });
    return {
        handle: {
            pid: 12345,
            isRunning: () => running && !killed,
            kill: () => {
                killed = true;
                running = false;
            },
            result: resultPromise,
        },
        resolve: resolveResult,
    };
}

// ─── OpenCode Adapter ───

describe('OpenCodeAdapter', () => {
    beforeEach(() => {
        mockSpawnCli.mockReset();
        mockRunCli.mockReset();
    });

    it('should dispatch successfully with exit code 0', async () => {
        mockSpawnCli.mockReturnValue(makeHandle(makeCliResult({ stdout: '{"result":"ok"}' })));

        const adapter = new OpenCodeAdapter({});
        const result = await adapter.dispatchTask(makePayload());

        expect(result.status).toBe('completed');
        expect(result.artifacts).toEqual([]);
        expect(mockSpawnCli).toHaveBeenCalledOnce();
        const [cmd, args] = mockSpawnCli.mock.calls[0];
        expect(cmd).toBe('opencode');
        expect(args).toContain('run');
        expect(args).toContain('--format');
        expect(args).toContain('json');
    });

    it('should return failed on non-zero exit code', async () => {
        mockSpawnCli.mockReturnValue(makeHandle(makeCliResult({ exitCode: 1, stderr: 'some error' })));

        const adapter = new OpenCodeAdapter({});
        const result = await adapter.dispatchTask(makePayload());

        expect(result.status).toBe('failed');
        expect(result.error).toContain('exited with code 1');
    });

    it('should return failed on timeout', async () => {
        mockSpawnCli.mockReturnValue(makeHandle(makeCliResult({ timedOut: true, exitCode: null })));

        const adapter = new OpenCodeAdapter({});
        const result = await adapter.dispatchTask(makePayload());

        expect(result.status).toBe('failed');
        expect(result.error).toContain('timed out');
    });

    it('should pass prompt via stdin', async () => {
        mockSpawnCli.mockReturnValue(makeHandle(makeCliResult()));

        const adapter = new OpenCodeAdapter({});
        await adapter.dispatchTask(makePayload({ prompt: 'do something' }));

        const opts = mockSpawnCli.mock.calls[0][2];
        expect(opts?.stdin).toBe('do something');
    });

    it('should use custom command from config', async () => {
        mockSpawnCli.mockReturnValue(makeHandle(makeCliResult()));

        const adapter = new OpenCodeAdapter({ command: '/usr/local/bin/opencode' });
        await adapter.dispatchTask(makePayload());

        expect(mockSpawnCli.mock.calls[0][0]).toBe('/usr/local/bin/opencode');
    });

    it('should report idle before any dispatch', async () => {
        const adapter = new OpenCodeAdapter({});
        expect(await adapter.checkStatus()).toBe('idle');
    });

    it('should report running while process is alive', async () => {
        const { handle, resolve } = makeLongRunningHandle();
        mockSpawnCli.mockReturnValue(handle);

        const adapter = new OpenCodeAdapter({});
        const dispatchPromise = adapter.dispatchTask(makePayload());

        expect(await adapter.checkStatus()).toBe('running');

        resolve(makeCliResult());
        await dispatchPromise;
        expect(await adapter.checkStatus()).toBe('exited');
    });

    it('should kill the process on terminate', async () => {
        const { handle, resolve } = makeLongRunningHandle();
        mockSpawnCli.mockReturnValue(handle);

        const adapter = new OpenCodeAdapter({});
        const dispatchPromise = adapter.dispatchTask(makePayload());

        expect(handle.isRunning()).toBe(true);
        await adapter.terminate();
        expect(handle.isRunning()).toBe(false);

        resolve(makeCliResult());
        await dispatchPromise;
    });
});

// ─── OpenClaw Adapter ───

describe('OpenClawAdapter', () => {
    beforeEach(() => {
        mockSpawnCli.mockReset();
        mockRunCli.mockReset();
    });

    it('should dispatch successfully', async () => {
        mockSpawnCli.mockReturnValue(makeHandle(makeCliResult({ stdout: '{"result":"ok"}' })));

        const adapter = new OpenClawAdapter({});
        const result = await adapter.dispatchTask(makePayload());

        expect(result.status).toBe('completed');
        const [cmd, args] = mockSpawnCli.mock.calls[0];
        expect(cmd).toBe('openclaw');
        expect(args).toContain('agent');
        expect(args).toContain('--message');
    });

    it('should extract session ID from response', async () => {
        mockSpawnCli.mockReturnValue(makeHandle(makeCliResult({ stdout: '{"result":{"sessionId":"sess-123"}}' })));

        const adapter = new OpenClawAdapter({});
        const result = await adapter.dispatchTask(makePayload());

        expect(result.status).toBe('completed');
        expect(result.metadata?.sessionId).toBe('sess-123');
    });

    it('should support pushMessage after dispatch', async () => {
        // First dispatch to get session ID (spawnCliProcess)
        mockSpawnCli.mockReturnValue(makeHandle(makeCliResult({ stdout: '{"sessionId":"sess-456"}' })));
        const adapter = new OpenClawAdapter({});
        await adapter.dispatchTask(makePayload());

        // Now push a message (uses runCliProcess)
        mockRunCli.mockResolvedValueOnce(makeCliResult());
        await adapter.pushMessage('New information available');

        const [cmd, args] = mockRunCli.mock.calls[0];
        expect(cmd).toBe('openclaw');
        expect(args).toContain('--session-id');
        expect(args).toContain('sess-456');
        expect(args).toContain('--deliver');
    });

    it('should throw on pushMessage without session', async () => {
        const adapter = new OpenClawAdapter({});
        await expect(adapter.pushMessage('test')).rejects.toThrow('no active session ID');
    });

    it('should return failed on timeout', async () => {
        mockSpawnCli.mockReturnValue(makeHandle(makeCliResult({ timedOut: true, exitCode: null })));

        const adapter = new OpenClawAdapter({});
        const result = await adapter.dispatchTask(makePayload());

        expect(result.status).toBe('failed');
        expect(result.error).toContain('timed out');
    });

    it('should report running while process is alive', async () => {
        const { handle, resolve } = makeLongRunningHandle();
        mockSpawnCli.mockReturnValue(handle);

        const adapter = new OpenClawAdapter({});
        const dispatchPromise = adapter.dispatchTask(makePayload());

        expect(await adapter.checkStatus()).toBe('running');

        resolve(makeCliResult());
        await dispatchPromise;
        expect(await adapter.checkStatus()).toBe('exited');
    });

    it('should kill the process and clear session on terminate', async () => {
        const { handle, resolve } = makeLongRunningHandle();
        mockSpawnCli.mockReturnValue(handle);

        const adapter = new OpenClawAdapter({});
        const dispatchPromise = adapter.dispatchTask(makePayload());

        await adapter.terminate();
        expect(handle.isRunning()).toBe(false);

        resolve(makeCliResult());
        await dispatchPromise;
    });
});

// ─── Claude Code Adapter ───

describe('ClaudeCodeAdapter', () => {
    beforeEach(() => {
        mockSpawnCli.mockReset();
    });

    it('should dispatch with correct CLI flags', async () => {
        mockSpawnCli.mockReturnValue(makeHandle(makeCliResult({ stdout: '{}' })));

        const adapter = new ClaudeCodeAdapter({});
        const result = await adapter.dispatchTask(makePayload());

        expect(result.status).toBe('completed');
        const [cmd, args] = mockSpawnCli.mock.calls[0];
        expect(cmd).toBe('claude');
        expect(args).toContain('-p');
        expect(args).toContain('--output-format');
        expect(args).toContain('json');
    });

    it('should include maxTurns when configured', async () => {
        mockSpawnCli.mockReturnValue(makeHandle(makeCliResult()));

        const adapter = new ClaudeCodeAdapter({ maxTurns: 20 });
        await adapter.dispatchTask(makePayload());

        const args = mockSpawnCli.mock.calls[0][1];
        expect(args).toContain('--max-turns');
        expect(args).toContain('20');
    });

    it('should include system prompt when configured', async () => {
        mockSpawnCli.mockReturnValue(makeHandle(makeCliResult()));

        const adapter = new ClaudeCodeAdapter({ systemPrompt: 'You are helpful' });
        await adapter.dispatchTask(makePayload());

        const args = mockSpawnCli.mock.calls[0][1];
        expect(args).toContain('--system-prompt');
        expect(args).toContain('You are helpful');
    });

    it('should return failed on non-zero exit', async () => {
        mockSpawnCli.mockReturnValue(makeHandle(makeCliResult({ exitCode: 2, stderr: 'rate limited' })));

        const adapter = new ClaudeCodeAdapter({});
        const result = await adapter.dispatchTask(makePayload());

        expect(result.status).toBe('failed');
        expect(result.error).toContain('exited with code 2');
    });

    it('should report running while process is alive', async () => {
        const { handle, resolve } = makeLongRunningHandle();
        mockSpawnCli.mockReturnValue(handle);

        const adapter = new ClaudeCodeAdapter({});
        const dispatchPromise = adapter.dispatchTask(makePayload());

        expect(await adapter.checkStatus()).toBe('running');

        resolve(makeCliResult());
        await dispatchPromise;
        expect(await adapter.checkStatus()).toBe('exited');
    });
});

// ─── Codex Adapter ───

describe('CodexAdapter', () => {
    beforeEach(() => {
        mockSpawnCli.mockReset();
    });

    it('should dispatch with correct CLI flags', async () => {
        mockSpawnCli.mockReturnValue(makeHandle(makeCliResult({ stdout: '{}' })));

        const adapter = new CodexAdapter({});
        const result = await adapter.dispatchTask(makePayload());

        expect(result.status).toBe('completed');
        const [cmd, args] = mockSpawnCli.mock.calls[0];
        expect(cmd).toBe('codex');
        expect(args).toContain('exec');
        expect(args).toContain('--json');
        expect(args).toContain('--full-auto');
        expect(args).toContain('--sandbox');
        expect(args).toContain('workspace-write');
    });

    it('should use custom sandbox mode', async () => {
        mockSpawnCli.mockReturnValue(makeHandle(makeCliResult()));

        const adapter = new CodexAdapter({ sandbox: 'danger-full-access' });
        await adapter.dispatchTask(makePayload());

        const args = mockSpawnCli.mock.calls[0][1];
        expect(args).toContain('danger-full-access');
    });

    it('should return failed on non-zero exit', async () => {
        mockSpawnCli.mockReturnValue(makeHandle(makeCliResult({ exitCode: 1, stderr: 'sandbox error' })));

        const adapter = new CodexAdapter({});
        const result = await adapter.dispatchTask(makePayload());

        expect(result.status).toBe('failed');
    });

    it('should kill the process on terminate', async () => {
        const { handle, resolve } = makeLongRunningHandle();
        mockSpawnCli.mockReturnValue(handle);

        const adapter = new CodexAdapter({});
        const dispatchPromise = adapter.dispatchTask(makePayload());

        expect(handle.isRunning()).toBe(true);
        await adapter.terminate();
        expect(handle.isRunning()).toBe(false);

        resolve(makeCliResult());
        await dispatchPromise;
    });
});

// ─── DefaultAdapterRegistry ───

describe('DefaultAdapterRegistry', () => {
    it('should start empty', () => {
        const registry = new DefaultAdapterRegistry();
        expect(registry.listTypes()).toEqual([]);
    });

    it('should register and retrieve a factory', () => {
        const registry = new DefaultAdapterRegistry();
        const factory = new OpenCodeAdapterFactory();
        registry.register('opencode', factory);

        expect(registry.getFactory('opencode')).toBe(factory);
        expect(registry.listTypes()).toEqual(['opencode']);
    });

    it('should return undefined for unregistered type', () => {
        const registry = new DefaultAdapterRegistry();
        expect(registry.getFactory('nonexistent')).toBeUndefined();
    });

    it('should allow overriding a registered factory', () => {
        const registry = new DefaultAdapterRegistry();
        const factory1 = new OpenCodeAdapterFactory();
        const factory2 = new OpenCodeAdapterFactory();
        registry.register('opencode', factory1);
        registry.register('opencode', factory2);

        expect(registry.getFactory('opencode')).toBe(factory2);
    });
});

// ─── createDefaultRegistry ───

describe('createDefaultRegistry', () => {
    it('should register all four built-in adapters', () => {
        const registry = createDefaultRegistry();
        const types = registry.listTypes();

        expect(types).toContain('opencode');
        expect(types).toContain('openclaw');
        expect(types).toContain('claude-code');
        expect(types).toContain('codex');
        expect(types).toHaveLength(4);
    });

    it('should return working factories for each type', () => {
        const registry = createDefaultRegistry();

        for (const type of ['opencode', 'openclaw', 'claude-code', 'codex']) {
            const factory = registry.getFactory(type);
            expect(factory).toBeDefined();
            const adapter = factory!.create({});
            expect(adapter.dispatchTask).toBeTypeOf('function');
            expect(adapter.checkStatus).toBeTypeOf('function');
            expect(adapter.terminate).toBeTypeOf('function');
        }
    });

    it('should only provide pushMessage on openclaw adapter', () => {
        const registry = createDefaultRegistry();

        const openclawAdapter = registry.getFactory('openclaw')!.create({});
        expect(openclawAdapter.pushMessage).toBeTypeOf('function');

        // Other adapters should NOT have pushMessage
        for (const type of ['opencode', 'claude-code', 'codex']) {
            const adapter = registry.getFactory(type)!.create({});
            expect(adapter.pushMessage).toBeUndefined();
        }
    });
});
