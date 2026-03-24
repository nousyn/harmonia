import { describe, it, expect } from 'vitest';
import { getFormatExtension, resolveInputReference, findDispatchableNodes } from '../src/core/prompt-builder.js';
import type { InputReference } from '../src/core/prompt-builder.js';
import type { ArtifactIOContext } from '../src/core/artifacts.js';
import type {
    WorkflowPlugin,
    WorkflowDefinition,
    RoleDefinition,
    ArtifactDefinition,
    TaskNode,
    SequenceNode,
    WorkflowState,
} from '../src/core/types.js';
import { initNodeStates } from '../src/core/workflow-engine.js';

// ─── Helpers ───

function makeIOCtx(overrides: Partial<ArtifactIOContext> = {}): ArtifactIOContext {
    return {
        contextDir: '/data/my-app/iter-1',
        projectDir: '/projects/my-app',
        contextLabel: 'iter-1',
        ...overrides,
    };
}

function makePlugin(
    artifactDefs: Record<string, ArtifactDefinition> = {},
    roles: Record<string, RoleDefinition> = {},
    definition?: WorkflowDefinition,
): WorkflowPlugin {
    return {
        name: 'test',
        definition:
            definition ??
            ({
                name: 'test',
                description: 'test',
                coordinator: 'coordinator',
                root: { type: 'sequence', id: 'main', children: [] },
            } as WorkflowDefinition),
        roles,
        artifactSchemas: {},
        artifactDefinitions: artifactDefs,
        pluginDir: '/plugins/test',
    };
}

function makeTask(id: string, role = 'developer'): TaskNode {
    return { type: 'task', id, role };
}

// ─── Tests ───

