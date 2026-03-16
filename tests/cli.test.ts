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
        expect(opts.workflow).toBe('dev');
        expect(opts.name).toBeUndefined();
        expect(opts.agent).toBeUndefined();
    });

    it('should parse --name', () => {
        const opts = parseSetupArgs(['--name', 'my-project']);
        expect(opts.name).toBe('my-project');
    });

    it('should parse --workflow', () => {
        const opts = parseSetupArgs(['--workflow', 'custom']);
        expect(opts.workflow).toBe('custom');
    });

    it('should parse --agent', () => {
        const opts = parseSetupArgs(['--agent', 'claude-code']);
        expect(opts.agent).toBe('claude-code');
    });

    it('should parse all options together', () => {
        const opts = parseSetupArgs(['--name', 'foo', '--workflow', 'dev', '--agent', 'opencode']);
        expect(opts.name).toBe('foo');
        expect(opts.workflow).toBe('dev');
        expect(opts.agent).toBe('opencode');
    });

    it('should throw on invalid --agent', () => {
        expect(() => parseSetupArgs(['--agent', 'vscode'])).toThrow('--agent must be one of');
    });

    it('should throw on missing --name value', () => {
        expect(() => parseSetupArgs(['--name'])).toThrow('--name requires a value');
    });

    it('should throw on unknown option', () => {
        expect(() => parseSetupArgs(['--verbose'])).toThrow('Unknown option');
    });
});

// ─── runSetup ───

describe('runSetup', () => {
    let tempDir: string;
    let projectDir: string;
    let workflowsDir: string;
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

        // Real workflows from project
        workflowsDir = join(import.meta.dirname, '..', 'workflows');

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

    it('should initialize a new project and inject prompt', async () => {
        await runSetup({
            name: 'test-project',
            workflow: 'dev',
            agent: 'opencode',
            workflowsDir,
        });

        // Check project was initialized
        const stateContent = await readFile(join(tempDir, 'test-project', 'state.json'), 'utf-8');
        const state = JSON.parse(stateContent);
        expect(state.projectName).toBe('test-project');
        expect(state.scale).toBe('small'); // default internal value
        expect(state.workflow).toBe('dev');

        // Check prompt was injected
        const agentsFile = await readFile(join(projectDir, 'AGENTS.md'), 'utf-8');
        expect(agentsFile).toContain('harmonia');

        // Check console output
        const output = consoleLogs.join('\n');
        expect(output).toContain('test-project');
        expect(output).toContain('[done]');
        expect(output).toContain('Ready');
    });

    it('should skip init if project already exists', async () => {
        // First setup
        await runSetup({
            name: 'test-project',
            workflow: 'dev',
            agent: 'opencode',
            workflowsDir,
        });

        consoleLogs = [];

        // Second setup — should skip init
        await runSetup({
            name: 'test-project',
            workflow: 'dev',
            agent: 'opencode',
            workflowsDir,
        });

        const output = consoleLogs.join('\n');
        expect(output).toContain('[skip]');
    });

    it('should default project name to directory name', async () => {
        // Don't pass name — should use basename of cwd
        await runSetup({
            workflow: 'dev',
            agent: 'opencode',
            workflowsDir,
        });

        const output = consoleLogs.join('\n');
        expect(output).toContain('test-project');
    });
});
