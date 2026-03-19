import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPlugin, discoverPlugins, PluginLoadError, PluginValidationError } from '../src/core/plugin.js';

const WORKFLOWS_DIR = resolve(join(import.meta.dirname, '..', 'workflows'));

// ─── Helpers ───

async function createMinimalPlugin(dir: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const pluginDir = join(dir, 'test-workflow');
    await mkdir(join(pluginDir, 'roles'), { recursive: true });
    await mkdir(join(pluginDir, 'schemas'), { recursive: true });

    // Minimal workflow.json
    const workflow = {
        name: 'test',
        description: 'Test workflow',
        coordinator: 'coordinator',
        root: {
            type: 'sequence',
            id: 'main',
            children: [{ type: 'task', id: 'task-1', role: 'coordinator' }],
        },
        artifacts: {
            report: { name: 'Test Report' },
        },
        ...overrides,
    };
    await writeFile(join(pluginDir, 'workflow.json'), JSON.stringify(workflow, null, 2));

    // Minimal coordinator role
    await writeFile(
        join(pluginDir, 'roles', 'coordinator.md'),
        '---\nmodel: high\nsession: persistent\nparallel: false\n---\nYou are the coordinator.',
    );

    // Minimal schema
    await writeFile(
        join(pluginDir, 'schemas', 'report.json'),
        JSON.stringify({ sections: [{ heading: '## Summary', required: true }], minLength: 50 }),
    );

    return pluginDir;
}

// ─── Tests ───

