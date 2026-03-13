import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectHostAgent, injectPrompt, removePrompt } from '../src/setup/inject.js';
import { HARMONIA_MARKER_START, HARMONIA_MARKER_END, generateOpenCodePrompt } from '../src/setup/templates.js';

describe('setup injection', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'harmonia-setup-test-'));
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    // ─── detectHostAgent ───

    it('should default to opencode when no agent-specific files exist', async () => {
        const agent = await detectHostAgent(tempDir);
        expect(agent).toBe('opencode');
    });

    it('should detect claude-code when .claude/settings.json exists', async () => {
        await mkdir(join(tempDir, '.claude'), { recursive: true });
        await writeFile(join(tempDir, '.claude', 'settings.json'), '{}', 'utf-8');
        const agent = await detectHostAgent(tempDir);
        expect(agent).toBe('claude-code');
    });

    // ─── injectPrompt ───

    it('should create AGENTS.md when it does not exist', async () => {
        const result = await injectPrompt(tempDir, 'opencode', {
            projectName: 'test-proj',
            projectDir: tempDir,
            workflow: 'dev',
            scale: 'small',
        });

        expect(result.created).toBe(true);
        expect(result.replaced).toBe(false);
        expect(result.filePath).toBe(join(tempDir, 'AGENTS.md'));

        const content = await readFile(result.filePath, 'utf-8');
        expect(content).toContain(HARMONIA_MARKER_START);
        expect(content).toContain(HARMONIA_MARKER_END);
        expect(content).toContain('test-proj');
    });

    it('should append to existing AGENTS.md', async () => {
        const existingContent = '# My Project\n\nSome existing instructions.\n';
        await writeFile(join(tempDir, 'AGENTS.md'), existingContent, 'utf-8');

        const result = await injectPrompt(tempDir, 'opencode', {
            projectName: 'test-proj',
            projectDir: tempDir,
            workflow: 'dev',
            scale: 'medium',
        });

        expect(result.created).toBe(false);
        expect(result.replaced).toBe(false);

        const content = await readFile(result.filePath, 'utf-8');
        expect(content).toContain('# My Project');
        expect(content).toContain(HARMONIA_MARKER_START);
        expect(content).toContain('medium');
    });

    it('should replace existing harmonia block (idempotent)', async () => {
        // First injection
        await injectPrompt(tempDir, 'opencode', {
            projectName: 'test-proj',
            projectDir: tempDir,
            workflow: 'dev',
            scale: 'small',
        });

        // Second injection with different params
        const result = await injectPrompt(tempDir, 'opencode', {
            projectName: 'test-proj',
            projectDir: tempDir,
            workflow: 'dev',
            scale: 'large',
        });

        expect(result.replaced).toBe(true);

        const content = await readFile(result.filePath, 'utf-8');
        expect(content).toContain('large');
        // Should only have one harmonia block
        const startCount = content.split(HARMONIA_MARKER_START).length - 1;
        expect(startCount).toBe(1);
    });

    it('should create CLAUDE.md for claude-code agent type', async () => {
        const result = await injectPrompt(tempDir, 'claude-code', {
            projectName: 'test-proj',
            projectDir: tempDir,
            workflow: 'dev',
            scale: 'small',
        });

        expect(result.filePath).toBe(join(tempDir, 'CLAUDE.md'));
        expect(result.created).toBe(true);
    });

    // ─── removePrompt ───

    it('should remove harmonia block from config file', async () => {
        const preamble = '# My Project\n\nSome instructions.\n';
        await writeFile(join(tempDir, 'AGENTS.md'), preamble, 'utf-8');

        await injectPrompt(tempDir, 'opencode', {
            projectName: 'test-proj',
            projectDir: tempDir,
            workflow: 'dev',
            scale: 'small',
        });

        const removed = await removePrompt(tempDir, 'opencode');
        expect(removed).toBe(true);

        const content = await readFile(join(tempDir, 'AGENTS.md'), 'utf-8');
        expect(content).not.toContain(HARMONIA_MARKER_START);
        expect(content).toContain('# My Project');
    });

    it('should return false when no harmonia block to remove', async () => {
        await writeFile(join(tempDir, 'AGENTS.md'), '# Plain file\n', 'utf-8');
        const removed = await removePrompt(tempDir, 'opencode');
        expect(removed).toBe(false);
    });

    it('should return false when config file does not exist', async () => {
        const removed = await removePrompt(tempDir, 'opencode');
        expect(removed).toBe(false);
    });

    // ─── generateOpenCodePrompt ───

    it('should generate prompt with all required sections', () => {
        const prompt = generateOpenCodePrompt({
            projectName: 'my-app',
            projectDir: '/home/user/my-app',
            workflow: 'dev',
            scale: 'medium',
        });

        expect(prompt).toContain(HARMONIA_MARKER_START);
        expect(prompt).toContain(HARMONIA_MARKER_END);
        expect(prompt).toContain('my-app');
        expect(prompt).toContain('/home/user/my-app');
        expect(prompt).toContain('dev');
        expect(prompt).toContain('medium');
        expect(prompt).toContain('dispatch_role');
        expect(prompt).toContain('get_project_status');
        expect(prompt).toContain('write_doc');
        expect(prompt).toContain('approve_doc');
    });
});
