/**
 * Tests for PromptBuilder module (Phase 1.7).
 *
 * Tests pure utility functions directly, and the full buildPrompt()
 * flow with a real workflow plugin fixture on temp filesystem.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    getFormatExtension,
    findDispatchableNodes,
    resolveInputReference,
    buildPrompt,
} from '../src/core/prompt-builder.js';
import type { InputReference, PromptBuildOptions } from '../src/core/prompt-builder.js';
import { writeArtifact } from '../src/core/artifacts.js';
import type { ArtifactIOContext } from '../src/core/artifacts.js';
import { initNodeStates } from '../src/core/workflow-engine.js';
import type {
    WorkflowPlugin,
    WorkflowDefinition,
    WorkflowState,
    TaskNode,
    SequenceNode,
    RoleDefinition,
    ArtifactDefinition,
} from '../src/core/types.js';

// ─── Helpers ───

function makeTask(id: string, role = 'developer', inputArtifacts?: string[]): TaskNode {
    return { type: 'task', id, role, inputArtifacts };
}

function makeSequence(id: string, children: TaskNode[]): SequenceNode {
    return { type: 'sequence', id, children };
}

function makeDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
    return {
        name: 'test-wf',
        description: 'Test workflow',
        coordinator: 'coordinator',
        root: makeSequence('main', [makeTask('task-1')]),
        ...overrides,
    };
}

function makeRole(
    id: string,
    prompt = 'You are a test role.',
    capabilities: Array<{ id: string; description: string; artifact?: string }> = [],
): RoleDefinition {
    return {
        id,
        frontmatter: {
            session: 'none',
            parallel: false,
            capabilities,
        },
        prompt,
    };
}

function makeWorkflowPlugin(overrides: Partial<WorkflowPlugin> = {}): WorkflowPlugin {
    const def = overrides.definition ?? makeDefinition();
    return {
        name: 'test-wf',
        definition: def,
        roles: {
            developer: makeRole('developer', 'You are a developer.', [
                { id: 'write-code', description: 'Write code', artifact: 'code' },
            ]),
            architect: makeRole('architect', 'You are an architect.', [
                { id: 'write-prd', description: 'Write PRD', artifact: 'prd' },
            ]),
        },
        artifactSchemas: {},
        artifactDefinitions: {
            prd: { name: 'Product Requirements', format: 'md' },
            code: { name: 'Source Code', unmanaged: true, output: 'project' },
        },
        pluginDir: '/tmp/test-wf',
        ...overrides,
    };
}

function makeState(definition: WorkflowDefinition): WorkflowState {
    return {
        projectName: 'test-project',
        projectDir: '/test',
        workflow: 'test-wf',
        type: 'iteration',
        iteration: 1,
        activeNodeId: null,
        nodes: initNodeStates(definition),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

// ─── Tests ───

describe('prompt-builder', () => {
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

    // ─── findDispatchableNodes ───

    describe('findDispatchableNodes', () => {
        it('should find active nodes for a given role', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('t1', 'developer'),
                    makeTask('t2', 'architect'),
                    makeTask('t3', 'developer'),
                ]),
            });
            const wf = makeWorkflowPlugin({ definition: def });
            const state = makeState(def);
            // Mark t1 active, t3 pending
            state.nodes['t1'].status = 'active';

            const nodes = findDispatchableNodes(wf, state, 'developer');

            // t1 is active, t3 is pending — both match
            expect(nodes.length).toBeGreaterThanOrEqual(1);
            const ids = nodes.map((n) => n.id);
            expect(ids).toContain('t1');
        });

        it('should not include completed nodes', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1', 'developer')]),
            });
            const wf = makeWorkflowPlugin({ definition: def });
            const state = makeState(def);
            state.nodes['t1'].status = 'completed';

            const nodes = findDispatchableNodes(wf, state, 'developer');
            expect(nodes).toEqual([]);
        });

        it('should return empty array for unknown role', () => {
            const def = makeDefinition();
            const wf = makeWorkflowPlugin({ definition: def });
            const state = makeState(def);

            const nodes = findDispatchableNodes(wf, state, 'nonexistent');
            expect(nodes).toEqual([]);
        });
    });

    // ─── resolveInputReference ───

    describe('resolveInputReference', () => {
        it('should resolve a managed artifact reference', () => {
            const wf = makeWorkflowPlugin();
            const ioCtx: ArtifactIOContext = {
                contextDir: '/data/test-project/iter-1',
                projectDir: '/data/test-project',
                contextLabel: 'iter-1',
            };
            const existing = new Set(['prd']);

            const ref = resolveInputReference('prd', wf, ioCtx, existing);

            expect(ref.id).toBe('prd');
            expect(ref.name).toBe('Product Requirements');
            expect(ref.found).toBe(true);
            expect(ref.path).toContain('prd.md');
        });

        it('should resolve an unmanaged artifact reference', () => {
            const wf = makeWorkflowPlugin();
            const ioCtx: ArtifactIOContext = {
                contextDir: '/data/test-project/iter-1',
                projectDir: '/data/test-project',
                contextLabel: 'iter-1',
            };
            const existing = new Set(['code']);

            const ref = resolveInputReference('code', wf, ioCtx, existing);

            expect(ref.id).toBe('code');
            expect(ref.found).toBe(true);
            // Unmanaged artifacts resolve to directory
            expect(ref.path).not.toContain('.md');
        });

        it('should return not-found for unknown artifact', () => {
            const wf = makeWorkflowPlugin();
            const ioCtx: ArtifactIOContext = {
                contextDir: '/data/test-project/iter-1',
                projectDir: '/data/test-project',
                contextLabel: 'iter-1',
            };
            const existing = new Set<string>();

            const ref = resolveInputReference('unknown', wf, ioCtx, existing);

            expect(ref.found).toBe(false);
            expect(ref.name).toBe('unknown');
        });

        it('should return not-found when artifact not in existing set', () => {
            const wf = makeWorkflowPlugin();
            const ioCtx: ArtifactIOContext = {
                contextDir: '/data/test-project/iter-1',
                projectDir: '/data/test-project',
                contextLabel: 'iter-1',
            };
            const existing = new Set<string>(); // prd not in set

            const ref = resolveInputReference('prd', wf, ioCtx, existing);

            expect(ref.found).toBe(false);
            expect(ref.name).toBe('Product Requirements');
        });
    });

    // ─── buildPrompt ───

    describe('buildPrompt', () => {
        let harmoniaHome: string;
        let iterDir: string;
        let ioCtx: ArtifactIOContext;
        let workflowsDir: string;
        let originalDataDir: string | undefined;

        beforeEach(async () => {
            harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-pb-'));
            iterDir = join(harmoniaHome, 'test-project', 'iter-1');
            await mkdir(join(iterDir, 'artifacts'), { recursive: true });
            ioCtx = {
                contextDir: iterDir,
                projectDir: join(harmoniaHome, 'test-project'),
                contextLabel: 'iter-1',
            };

            // Create workflow dir with workflow.json
            workflowsDir = join(harmoniaHome, 'workflows');
            await mkdir(join(workflowsDir, 'test-wf', 'roles'), { recursive: true });
            await writeFile(
                join(workflowsDir, 'test-wf', 'workflow.json'),
                JSON.stringify({
                    name: 'test-wf',
                    description: 'test',
                    coordinator: 'coordinator',
                    root: { type: 'task', id: 't', role: 'r' },
                }),
                'utf-8',
            );

            // Set HARMONIA_DATA_DIR so getMergedOverrides can find project data
            originalDataDir = process.env.HARMONIA_DATA_DIR;
            process.env.HARMONIA_DATA_DIR = harmoniaHome;
        });

        afterEach(async () => {
            if (originalDataDir === undefined) {
                delete process.env.HARMONIA_DATA_DIR;
            } else {
                process.env.HARMONIA_DATA_DIR = originalDataDir;
            }
            await rm(harmoniaHome, { recursive: true, force: true });
        });

        it('should build a prompt with role system prompt and task brief', async () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1', 'developer')]),
            });
            const wf = makeWorkflowPlugin({ definition: def });
            const state = makeState(def);

            const result = await buildPrompt({
                projectName: 'test-project',
                role: 'developer',
                taskBrief: 'Implement the login page',
                targetNode: makeTask('t1', 'developer'),
                wf,
                state,
                ioCtx,
                workflowsDir,
            });

            expect(result.prompt).toContain('You are a developer.');
            expect(result.prompt).toContain('Implement the login page');
            expect(result.prompt).toContain('## Task');
            expect(result.prompt).toContain('## Project Context');
            expect(result.prompt).toContain('test-project');
        });

        it('should include input artifact content when available', async () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1', 'developer', ['prd'])]),
            });
            const wf = makeWorkflowPlugin({ definition: def });
            const state = makeState(def);

            // Write a PRD artifact
            await writeArtifact('prd', '# PRD\n\nBuild a login system.', ioCtx);

            const result = await buildPrompt({
                projectName: 'test-project',
                role: 'developer',
                taskBrief: 'Implement login',
                targetNode: makeTask('t1', 'developer', ['prd']),
                wf,
                state,
                ioCtx,
                workflowsDir,
            });

            expect(result.prompt).toContain('Build a login system');
            expect(result.inputRefs.length).toBeGreaterThan(0);
            const prdRef = result.inputRefs.find((r) => r.id === 'prd');
            expect(prdRef).toBeDefined();
            expect(prdRef!.found).toBe(true);
        });

        it('should include output artifact paths for role capabilities', async () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1', 'developer')]),
            });
            const wf = makeWorkflowPlugin({ definition: def });
            const state = makeState(def);

            const result = await buildPrompt({
                projectName: 'test-project',
                role: 'developer',
                taskBrief: 'Write code',
                targetNode: makeTask('t1', 'developer'),
                wf,
                state,
                ioCtx,
                workflowsDir,
            });

            // developer role has 'code' capability (unmanaged)
            expect(result.outputArtifacts).toHaveLength(1);
            expect(result.outputArtifacts[0].name).toBe('Source Code');
        });

        it('should throw when role does not exist', async () => {
            const wf = makeWorkflowPlugin();
            const state = makeState(wf.definition);

            await expect(
                buildPrompt({
                    projectName: 'test-project',
                    role: 'nonexistent',
                    taskBrief: 'Do something',
                    targetNode: makeTask('t1', 'nonexistent'),
                    wf,
                    state,
                    ioCtx,
                    workflowsDir,
                }),
            ).rejects.toThrow('Role "nonexistent" not found');
        });

        it('should merge additional input artifact IDs', async () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1', 'developer', ['prd'])]),
            });
            const wf = makeWorkflowPlugin({ definition: def });
            const state = makeState(def);

            await writeArtifact('prd', '# PRD content', ioCtx);

            const result = await buildPrompt({
                projectName: 'test-project',
                role: 'developer',
                taskBrief: 'Do task',
                targetNode: makeTask('t1', 'developer', ['prd']),
                wf,
                state,
                ioCtx,
                workflowsDir,
                additionalInputIds: ['prd'], // duplicate — should be deduplicated
            });

            // Should not have duplicate input refs
            const prdRefs = result.inputRefs.filter((r) => r.id === 'prd');
            expect(prdRefs).toHaveLength(1);
        });

        it('should indicate missing input artifacts', async () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1', 'developer', ['prd'])]),
            });
            const wf = makeWorkflowPlugin({ definition: def });
            const state = makeState(def);
            // Don't write the prd artifact

            const result = await buildPrompt({
                projectName: 'test-project',
                role: 'developer',
                taskBrief: 'Do task',
                targetNode: makeTask('t1', 'developer', ['prd']),
                wf,
                state,
                ioCtx,
                workflowsDir,
            });

            const prdRef = result.inputRefs.find((r) => r.id === 'prd');
            expect(prdRef).toBeDefined();
            expect(prdRef!.found).toBe(false);
            expect(result.prompt).toContain('Missing');
        });

        it('should resolve model and agent from role frontmatter', async () => {
            const wf = makeWorkflowPlugin({
                roles: {
                    developer: {
                        id: 'developer',
                        frontmatter: {
                            session: 'none',
                            parallel: false,
                            model: 'gpt-4',
                            agent: 'opencode',
                            capabilities: [],
                        },
                        prompt: 'You are a developer.',
                    },
                },
            });
            const state = makeState(wf.definition);

            const result = await buildPrompt({
                projectName: 'test-project',
                role: 'developer',
                taskBrief: 'Code it',
                targetNode: makeTask('t1', 'developer'),
                wf,
                state,
                ioCtx,
                workflowsDir,
            });

            expect(result.model).toBe('gpt-4');
            expect(result.agent).toBe('opencode');
        });
    });
});
