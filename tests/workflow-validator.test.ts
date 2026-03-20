import { describe, it, expect } from 'vitest';
import { validateWorkflow } from '../src/core/workflow-validator.js';
import type {
    WorkflowDefinition,
    WorkflowNode,
    TaskNode,
    SequenceNode,
    ParallelNode,
    GateNode,
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
});
