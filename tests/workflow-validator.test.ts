import { describe, it, expect } from 'vitest';
import { validateWorkflow } from '../src/core/workflow-validator.js';
import type {
    WorkflowDefinition,
    WorkflowNode,
    TaskNode,
    SequenceNode,
    ParallelNode,
    GateNode,
    LoopNode,
    GotoTarget,
    ValidationError,
    ArtifactDefinition,
} from '../src/core/types.js';

// ─── Helpers ───

function makeTask(id: string, role = 'developer'): TaskNode {
    return { type: 'task', id, role };
}

function makeSequence(id: string, children: WorkflowNode[]): SequenceNode {
    return { type: 'sequence', id, children };
}

function makeParallel(
    id: string,
    children: WorkflowNode[],
    failStrategy: 'fail-fast' | 'wait-all' = 'fail-fast',
): ParallelNode {
    return { type: 'parallel', id, failStrategy, children };
}

function makeGate(id: string, pass: WorkflowNode, fail: WorkflowNode | GotoTarget): GateNode {
    return {
        type: 'gate',
        id,
        conditions: [{ type: 'artifact_exists', artifact: 'test-artifact' }],
        pass,
        fail,
    };
}

function makeLoop(id: string, body: WorkflowNode, maxIterations = 10): LoopNode {
    return { type: 'loop', id, body, maxIterations };
}

function makeDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
    return {
        name: 'test',
        description: 'Test workflow',
        coordinator: 'coordinator',
        root: makeSequence('main', [makeTask('task-1', 'developer')]),
        ...overrides,
    };
}

const DEFAULT_ROLES = new Set(['coordinator', 'developer', 'architect', 'tester']);

// ─── Tests ───