describe('prompt-builder (Phase 1.7)', () => {
    // ─── getFormatExtension ───

    describe('getFormatExtension', () => {
        it('should return .md for undefined format', () => {
            expect(getFormatExtension()).toBe('.md');
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
        it('should return not-found for unknown artifact', () => {
            const wf = makePlugin();
            const ioCtx = makeIOCtx();
            const ref = resolveInputReference('unknown', wf, ioCtx, new Set());

            expect(ref.found).toBe(false);
            expect(ref.id).toBe('unknown');
            expect(ref.name).toBe('unknown');
            expect(ref.path).toBe('');
        });

        it('should resolve managed artifact with existing file', () => {
            const wf = makePlugin({
                prd: { name: 'Product Requirements' },
            });
            const ioCtx = makeIOCtx();
            const ref = resolveInputReference('prd', wf, ioCtx, new Set(['prd']));

            expect(ref.found).toBe(true);
            expect(ref.id).toBe('prd');
            expect(ref.name).toBe('Product Requirements');
            expect(ref.path).toContain('/artifacts/prd.md');
        });

        it('should resolve managed artifact as not found when not in set', () => {
            const wf = makePlugin({
                prd: { name: 'Product Requirements' },
            });
            const ioCtx = makeIOCtx();
            const ref = resolveInputReference('prd', wf, ioCtx, new Set());

            expect(ref.found).toBe(false);
            expect(ref.name).toBe('Product Requirements');
        });

        it('should respect html format for managed artifact', () => {
            const wf = makePlugin({
                report: { name: 'Report', format: 'html' },
            });
            const ioCtx = makeIOCtx();
            const ref = resolveInputReference('report', wf, ioCtx, new Set(['report']));

            expect(ref.found).toBe(true);
            expect(ref.path).toContain('report.html');
        });

        it('should respect json format for managed artifact', () => {
            const wf = makePlugin({
                config: { name: 'Config', format: 'json' },
            });
            const ioCtx = makeIOCtx();
            const ref = resolveInputReference('config', wf, ioCtx, new Set(['config']));

            expect(ref.found).toBe(true);
            expect(ref.path).toContain('config.json');
        });

        it('should resolve unmanaged artifact to directory', () => {
            const wf = makePlugin({
                codebase: { name: 'Source Code', unmanaged: true, output: '{project}/src' },
            });
            const ioCtx = makeIOCtx();
            const ref = resolveInputReference('codebase', wf, ioCtx, new Set());

            expect(ref.found).toBe(true); // unmanaged always "found"
            expect(ref.path).toBe('/projects/my-app/src');
        });

        it('should resolve artifact with custom output template', () => {
            const wf = makePlugin({
                report: { name: 'Report', output: '{global}/reports' },
            });
            const ioCtx = makeIOCtx();
            const ref = resolveInputReference('report', wf, ioCtx, new Set(['report']));

            expect(ref.path).toContain('/artifacts/reports/report.md');
        });
    });

    // ─── findDispatchableNodes ───

    describe('findDispatchableNodes', () => {
        it('should return empty when no nodes match role', () => {
            const def: WorkflowDefinition = {
                name: 'test',
                description: 'test',
                coordinator: 'coordinator',
                root: {
                    type: 'sequence',
                    id: 'main',
                    children: [makeTask('t1', 'developer')],
                } as SequenceNode,
            };
            const wf = makePlugin({}, {}, def);
            const state: WorkflowState = {
                projectName: 'test',
                projectDir: '/test',
                workflow: 'test',
                type: 'iteration',
                iteration: 1,
                activeNodeId: null,
                nodes: initNodeStates(def),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };

            const nodes = findDispatchableNodes(wf, state, 'architect');
            expect(nodes).toEqual([]);
        });

        it('should find active/pending nodes for a given role', () => {
            const t1 = makeTask('t1', 'developer');
            const t2 = makeTask('t2', 'developer');
            const def: WorkflowDefinition = {
                name: 'test',
                description: 'test',
                coordinator: 'coordinator',
                root: {
                    type: 'sequence',
                    id: 'main',
                    children: [t1, t2],
                } as SequenceNode,
            };
            const wf = makePlugin({}, {}, def);
            const nodes = initNodeStates(def);
            nodes['t1'].status = 'active';
            const state: WorkflowState = {
                projectName: 'test',
                projectDir: '/test',
                workflow: 'test',
                type: 'iteration',
                iteration: 1,
                activeNodeId: 't1',
                nodes,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };

            const dispatchable = findDispatchableNodes(wf, state, 'developer');
            expect(dispatchable.length).toBe(2); // t1 is active, t2 is pending
        });

        it('should not include completed nodes', () => {
            const t1 = makeTask('t1', 'developer');
            const def: WorkflowDefinition = {
                name: 'test',
                description: 'test',
                coordinator: 'coordinator',
                root: {
                    type: 'sequence',
                    id: 'main',
                    children: [t1],
                } as SequenceNode,
            };
            const wf = makePlugin({}, {}, def);
            const nodes = initNodeStates(def);
            nodes['t1'].status = 'completed';
            const state: WorkflowState = {
                projectName: 'test',
                projectDir: '/test',
                workflow: 'test',
                type: 'iteration',
                iteration: 1,
                activeNodeId: null,
                nodes,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };

            const dispatchable = findDispatchableNodes(wf, state, 'developer');
            expect(dispatchable).toEqual([]);
        });

        it('should include floating nodes', () => {
            const floating = makeTask('f1', 'reviewer');
            const def: WorkflowDefinition = {
                name: 'test',
                description: 'test',
                coordinator: 'coordinator',
                root: {
                    type: 'sequence',
                    id: 'main',
                    children: [makeTask('t1', 'developer')],
                } as SequenceNode,
                floatingNodes: [floating],
            };
            const wf = makePlugin({}, {}, def);
            const nodes = initNodeStates(def);
            const state: WorkflowState = {
                projectName: 'test',
                projectDir: '/test',
                workflow: 'test',
                type: 'iteration',
                iteration: 1,
                activeNodeId: null,
                nodes,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };

            const dispatchable = findDispatchableNodes(wf, state, 'reviewer');
            expect(dispatchable).toHaveLength(1);
            expect(dispatchable[0].id).toBe('f1');
        });
    });
});