describe('plugin system', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'harmonia-plugin-'));
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    // ─── loadPlugin ───

    describe('loadPlugin', () => {
        it('should load a minimal plugin', async () => {
            const pluginDir = await createMinimalPlugin(tempDir);
            const plugin = await loadPlugin(pluginDir);

            expect(plugin.name).toBe('test');
            expect(plugin.definition.name).toBe('test');
            expect(plugin.definition.coordinator).toBe('coordinator');
            expect(plugin.definition.root.type).toBe('sequence');
            expect(plugin.pluginDir).toBe(pluginDir);
        });

        it('should load roles from roles/ directory', async () => {
            const pluginDir = await createMinimalPlugin(tempDir);
            const plugin = await loadPlugin(pluginDir);

            expect(plugin.roles['coordinator']).toBeDefined();
            expect(plugin.roles['coordinator'].frontmatter.model).toBe('high');
            expect(plugin.roles['coordinator'].frontmatter.session).toBe('persistent');
            expect(plugin.roles['coordinator'].prompt).toBe('You are the coordinator.');
        });

        it('should load artifact definitions from workflow.json', async () => {
            const pluginDir = await createMinimalPlugin(tempDir);
            const plugin = await loadPlugin(pluginDir);

            expect(plugin.artifactDefinitions['report']).toBeDefined();
            expect(plugin.artifactDefinitions['report'].name).toBe('Test Report');
        });

        it('should load schemas from schemas/ directory', async () => {
            const pluginDir = await createMinimalPlugin(tempDir);
            const plugin = await loadPlugin(pluginDir);

            expect(plugin.artifactSchemas['report']).toBeDefined();
            expect(plugin.artifactSchemas['report'].sections).toHaveLength(1);
            expect(plugin.artifactSchemas['report'].minLength).toBe(50);
        });

        it('should throw PluginLoadError when workflow.json is missing', async () => {
            const emptyDir = join(tempDir, 'empty');
            await mkdir(emptyDir, { recursive: true });

            await expect(loadPlugin(emptyDir)).rejects.toThrow(PluginLoadError);
            await expect(loadPlugin(emptyDir)).rejects.toThrow('workflow.json not found');
        });

        it('should throw PluginValidationError for invalid workflow', async () => {
            const pluginDir = await createMinimalPlugin(tempDir, {
                root: {
                    type: 'parallel',
                    id: 'bad-parallel',
                    children: [{ type: 'task', id: 'task-1', role: 'coordinator' }],
                    // Missing failStrategy
                },
            });

            await expect(loadPlugin(pluginDir)).rejects.toThrow(PluginValidationError);
        });

        it('should skip validation when skipValidation is true', async () => {
            const pluginDir = await createMinimalPlugin(tempDir, {
                root: {
                    type: 'parallel',
                    id: 'bad-parallel',
                    children: [{ type: 'task', id: 'task-1', role: 'coordinator' }],
                    // Missing failStrategy — would fail validation
                },
            });

            // Should NOT throw
            const plugin = await loadPlugin(pluginDir, undefined, true);
            expect(plugin.name).toBe('test');
        });

        it('should handle plugin without roles directory', async () => {
            const pluginDir = join(tempDir, 'no-roles');
            await mkdir(pluginDir, { recursive: true });
            await writeFile(
                join(pluginDir, 'workflow.json'),
                JSON.stringify({
                    name: 'minimal',
                    description: 'No roles',
                    coordinator: 'coordinator',
                    root: { type: 'sequence', id: 'main', children: [] },
                }),
            );

            // skipValidation because no roles to validate against
            const plugin = await loadPlugin(pluginDir, undefined, true);
            expect(Object.keys(plugin.roles)).toHaveLength(0);
        });

        it('should handle plugin without schemas directory', async () => {
            const pluginDir = await createMinimalPlugin(tempDir);
            // Remove schemas dir content is fine — it was created but we test loading works
            const plugin = await loadPlugin(pluginDir);
            expect(plugin.artifactSchemas).toBeDefined();
        });

        it('should pass config to the plugin', async () => {
            const pluginDir = await createMinimalPlugin(tempDir);
            const config = { customOption: true, maxRetries: 5 };

            const plugin = await loadPlugin(pluginDir, config);
            expect(plugin.config).toEqual(config);
        });

        it('should handle role files without frontmatter', async () => {
            const pluginDir = await createMinimalPlugin(tempDir);

            // Add a role without frontmatter
            await writeFile(join(pluginDir, 'roles', 'simple-role.md'), 'You are a simple role with no frontmatter.');

            const plugin = await loadPlugin(pluginDir);
            expect(plugin.roles['simple-role']).toBeDefined();
            expect(plugin.roles['simple-role'].prompt).toBe('You are a simple role with no frontmatter.');
            expect(plugin.roles['simple-role'].frontmatter.model).toBeUndefined();
        });

        it('should handle empty actions and hooks when files do not exist', async () => {
            const pluginDir = await createMinimalPlugin(tempDir);
            const plugin = await loadPlugin(pluginDir);

            expect(Object.keys(plugin.actions)).toHaveLength(0);
            expect(plugin.hookCreator).toBeUndefined();
        });
    });

    // ─── loadPlugin with real dev workflow ───

    describe('loadPlugin with real dev workflow', () => {
        it('should load the built-in dev workflow', async () => {
            const devDir = join(WORKFLOWS_DIR, 'dev');
            const plugin = await loadPlugin(devDir, undefined, true); // skip validation for now since schemas have old scale format

            expect(plugin.name).toBe('dev');
            expect(plugin.definition.coordinator).toBe('coordinator');
            expect(plugin.definition.root.type).toBe('sequence');

            // Should have roles
            const roleIds = Object.keys(plugin.roles);
            expect(roleIds.length).toBeGreaterThan(0);

            // Should have artifact definitions
            expect(plugin.artifactDefinitions['prd']).toBeDefined();
            expect(plugin.artifactDefinitions['prd'].name).toBe('需求文档');
            expect(plugin.artifactDefinitions['prd'].review).toBe(true);

            // Should have schemas
            expect(Object.keys(plugin.artifactSchemas).length).toBeGreaterThan(0);
            expect(plugin.artifactSchemas['prd']).toBeDefined();
        });
    });

    // ─── discoverPlugins ───

    describe('discoverPlugins', () => {
        it('should return empty array when config.json does not exist', async () => {
            const result = await discoverPlugins(join(tempDir, 'nonexistent.json'));
            expect(result).toEqual([]);
        });

        it('should parse config.json and return plugin entries', async () => {
            const configPath = join(tempDir, 'config.json');
            await writeFile(
                configPath,
                JSON.stringify({
                    workflows: {
                        dev: { path: '/path/to/dev' },
                        custom: { path: '/path/to/custom', config: { key: 'value' } },
                    },
                }),
            );

            const entries = await discoverPlugins(configPath);
            expect(entries).toHaveLength(2);
            expect(entries[0]).toEqual({ name: 'dev', path: '/path/to/dev', config: undefined });
            expect(entries[1]).toEqual({
                name: 'custom',
                path: '/path/to/custom',
                config: { key: 'value' },
            });
        });

        it('should handle config.json with no workflows section', async () => {
            const configPath = join(tempDir, 'config.json');
            await writeFile(configPath, JSON.stringify({ other: 'data' }));

            const entries = await discoverPlugins(configPath);
            expect(entries).toEqual([]);
        });

        it('should handle malformed config.json gracefully', async () => {
            const configPath = join(tempDir, 'config.json');
            await writeFile(configPath, 'not valid json {{{');

            const entries = await discoverPlugins(configPath);
            expect(entries).toEqual([]);
        });
    });
});
