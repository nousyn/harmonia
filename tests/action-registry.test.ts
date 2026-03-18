import { describe, it, expect, beforeEach } from 'vitest';
import { ActionRegistry } from '../src/core/action-registry.js';
import type { ActionContext, ActionResult } from '../src/core/types.js';

// ─── Helpers ───

function makeContext(overrides: Partial<ActionContext> = {}): ActionContext {
    return {
        nodeId: 'test-node',
        role: 'developer',
        retryCount: 0,
        projectName: 'test-project',
        pluginConfig: {},
        workflowState: {
            projectName: 'test-project',
            projectDir: '/test',
            workflow: 'test',
            type: 'iteration',
            iteration: 1,
            activeNodeId: 'test-node',
            nodes: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        },
        artifacts: {
            read: async () => '',
            list: async () => [],
        },
        ...overrides,
    };
}

// ─── Tests ───

describe('ActionRegistry', () => {
    let registry: ActionRegistry;

    beforeEach(() => {
        registry = new ActionRegistry();
    });

    describe('register', () => {
        it('should register an action handler', () => {
            const handler = async () => ({});
            registry.register('test-action', handler);
            expect(registry.has('test-action')).toBe(true);
        });

        it('should throw when registering duplicate name', () => {
            const handler = async () => ({});
            registry.register('test-action', handler);
            expect(() => registry.register('test-action', handler)).toThrow(
                'Action "test-action" is already registered',
            );
        });
    });

    describe('execute', () => {
        it('should execute a registered action and return result', async () => {
            const handler = async (ctx: ActionContext): Promise<ActionResult> => ({
                inject: [`Hello from ${ctx.role}`],
                data: { processed: true },
            });
            registry.register('greet', handler);

            const result = await registry.execute('greet', makeContext({ role: 'architect' }));

            expect(result.inject).toEqual(['Hello from architect']);
            expect(result.data).toEqual({ processed: true });
        });

        it('should throw when executing unregistered action', async () => {
            await expect(registry.execute('nonexistent', makeContext())).rejects.toThrow(
                'Action "nonexistent" is not registered',
            );
        });

        it('should pass context to handler', async () => {
            let receivedContext: ActionContext | null = null;
            const handler = async (ctx: ActionContext): Promise<ActionResult> => {
                receivedContext = ctx;
                return {};
            };
            registry.register('capture', handler);

            const ctx = makeContext({ nodeId: 'my-node', retryCount: 3 });
            await registry.execute('capture', ctx);

            expect(receivedContext).not.toBeNull();
            expect(receivedContext!.nodeId).toBe('my-node');
            expect(receivedContext!.retryCount).toBe(3);
        });

        it('should handle async handlers', async () => {
            const handler = async (): Promise<ActionResult> => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                return { inject: ['delayed result'] };
            };
            registry.register('async-action', handler);

            const result = await registry.execute('async-action', makeContext());
            expect(result.inject).toEqual(['delayed result']);
        });

        it('should propagate handler errors', async () => {
            const handler = async (): Promise<ActionResult> => {
                throw new Error('handler crashed');
            };
            registry.register('bad-action', handler);

            await expect(registry.execute('bad-action', makeContext())).rejects.toThrow('handler crashed');
        });
    });

    describe('has', () => {
        it('should return false for unregistered action', () => {
            expect(registry.has('nonexistent')).toBe(false);
        });

        it('should return true for registered action', () => {
            registry.register('exists', async () => ({}));
            expect(registry.has('exists')).toBe(true);
        });
    });

    describe('list', () => {
        it('should return empty array when no actions registered', () => {
            expect(registry.list()).toEqual([]);
        });

        it('should return all registered action names', () => {
            registry.register('alpha', async () => ({}));
            registry.register('beta', async () => ({}));
            registry.register('gamma', async () => ({}));

            const names = registry.list();
            expect(names).toHaveLength(3);
            expect(names).toContain('alpha');
            expect(names).toContain('beta');
            expect(names).toContain('gamma');
        });
    });

    describe('clear', () => {
        it('should remove all registered actions', () => {
            registry.register('a', async () => ({}));
            registry.register('b', async () => ({}));

            expect(registry.list()).toHaveLength(2);

            registry.clear();

            expect(registry.list()).toHaveLength(0);
            expect(registry.has('a')).toBe(false);
            expect(registry.has('b')).toBe(false);
        });
    });
});
