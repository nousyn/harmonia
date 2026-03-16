/**
 * Tests for CLI commands.
 * Focuses on parseSetupArgs (pure logic) and runSetup (integration with mocked deps).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSetupArgs, runSetup } from '../src/cli/setup.js';

// ─── parseSetupArgs ───

describe('parseSetupArgs', () => {
    it('should return defaults with no args', () => {
        const opts = parseSetupArgs([]);
        expect(opts.agent).toBeUndefined();
    });

    it('should parse --agent', () => {
        const opts = parseSetupArgs(['--agent', 'claude-code']);
        expect(opts.agent).toBe('claude-code');
    });

    it('should throw on invalid --agent', () => {
        expect(() => parseSetupArgs(['--agent', 'vscode'])).toThrow('--agent must be one of');
    });

    it('should throw on unknown option', () => {
        expect(() => parseSetupArgs(['--verbose'])).toThrow('Unknown option');
    });

    it('should throw on --name (removed)', () => {
        expect(() => parseSetupArgs(['--name', 'foo'])).toThrow('Unknown option');
    });

    it('should throw on --workflow (removed)', () => {
        expect(() => parseSetupArgs(['--workflow', 'dev'])).toThrow('Unknown option');
    });
});

// ─── runSetup ───

describe('runSetup', () => {
    let tempDir: string;
    let projectDir: string;
    let consoleLogs: string[];

    let originalDataDir: string | undefined;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'harmonia-cli-test-'));
        projectDir = join(tempDir, 'test-project');
        await mkdir(projectDir, { recursive: true });

        // Override data dir via env var (agent-kit reads this)
        originalDataDir = process.env.HARMONIA_DATA_DIR;
        process.env.HARMONIA_DATA_DIR = tempDir;

        // Mock cwd to our temp project dir
        vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

        // Capture console.log
        consoleLogs = [];
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
            consoleLogs.push(args.map(String).join(' '));
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        // Restore env var
        if (originalDataDir === undefined) {
            delete process.env.HARMONIA_DATA_DIR;
        } else {
            process.env.HARMONIA_DATA_DIR = originalDataDir;
        }
        await rm(tempDir, { recursive: true, force: true });
    });

    it('should inject prompt and install hooks', async () => {
        await runSetup({
            agent: 'opencode',
        });

        // Check prompt was injected
        const agentsFile = await readFile(join(projectDir, 'AGENTS.md'), 'utf-8');
        expect(agentsFile).toContain('harmonia');

        // Check console output
        const output = consoleLogs.join('\n');
        expect(output).toContain('[done]');
        expect(output).toContain('Ready');
    });

    it('should not register project or initialize state', async () => {
        await runSetup({
            agent: 'opencode',
        });

        // No state.json should exist — setup no longer initializes project
        const stateExists = await readFile(join(tempDir, 'test-project', 'state.json'), 'utf-8').catch(() => null);
        expect(stateExists).toBeNull();
    });

    it('should be idempotent (re-run updates prompt)', async () => {
        // First setup
        await runSetup({ agent: 'opencode' });

        consoleLogs = [];

        // Second setup — should update (replace) the prompt
        await runSetup({ agent: 'opencode' });

        const output = consoleLogs.join('\n');
        expect(output).toContain('Updated');
        expect(output).toContain('[done]');
    });
});
