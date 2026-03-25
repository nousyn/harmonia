/**
 * Tests for CLI commands.
 * Focuses on parseSetupArgs (pure logic) and runSetup (integration).
 *
 * Updated for new architecture: setup now registers a project in the
 * Harmonia registry.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSetupArgs, runSetup } from '../src/cli/setup.js';
import { getProject } from '../src/core/registry.js';

const WORKFLOWS_DIR = resolve(join(import.meta.dirname, '..', 'workflows'));

// ─── parseSetupArgs ───

describe('parseSetupArgs', () => {
    it('should parse project name', () => {
        const opts = parseSetupArgs(['my-app']);
        expect(opts.projectName).toBe('my-app');
    });

    it('should parse --dir', () => {
        const opts = parseSetupArgs(['my-app', '--dir', '/path/to/project']);
        expect(opts.projectName).toBe('my-app');
        expect(opts.dir).toBe('/path/to/project');
    });

    it('should parse --workflow', () => {
        const opts = parseSetupArgs(['my-app', '--workflow', 'custom']);
        expect(opts.projectName).toBe('my-app');
        expect(opts.workflow).toBe('custom');
    });

    it('should throw when project name is missing', () => {
        expect(() => parseSetupArgs([])).toThrow('Project name is required');
    });

    it('should throw on unknown option', () => {
        expect(() => parseSetupArgs(['my-app', '--verbose'])).toThrow('Unknown option');
    });

    it('should throw on extra positional argument', () => {
        expect(() => parseSetupArgs(['my-app', 'extra'])).toThrow('Unexpected argument');
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

        // Override data dir via env var (harmonia's getGlobalDir reads this)
        originalDataDir = process.env.HARMONIA_DATA_DIR;
        process.env.HARMONIA_DATA_DIR = tempDir;

        // Copy built-in workflows to temp dir so loadWorkflow can find them
        const { cp } = await import('node:fs/promises');
        const workflowsDest = join(tempDir, '.workflows');
        await cp(WORKFLOWS_DIR, workflowsDest, { recursive: true });

        // Capture console.log
        consoleLogs = [];
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
            consoleLogs.push(args.map(String).join(' '));
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        if (originalDataDir === undefined) {
            delete process.env.HARMONIA_DATA_DIR;
        } else {
            process.env.HARMONIA_DATA_DIR = originalDataDir;
        }
        await rm(tempDir, { recursive: true, force: true });
    });

    it('should register project in the registry', async () => {
        await runSetup({
            projectName: 'my-app',
            dir: projectDir,
            workflow: 'dev',
        });

        const entry = await getProject('my-app');
        expect(entry).not.toBeNull();
        expect(entry!.dir).toBe(projectDir);
        expect(entry!.workflow).toBe('dev');

        const output = consoleLogs.join('\n');
        expect(output).toContain('Registered');
    });

    it('should skip if project already registered', async () => {
        // First setup
        await runSetup({ projectName: 'my-app', dir: projectDir, workflow: 'dev' });
        consoleLogs = [];

        // Second setup — should be a no-op
        await runSetup({ projectName: 'my-app', dir: projectDir, workflow: 'dev' });

        const output = consoleLogs.join('\n');
        expect(output).toContain('already registered');
        expect(output).toContain('No changes made');
    });

    it('should use cwd as default project dir', async () => {
        vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

        await runSetup({ projectName: 'my-app' });

        const entry = await getProject('my-app');
        expect(entry).not.toBeNull();
        expect(entry!.dir).toBe(projectDir);
    });

    it('should use dev as default workflow', async () => {
        await runSetup({ projectName: 'my-app', dir: projectDir });

        const entry = await getProject('my-app');
        expect(entry).not.toBeNull();
        expect(entry!.workflow).toBe('dev');
    });
});
