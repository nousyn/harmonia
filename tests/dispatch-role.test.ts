import { describe, it, expect } from 'vitest';
import { getFormatExtension, resolveInputReference } from '../src/tools/dispatch-role.js';
import type { InputReference } from '../src/tools/dispatch-role.js';
import type { ArtifactIOContext } from '../src/core/artifacts.js';
import type { WorkflowPlugin, ArtifactDefinition, WorkflowDefinition, RoleDefinition } from '../src/core/types.js';

// ─── Helpers ───

function makeIOCtx(overrides: Partial<ArtifactIOContext> = {}): ArtifactIOContext {
    return {
        contextDir: '/data/my-app/iter-1',
        projectDir: '/projects/my-app',
        contextLabel: 'iter-1',
        ...overrides,
    };
}

function makePlugin(artifactDefs: Record<string, ArtifactDefinition> = {}): WorkflowPlugin {
    return {
        name: 'test',
        definition: {
            name: 'test',
            description: 'test',
            coordinator: 'coordinator',
            root: { type: 'sequence', id: 'main', children: [] },
        } as WorkflowDefinition,
        roles: {} as Record<string, RoleDefinition>,
        artifactSchemas: {},
        artifactDefinitions: artifactDefs,
        pluginDir: '/plugins/test',
    };
}

// ─── Tests ───

describe('dispatch-role helpers', () => {
    // ─── getFormatExtension ───

    describe('getFormatExtension', () => {
        it('should return .md for undefined format', () => {
            expect(getFormatExtension(undefined)).toBe('.md');
        });

        it('should return .md for md format', () => {
            expect(getFormatExtension('md')).toBe('.md');
        });

        it('should return .html for html format', () => {
            expect(getFormatExtension('html')).toBe('.html');
        });

        it('should return .json for json format', () => {
            expect(getFormatExtension('json')).toBe('.json');
        });
    });

    // ─── resolveInputReference ───

    describe('resolveInputReference', () => {
        it('should resolve managed md artifact to full file path', () => {
            const wf = makePlugin({
                prd: { name: 'PRD', format: 'md' },
            });
            const ioCtx = makeIOCtx();
            const existing = new Set(['prd']);

            const ref = resolveInputReference('prd', wf, ioCtx, existing);

            expect(ref.id).toBe('prd');
            expect(ref.name).toBe('PRD');
            expect(ref.path).toBe('/data/my-app/iter-1/artifacts/prd.md');
            expect(ref.found).toBe(true);
        });

        it('should resolve managed html artifact to full file path', () => {
            const wf = makePlugin({
                report: { name: 'Test Report', format: 'html' },
            });
            const ioCtx = makeIOCtx();
            const existing = new Set(['report']);

            const ref = resolveInputReference('report', wf, ioCtx, existing);

            expect(ref.path).toBe('/data/my-app/iter-1/artifacts/report.html');
            expect(ref.found).toBe(true);
        });

        it('should resolve managed json artifact to full file path', () => {
            const wf = makePlugin({
                config: { name: 'Config', format: 'json' },
            });
            const ioCtx = makeIOCtx();
            const existing = new Set(['config']);

            const ref = resolveInputReference('config', wf, ioCtx, existing);

            expect(ref.path).toBe('/data/my-app/iter-1/artifacts/config.json');
            expect(ref.found).toBe(true);
        });

        it('should resolve managed artifact with undefined format as .md', () => {
            const wf = makePlugin({
                notes: { name: 'Notes' },
            });
            const ioCtx = makeIOCtx();
            const existing = new Set(['notes']);

            const ref = resolveInputReference('notes', wf, ioCtx, existing);

            expect(ref.path).toBe('/data/my-app/iter-1/artifacts/notes.md');
            expect(ref.found).toBe(true);
        });

        it('should mark managed artifact as not found when not in existing set', () => {
            const wf = makePlugin({
                prd: { name: 'PRD', format: 'md' },
            });
            const ioCtx = makeIOCtx();
            const existing = new Set<string>(); // empty — nothing exists

            const ref = resolveInputReference('prd', wf, ioCtx, existing);

            expect(ref.path).toBe('/data/my-app/iter-1/artifacts/prd.md');
            expect(ref.found).toBe(false);
        });

        it('should resolve unmanaged artifact to directory path', () => {
            const wf = makePlugin({
                code: { name: 'Code', unmanaged: true, output: '{project}' },
            });
            const ioCtx = makeIOCtx();
            const existing = new Set<string>();

            const ref = resolveInputReference('code', wf, ioCtx, existing);

            expect(ref.id).toBe('code');
            expect(ref.name).toBe('Code');
            expect(ref.path).toBe('/projects/my-app');
            expect(ref.found).toBe(true); // unmanaged always "found"
        });

        it('should resolve unmanaged artifact with default output to artifacts dir', () => {
            const wf = makePlugin({
                code: { name: 'Code', unmanaged: true },
            });
            const ioCtx = makeIOCtx();
            const existing = new Set<string>();

            const ref = resolveInputReference('code', wf, ioCtx, existing);

            expect(ref.path).toBe('/data/my-app/iter-1/artifacts');
            expect(ref.found).toBe(true);
        });

        it('should return not-found for unknown artifact ID', () => {
            const wf = makePlugin({
                prd: { name: 'PRD', format: 'md' },
            });
            const ioCtx = makeIOCtx();
            const existing = new Set(['prd']);

            const ref = resolveInputReference('nonexistent', wf, ioCtx, existing);

            expect(ref.id).toBe('nonexistent');
            expect(ref.name).toBe('nonexistent'); // falls back to ID as name
            expect(ref.path).toBe('');
            expect(ref.found).toBe(false);
        });

        it('should resolve artifact with custom output template', () => {
            const wf = makePlugin({
                spec: { name: 'Spec', format: 'md', output: '{global}/reports' },
            });
            const ioCtx = makeIOCtx();
            const existing = new Set(['spec']);

            const ref = resolveInputReference('spec', wf, ioCtx, existing);

            expect(ref.path).toBe('/data/my-app/iter-1/artifacts/reports/spec.md');
            expect(ref.found).toBe(true);
        });

        it('should resolve artifact with {project}/{context} output template', () => {
            const wf = makePlugin({
                log: { name: 'Log', format: 'json', output: '{project}/{context}' },
            });
            const ioCtx = makeIOCtx();
            const existing = new Set(['log']);

            const ref = resolveInputReference('log', wf, ioCtx, existing);

            expect(ref.path).toBe('/projects/my-app/iter-1/log.json');
            expect(ref.found).toBe(true);
        });
    });
});