describe('workflow-validator', () => {
    describe('valid definitions', () => {
        it('should pass for a minimal valid workflow', () => {
            const def = makeDefinition();
            const errors = validateWorkflow(def, DEFAULT_ROLES);
            expect(errors).toHaveLength(0);
        });

        it('should pass for the dev workflow structure', () => {
            // Mimics the actual dev workflow.json structure
            const def = makeDefinition({
                coordinator: 'coordinator',
                root: makeSequence('main', [
                    makeTask('clarify', 'coordinator'),
                    makeGate('prd-gate', makeTask('design', 'architect'), {
                        goto: 'clarify',
                        maxRetries: 5,
                        onExhausted: 'escalate',
                    }),
                    makeGate('design-gate', makeTask('develop', 'developer'), {
                        goto: 'design',
                        maxRetries: 3,
                        onExhausted: 'escalate',
                    }),
                    makeTask('test', 'tester'),
                    makeGate('test-gate', makeTask('deliver', 'coordinator'), {
                        goto: 'develop',
                        maxRetries: 3,
                        onExhausted: 'escalate',
                    }),
                ]),
                floatingNodes: [makeTask('escalate', 'coordinator')],
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            expect(errors).toHaveLength(0);
        });

        it('should pass with parallel nodes that have failStrategy', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeParallel('par', [makeTask('a', 'developer'), makeTask('b', 'developer')], 'wait-all'),
                ]),
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            expect(errors).toHaveLength(0);
        });

        it('should pass with task self-retry via onFailed', () => {
            const task: TaskNode = {
                type: 'task',
                id: 'retry-task',
                role: 'developer',
                onFailed: { goto: 'retry-task', maxRetries: 3, onExhausted: 'escalate' },
            };
            const def = makeDefinition({
                root: makeSequence('main', [task]),
                floatingNodes: [makeTask('escalate', 'coordinator')],
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            expect(errors).toHaveLength(0);
        });

        it('should pass with gate fail as inline node', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeGate('g1', makeTask('pass-task', 'developer'), makeTask('fail-task', 'developer')),
                ]),
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            expect(errors).toHaveLength(0);
        });
    });

    describe('duplicate IDs', () => {
        it('should detect duplicate IDs in tree', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('dup', 'developer'), makeTask('dup', 'developer')]),
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const dupErrors = errors.filter((e) => e.type === 'duplicate_id');
            expect(dupErrors).toHaveLength(1);
            expect(dupErrors[0].nodeId).toBe('dup');
        });

        it('should detect duplicate IDs between tree and floating nodes', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('shared-id', 'developer')]),
                floatingNodes: [makeTask('shared-id', 'coordinator')],
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const dupErrors = errors.filter((e) => e.type === 'duplicate_id');
            expect(dupErrors).toHaveLength(1);
            expect(dupErrors[0].nodeId).toBe('shared-id');
        });

        it('should detect duplicate IDs in nested structures', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeSequence('inner', [makeTask('deep', 'developer')]),
                    makeTask('deep', 'developer'),
                ]),
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const dupErrors = errors.filter((e) => e.type === 'duplicate_id');
            expect(dupErrors).toHaveLength(1);
            expect(dupErrors[0].nodeId).toBe('deep');
        });
    });

    describe('invalid goto targets', () => {
        it('should detect goto to non-existent node', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('t1', 'developer'),
                    makeGate('g1', makeTask('t2', 'developer'), {
                        goto: 'nonexistent',
                        maxRetries: 3,
                        onExhausted: 'escalate',
                    }),
                ]),
                floatingNodes: [makeTask('escalate', 'coordinator')],
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const gotoErrors = errors.filter((e) => e.type === 'invalid_goto');
            expect(gotoErrors).toHaveLength(1);
            expect(gotoErrors[0].message).toContain('nonexistent');
        });

        it('should detect goto to a node that is not an ancestor or preceding sibling', () => {
            // t2 tries to goto t3, but t3 is a following sibling (not preceding)
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('t1', 'developer'),
                    makeGate('g1', makeTask('t2', 'developer'), {
                        goto: 't3',
                    }),
                    makeTask('t3', 'developer'),
                ]),
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const gotoErrors = errors.filter((e) => e.type === 'invalid_goto');
            expect(gotoErrors.length).toBeGreaterThanOrEqual(1);
            expect(gotoErrors[0].message).toContain('t3');
        });

        it('should allow goto to preceding sibling', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('t1', 'developer'),
                    makeGate('g1', makeTask('t2', 'developer'), {
                        goto: 't1',
                        maxRetries: 3,
                        onExhausted: 'escalate',
                    }),
                ]),
                floatingNodes: [makeTask('escalate', 'coordinator')],
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const gotoErrors = errors.filter((e) => e.type === 'invalid_goto');
            expect(gotoErrors).toHaveLength(0);
        });

        it('should allow goto to ancestor node', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeGate('g1', makeTask('t1', 'developer'), {
                        goto: 'main',
                        maxRetries: 3,
                        onExhausted: 'escalate',
                    }),
                ]),
                floatingNodes: [makeTask('escalate', 'coordinator')],
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const gotoErrors = errors.filter((e) => e.type === 'invalid_goto');
            expect(gotoErrors).toHaveLength(0);
        });

        it('should reject non-task node goto to self', () => {
            // Gate node with onFailed goto self — only task nodes can self-retry
            const par: ParallelNode = {
                type: 'parallel',
                id: 'par',
                failStrategy: 'fail-fast',
                children: [makeTask('a', 'developer')],
                onFailed: { goto: 'par' },
            };
            const def = makeDefinition({
                root: makeSequence('main', [par]),
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const gotoErrors = errors.filter((e) => e.type === 'invalid_goto');
            expect(gotoErrors.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('cycle detection', () => {
        it('should detect exit-less goto cycles', () => {
            // t1 → g1 fail goto t1 (no maxRetries, no onExhausted)
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('t1', 'developer'),
                    makeGate('g1', makeTask('t2', 'developer'), {
                        goto: 't1',
                    }),
                ]),
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const cycleErrors = errors.filter((e) => e.type === 'cycle');
            expect(cycleErrors.length).toBeGreaterThanOrEqual(1);
        });

        it('should not flag cycles with maxRetries + onExhausted', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('t1', 'developer'),
                    makeGate('g1', makeTask('t2', 'developer'), {
                        goto: 't1',
                        maxRetries: 5,
                        onExhausted: 'escalate',
                    }),
                ]),
                floatingNodes: [makeTask('escalate', 'coordinator')],
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const cycleErrors = errors.filter((e) => e.type === 'cycle');
            expect(cycleErrors).toHaveLength(0);
        });

        it('should not flag cycle when maxRetries is set without onExhausted', () => {
            // maxRetries without onExhausted means the engine will bubbleFailure
            // when retries are exhausted — this is a valid exit path
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('t1', 'developer'),
                    makeGate('g1', makeTask('t2', 'developer'), {
                        goto: 't1',
                        maxRetries: 3,
                        // no onExhausted — engine will bubbleFailure
                    }),
                ]),
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const cycleErrors = errors.filter((e) => e.type === 'cycle');
            expect(cycleErrors).toHaveLength(0);
        });
    });

    describe('missing failStrategy', () => {
        it('should detect parallel node without failStrategy', () => {
            // Create a parallel node that's missing failStrategy
            // We need to cast to bypass TypeScript's type check
            const par = {
                type: 'parallel' as const,
                id: 'par',
                children: [makeTask('a', 'developer')],
            } as ParallelNode;

            const def = makeDefinition({
                root: makeSequence('main', [par]),
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const fsErrors = errors.filter((e) => e.type === 'missing_fail_strategy');
            expect(fsErrors).toHaveLength(1);
            expect(fsErrors[0].nodeId).toBe('par');
        });
    });

    describe('floating node references', () => {
        it('should detect onExhausted referencing non-existent floating node', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('t1', 'developer'),
                    makeGate('g1', makeTask('t2', 'developer'), {
                        goto: 't1',
                        maxRetries: 3,
                        onExhausted: 'nonexistent-float',
                    }),
                ]),
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const floatErrors = errors.filter((e) => e.type === 'invalid_floating_ref');
            expect(floatErrors).toHaveLength(1);
            expect(floatErrors[0].message).toContain('nonexistent-float');
        });

        it('should pass when onExhausted references valid floating node', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('t1', 'developer'),
                    makeGate('g1', makeTask('t2', 'developer'), {
                        goto: 't1',
                        maxRetries: 3,
                        onExhausted: 'fallback',
                    }),
                ]),
                floatingNodes: [makeTask('fallback', 'coordinator')],
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const floatErrors = errors.filter((e) => e.type === 'invalid_floating_ref');
            expect(floatErrors).toHaveLength(0);
        });
    });

    describe('role references', () => {
        it('should detect task referencing unknown role', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1', 'nonexistent-role')]),
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const roleErrors = errors.filter((e) => e.type === 'invalid_role_ref');
            expect(roleErrors).toHaveLength(1);
            expect(roleErrors[0].message).toContain('nonexistent-role');
        });

        it('should detect unknown role in floating nodes', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1', 'developer')]),
                floatingNodes: [makeTask('f1', 'ghost-role')],
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const roleErrors = errors.filter((e) => e.type === 'invalid_role_ref');
            expect(roleErrors).toHaveLength(1);
            expect(roleErrors[0].message).toContain('ghost-role');
        });

        it('should detect unknown role in gate pass branch', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeGate('g1', makeTask('pass-task', 'phantom'), makeTask('fail-task', 'developer')),
                ]),
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const roleErrors = errors.filter((e) => e.type === 'invalid_role_ref');
            expect(roleErrors).toHaveLength(1);
            expect(roleErrors[0].nodeId).toBe('pass-task');
        });
    });

    describe('coordinator check', () => {
        it('should detect invalid coordinator role', () => {
            const def = makeDefinition({ coordinator: 'nonexistent-coordinator' });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const coordErrors = errors.filter((e) => e.type === 'invalid_coordinator');
            expect(coordErrors).toHaveLength(1);
        });

        it('should pass with valid coordinator', () => {
            const def = makeDefinition({ coordinator: 'coordinator' });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const coordErrors = errors.filter((e) => e.type === 'invalid_coordinator');
            expect(coordErrors).toHaveLength(0);
        });
    });

    describe('multiple errors', () => {
        it('should report all errors found, not just the first', () => {
            const par = {
                type: 'parallel' as const,
                id: 'par',
                children: [makeTask('a', 'unknown-role-1'), makeTask('a', 'unknown-role-2')],
            } as ParallelNode;

            const def = makeDefinition({
                coordinator: 'missing-coordinator',
                root: makeSequence('main', [par]),
            });

            const errors = validateWorkflow(def, DEFAULT_ROLES);
            // Should have: duplicate_id, missing_fail_strategy, invalid_role_ref x2, invalid_coordinator
            expect(errors.length).toBeGreaterThanOrEqual(4);
        });
    });

    // ─── Artifact Definition Validation ───

    describe('artifact definition validation', () => {
        const outputErrors = (errors: ValidationError[]) => errors.filter((e) => e.type === 'invalid_artifact_output');

        it('should pass when no artifact definitions are provided', () => {
            const errors = validateWorkflow(makeDefinition(), DEFAULT_ROLES);
            expect(outputErrors(errors)).toHaveLength(0);
        });

        it('should pass when artifact definitions have no output field', () => {
            const defs: Record<string, ArtifactDefinition> = {
                spec: { name: 'Spec', format: 'md' },
                code: { name: 'Code', format: 'json', unmanaged: true },
            };
            const errors = validateWorkflow(makeDefinition(), DEFAULT_ROLES, defs);
            expect(outputErrors(errors)).toHaveLength(0);
        });

        it('should pass with valid {global} output', () => {
            const defs: Record<string, ArtifactDefinition> = {
                spec: { name: 'Spec', format: 'md', output: '{global}' },
            };
            const errors = validateWorkflow(makeDefinition(), DEFAULT_ROLES, defs);
            expect(outputErrors(errors)).toHaveLength(0);
        });

        it('should pass with valid {project} output', () => {
            const defs: Record<string, ArtifactDefinition> = {
                code: { name: 'Code', format: 'json', output: '{project}' },
            };
            const errors = validateWorkflow(makeDefinition(), DEFAULT_ROLES, defs);
            expect(outputErrors(errors)).toHaveLength(0);
        });

        it('should pass with {global}/{context} output', () => {
            const defs: Record<string, ArtifactDefinition> = {
                spec: { name: 'Spec', format: 'md', output: '{global}/{context}' },
            };
            const errors = validateWorkflow(makeDefinition(), DEFAULT_ROLES, defs);
            expect(outputErrors(errors)).toHaveLength(0);
        });

        it('should pass with {project}/{context} output', () => {
            const defs: Record<string, ArtifactDefinition> = {
                code: { name: 'Code', format: 'json', output: '{project}/{context}' },
            };
            const errors = validateWorkflow(makeDefinition(), DEFAULT_ROLES, defs);
            expect(outputErrors(errors)).toHaveLength(0);
        });

        it('should pass with {global}/subdir output', () => {
            const defs: Record<string, ArtifactDefinition> = {
                spec: { name: 'Spec', format: 'md', output: '{global}/reports' },
            };
            const errors = validateWorkflow(makeDefinition(), DEFAULT_ROLES, defs);
            expect(outputErrors(errors)).toHaveLength(0);
        });

        it('should reject output not starting with {global} or {project}', () => {
            const defs: Record<string, ArtifactDefinition> = {
                spec: { name: 'Spec', format: 'md', output: '{context}/artifacts' },
            };
            const errors = validateWorkflow(makeDefinition(), DEFAULT_ROLES, defs);
            const artErrors = outputErrors(errors);
            expect(artErrors).toHaveLength(1);
            expect(artErrors[0].message).toContain('must start with {global} or {project}');
        });

        it('should reject output starting with a bare path', () => {
            const defs: Record<string, ArtifactDefinition> = {
                spec: { name: 'Spec', format: 'md', output: '/tmp/output' },
            };
            const errors = validateWorkflow(makeDefinition(), DEFAULT_ROLES, defs);
            const artErrors = outputErrors(errors);
            expect(artErrors).toHaveLength(1);
            expect(artErrors[0].message).toContain('must start with {global} or {project}');
        });

        it('should reject output containing ".."', () => {
            const defs: Record<string, ArtifactDefinition> = {
                spec: { name: 'Spec', format: 'md', output: '{global}/../escape' },
            };
            const errors = validateWorkflow(makeDefinition(), DEFAULT_ROLES, defs);
            const artErrors = outputErrors(errors);
            expect(artErrors).toHaveLength(1);
            expect(artErrors[0].message).toContain('..');
        });

        it('should reject unknown placeholders', () => {
            const defs: Record<string, ArtifactDefinition> = {
                spec: { name: 'Spec', format: 'md', output: '{global}/{unknown}' },
            };
            const errors = validateWorkflow(makeDefinition(), DEFAULT_ROLES, defs);
            const artErrors = outputErrors(errors);
            expect(artErrors).toHaveLength(1);
            expect(artErrors[0].message).toContain('unknown placeholder');
            expect(artErrors[0].message).toContain('{unknown}');
        });

        it('should report errors for multiple invalid artifact definitions', () => {
            const defs: Record<string, ArtifactDefinition> = {
                bad1: { name: 'Bad1', format: 'md', output: 'no-prefix' },
                bad2: { name: 'Bad2', format: 'md', output: '{global}/../escape' },
            };
            const errors = validateWorkflow(makeDefinition(), DEFAULT_ROLES, defs);
            const artErrors = outputErrors(errors);
            expect(artErrors).toHaveLength(2);
        });

        it('should not flag valid definitions alongside invalid ones', () => {
            const defs: Record<string, ArtifactDefinition> = {
                good: { name: 'Good', format: 'md', output: '{global}/{context}' },
                bad: { name: 'Bad', format: 'md', output: '{wrong}/path' },
            };
            const errors = validateWorkflow(makeDefinition(), DEFAULT_ROLES, defs);
            const artErrors = outputErrors(errors);
            expect(artErrors).toHaveLength(1);
            expect(artErrors[0].message).toContain('bad');
        });
    });

    // ─── inputArtifacts Reference Validation ───

    describe('inputArtifacts reference validation', () => {
        const inputErrors = (errors: ValidationError[]) => errors.filter((e) => e.type === 'invalid_input_artifact');

        const sampleArtifacts: Record<string, ArtifactDefinition> = {
            prd: { name: 'PRD', format: 'md' },
            'user-stories': { name: 'User Stories', format: 'md' },
            code: { name: 'Code', unmanaged: true },
            'tech-design': { name: 'Tech Design', format: 'md' },
        };

        it('should pass when no inputArtifacts are declared', () => {
            const def = makeDefinition();
            const errors = validateWorkflow(def, DEFAULT_ROLES, sampleArtifacts);
            expect(inputErrors(errors)).toHaveLength(0);
        });

        it('should pass when inputArtifacts reference valid artifact IDs', () => {
            const task: TaskNode = {
                type: 'task',
                id: 'test-task',
                role: 'developer',
                inputArtifacts: ['prd', 'user-stories'],
            };
            const def = makeDefinition({
                root: makeSequence('main', [task]),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES, sampleArtifacts);
            expect(inputErrors(errors)).toHaveLength(0);
        });

        it('should pass when inputArtifacts reference unmanaged artifacts', () => {
            const task: TaskNode = {
                type: 'task',
                id: 'test-task',
                role: 'developer',
                inputArtifacts: ['code'],
            };
            const def = makeDefinition({
                root: makeSequence('main', [task]),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES, sampleArtifacts);
            expect(inputErrors(errors)).toHaveLength(0);
        });

        it('should detect inputArtifacts referencing non-existent artifact', () => {
            const task: TaskNode = {
                type: 'task',
                id: 'test-task',
                role: 'developer',
                inputArtifacts: ['prd', 'nonexistent-artifact'],
            };
            const def = makeDefinition({
                root: makeSequence('main', [task]),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES, sampleArtifacts);
            const artErrors = inputErrors(errors);
            expect(artErrors).toHaveLength(1);
            expect(artErrors[0].nodeId).toBe('test-task');
            expect(artErrors[0].message).toContain('nonexistent-artifact');
        });

        it('should detect multiple invalid inputArtifacts on one node', () => {
            const task: TaskNode = {
                type: 'task',
                id: 'test-task',
                role: 'developer',
                inputArtifacts: ['ghost-1', 'ghost-2'],
            };
            const def = makeDefinition({
                root: makeSequence('main', [task]),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES, sampleArtifacts);
            const artErrors = inputErrors(errors);
            expect(artErrors).toHaveLength(2);
            expect(artErrors[0].message).toContain('ghost-1');
            expect(artErrors[1].message).toContain('ghost-2');
        });

        it('should validate inputArtifacts in nested nodes (gate pass branch)', () => {
            const passTask: TaskNode = {
                type: 'task',
                id: 'nested-task',
                role: 'developer',
                inputArtifacts: ['nonexistent'],
            };
            const def = makeDefinition({
                root: makeSequence('main', [makeGate('g1', passTask, makeTask('fail-task', 'developer'))]),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES, sampleArtifacts);
            const artErrors = inputErrors(errors);
            expect(artErrors).toHaveLength(1);
            expect(artErrors[0].nodeId).toBe('nested-task');
        });

        it('should validate inputArtifacts in parallel children', () => {
            const taskA: TaskNode = {
                type: 'task',
                id: 'par-a',
                role: 'developer',
                inputArtifacts: ['prd'],
            };
            const taskB: TaskNode = {
                type: 'task',
                id: 'par-b',
                role: 'developer',
                inputArtifacts: ['missing-art'],
            };
            const def = makeDefinition({
                root: makeSequence('main', [makeParallel('par', [taskA, taskB])]),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES, sampleArtifacts);
            const artErrors = inputErrors(errors);
            expect(artErrors).toHaveLength(1);
            expect(artErrors[0].nodeId).toBe('par-b');
        });

        it('should validate inputArtifacts on floating nodes', () => {
            const floatingTask: TaskNode = {
                type: 'task',
                id: 'escalate',
                role: 'coordinator',
                inputArtifacts: ['nonexistent-float-art'],
            };
            const def = makeDefinition({
                root: makeSequence('main', [makeTask('t1', 'developer')]),
                floatingNodes: [floatingTask],
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES, sampleArtifacts);
            const artErrors = inputErrors(errors);
            expect(artErrors).toHaveLength(1);
            expect(artErrors[0].nodeId).toBe('escalate');
            expect(artErrors[0].message).toContain('nonexistent-float-art');
        });

        it('should pass when artifactDefinitions is empty and no inputArtifacts declared', () => {
            const def = makeDefinition();
            const errors = validateWorkflow(def, DEFAULT_ROLES, {});
            expect(inputErrors(errors)).toHaveLength(0);
        });

        it('should detect error when artifactDefinitions is empty but inputArtifacts declared', () => {
            const task: TaskNode = {
                type: 'task',
                id: 'test-task',
                role: 'developer',
                inputArtifacts: ['prd'],
            };
            const def = makeDefinition({
                root: makeSequence('main', [task]),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES, {});
            const artErrors = inputErrors(errors);
            expect(artErrors).toHaveLength(1);
            expect(artErrors[0].message).toContain('prd');
        });

        it('should not flag valid inputArtifacts alongside invalid ones', () => {
            const task: TaskNode = {
                type: 'task',
                id: 'test-task',
                role: 'developer',
                inputArtifacts: ['prd', 'nonexistent', 'user-stories'],
            };
            const def = makeDefinition({
                root: makeSequence('main', [task]),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES, sampleArtifacts);
            const artErrors = inputErrors(errors);
            expect(artErrors).toHaveLength(1);
            expect(artErrors[0].message).toContain('nonexistent');
        });
    });

    // ─── Loop validation ───

    describe('loop validation', () => {
        it('should pass for a valid loop node', () => {
            const def = makeDefinition({
                root: makeSequence('main', [makeLoop('my-loop', makeTask('work', 'developer'), 5)]),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES);
            expect(errors).toHaveLength(0);
        });

        it('should detect duplicate IDs within loop body', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('dup', 'developer'),
                    makeLoop('my-loop', makeTask('dup', 'developer'), 5),
                ]),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const dupErrors = errors.filter((e) => e.type === 'duplicate_id');
            expect(dupErrors).toHaveLength(1);
            expect(dupErrors[0].nodeId).toBe('dup');
        });

        it('should detect invalid maxIterations (zero)', () => {
            const def = makeDefinition({
                root: makeLoop('my-loop', makeTask('work', 'developer'), 0),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const otherErrors = errors.filter((e) => e.type === 'other' && e.nodeId === 'my-loop');
            expect(otherErrors).toHaveLength(1);
            expect(otherErrors[0].message).toContain('maxIterations');
        });

        it('should detect invalid maxIterations (negative)', () => {
            const def = makeDefinition({
                root: makeLoop('my-loop', makeTask('work', 'developer'), -1),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const otherErrors = errors.filter((e) => e.type === 'other' && e.nodeId === 'my-loop');
            expect(otherErrors).toHaveLength(1);
            expect(otherErrors[0].message).toContain('maxIterations');
        });

        it('should detect invalid maxIterations (non-integer)', () => {
            const def = makeDefinition({
                root: makeLoop('my-loop', makeTask('work', 'developer'), 3.5),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const otherErrors = errors.filter((e) => e.type === 'other' && e.nodeId === 'my-loop');
            expect(otherErrors).toHaveLength(1);
            expect(otherErrors[0].message).toContain('maxIterations');
        });

        it('should validate role references inside loop body', () => {
            const def = makeDefinition({
                root: makeLoop('my-loop', makeTask('work', 'ghost-role'), 5),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const roleErrors = errors.filter((e) => e.type === 'invalid_role_ref');
            expect(roleErrors).toHaveLength(1);
            expect(roleErrors[0].nodeId).toBe('work');
            expect(roleErrors[0].message).toContain('ghost-role');
        });

        it('should validate inputArtifacts inside loop body', () => {
            const sampleArtifacts: Record<string, ArtifactDefinition> = {
                prd: { name: 'PRD', format: 'md' },
            };
            const bodyTask: TaskNode = {
                type: 'task',
                id: 'work',
                role: 'developer',
                inputArtifacts: ['nonexistent-art'],
            };
            const def = makeDefinition({
                root: makeLoop('my-loop', bodyTask, 5),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES, sampleArtifacts);
            const artErrors = errors.filter((e) => e.type === 'invalid_input_artifact');
            expect(artErrors).toHaveLength(1);
            expect(artErrors[0].nodeId).toBe('work');
        });

        it('should validate goto targets inside loop body', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('setup', 'coordinator'),
                    makeLoop(
                        'my-loop',
                        makeGate('g1', makeTask('pass', 'developer'), {
                            goto: 'setup',
                            maxRetries: 3,
                            onExhausted: 'escalate',
                        }),
                        5,
                    ),
                ]),
                floatingNodes: [makeTask('escalate', 'coordinator')],
            });
            // goto to 'setup' which is a preceding sibling of the loop — should be valid
            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const gotoErrors = errors.filter((e) => e.type === 'invalid_goto');
            expect(gotoErrors).toHaveLength(0);
        });

        it('should detect invalid goto target inside loop body', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeLoop(
                        'my-loop',
                        makeGate('g1', makeTask('pass', 'developer'), {
                            goto: 'nonexistent',
                            maxRetries: 3,
                        }),
                        5,
                    ),
                    makeTask('after-loop', 'developer'),
                ]),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const gotoErrors = errors.filter((e) => e.type === 'invalid_goto');
            expect(gotoErrors).toHaveLength(1);
            expect(gotoErrors[0].message).toContain('nonexistent');
        });

        it('should validate loop onFailed goto target', () => {
            const loopNode: LoopNode = {
                ...makeLoop('my-loop', makeTask('work', 'developer'), 5),
                onFailed: { goto: 'nonexistent-target', maxRetries: 2 },
            };
            const def = makeDefinition({
                root: makeSequence('main', [loopNode]),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const gotoErrors = errors.filter((e) => e.type === 'invalid_goto');
            expect(gotoErrors).toHaveLength(1);
            expect(gotoErrors[0].message).toContain('nonexistent-target');
        });

        it('should validate nested loops', () => {
            const def = makeDefinition({
                root: makeLoop('outer-loop', makeLoop('inner-loop', makeTask('work', 'developer'), 3), 5),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES);
            expect(errors).toHaveLength(0);
        });

        it('should detect duplicate IDs in nested loops', () => {
            const def = makeDefinition({
                root: makeLoop(
                    'outer-loop',
                    makeLoop('inner-loop', makeSequence('dup', [makeTask('work', 'developer')]), 3),
                    5,
                ),
            });
            // Add a node with the same ID at a different level
            const defWithDup = makeDefinition({
                root: makeSequence('main', [
                    makeTask('dup', 'developer'),
                    makeLoop(
                        'outer-loop',
                        makeLoop('inner-loop', makeSequence('dup', [makeTask('work', 'developer')]), 3),
                        5,
                    ),
                ]),
            });
            const errors = validateWorkflow(defWithDup, DEFAULT_ROLES);
            const dupErrors = errors.filter((e) => e.type === 'duplicate_id');
            expect(dupErrors).toHaveLength(1);
            expect(dupErrors[0].nodeId).toBe('dup');
        });

        it('should validate complex loop body (sequence with gate)', () => {
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeTask('init', 'coordinator'),
                    makeLoop(
                        'dev-loop',
                        makeSequence('loop-body', [
                            makeTask('develop', 'developer'),
                            makeGate('review-gate', makeTask('continue', 'developer'), {
                                goto: 'develop',
                                maxRetries: 3,
                            }),
                        ]),
                        10,
                    ),
                    makeTask('finalize', 'coordinator'),
                ]),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES);
            expect(errors).toHaveLength(0);
        });

        it('should reject goto from outside loop to loop body internal node', () => {
            // A task after the loop tries to goto a node inside the loop body
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeLoop('my-loop', makeSequence('loop-body', [makeTask('inner-task', 'developer')]), 5),
                    {
                        ...makeTask('after-loop', 'developer'),
                        onFailed: { goto: 'inner-task', maxRetries: 2 },
                    } as TaskNode & { onFailed: GotoTarget },
                ]),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const gotoErrors = errors.filter((e) => e.type === 'invalid_goto');
            expect(gotoErrors).toHaveLength(1);
            expect(gotoErrors[0].message).toContain('inner-task');
        });

        it('should allow goto to the loop node itself from a subsequent sibling', () => {
            // Goto to the loop node (not its internals) should be allowed
            const def = makeDefinition({
                root: makeSequence('main', [
                    makeLoop('my-loop', makeTask('work', 'developer'), 5),
                    {
                        ...makeTask('after-loop', 'developer'),
                        onFailed: { goto: 'my-loop', maxRetries: 2 },
                    } as TaskNode & { onFailed: GotoTarget },
                ]),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const gotoErrors = errors.filter((e) => e.type === 'invalid_goto');
            expect(gotoErrors).toHaveLength(0);
        });

        it('should reject loop body without any task node (empty sequence)', () => {
            const def = makeDefinition({
                root: makeLoop('my-loop', makeSequence('empty-body', []), 5),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const taskErrors = errors.filter((e) => e.message?.includes('at least one task node'));
            expect(taskErrors).toHaveLength(1);
            expect(taskErrors[0].nodeId).toBe('my-loop');
        });

        it('should reject loop body with only nested sequences (no task)', () => {
            const def = makeDefinition({
                root: makeLoop('my-loop', makeSequence('outer', [makeSequence('inner', [])]), 5),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES);
            const taskErrors = errors.filter((e) => e.message?.includes('at least one task node'));
            expect(taskErrors).toHaveLength(1);
        });

        it('should accept loop body with task inside nested structure', () => {
            const def = makeDefinition({
                root: makeLoop(
                    'my-loop',
                    makeSequence('body', [
                        makeParallel('par', [makeTask('t1', 'developer'), makeTask('t2', 'developer')]),
                    ]),
                    5,
                ),
            });
            const errors = validateWorkflow(def, DEFAULT_ROLES);
            expect(errors).toHaveLength(0);
        });
    });
});
