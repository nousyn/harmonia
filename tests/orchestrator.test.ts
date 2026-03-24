import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Orchestrator, PlaceholderAdapterRegistry } from '../src/core/orchestrator.js';
import type {
    OrchestratorConfig,
    AgentAdapter,
    AgentAdapterFactory,
    ConnectedAgent,
} from '../src/core/orchestrator.js';
import type { ResolvedContext } from '../src/core/engine-helpers.js';

describe('Orchestrator (Phase 1.8)', () => {
    // ─── PlaceholderAdapterRegistry ───

    describe('PlaceholderAdapterRegistry', () => {
        it('should start with empty types list', () => {
            const registry = new PlaceholderAdapterRegistry();
            expect(registry.listTypes()).toEqual([]);
        });

        it('should register and retrieve a factory', () => {
            const registry = new PlaceholderAdapterRegistry();
            const factory: AgentAdapterFactory = {
                create: () => ({
                    dispatchTask: vi.fn(),
                    checkStatus: vi.fn(),
                    terminate: vi.fn(),
                }),
            };

            registry.register('opencode', factory);

            expect(registry.getFactory('opencode')).toBe(factory);
            expect(registry.listTypes()).toEqual(['opencode']);
        });

        it('should return undefined for unregistered type', () => {
            const registry = new PlaceholderAdapterRegistry();
            expect(registry.getFactory('nonexistent')).toBeUndefined();
        });

        it('should support multiple adapter types', () => {
            const registry = new PlaceholderAdapterRegistry();
            const f1: AgentAdapterFactory = {
                create: () => ({
                    dispatchTask: vi.fn(),
                    checkStatus: vi.fn(),
                    terminate: vi.fn(),
                }),
            };
            const f2: AgentAdapterFactory = {
                create: () => ({
                    dispatchTask: vi.fn(),
                    checkStatus: vi.fn(),
                    terminate: vi.fn(),
                }),
            };

            registry.register('opencode', f1);
            registry.register('claude', f2);

            expect(registry.listTypes().sort()).toEqual(['claude', 'opencode']);
            expect(registry.getFactory('opencode')).toBe(f1);
            expect(registry.getFactory('claude')).toBe(f2);
        });

        it('should overwrite factory for same type', () => {
            const registry = new PlaceholderAdapterRegistry();
            const f1: AgentAdapterFactory = {
                create: () => ({
                    dispatchTask: vi.fn(),
                    checkStatus: vi.fn(),
                    terminate: vi.fn(),
                }),
            };
            const f2: AgentAdapterFactory = {
                create: () => ({
                    dispatchTask: vi.fn(),
                    checkStatus: vi.fn(),
                    terminate: vi.fn(),
                }),
            };

            registry.register('opencode', f1);
            registry.register('opencode', f2);

            expect(registry.getFactory('opencode')).toBe(f2);
            expect(registry.listTypes()).toEqual(['opencode']);
        });
    });

    // Note: Full Orchestrator.create() integration tests require a real workflow
    // plugin on disk (roles, definition, state file). Those will be added in
    // Phase 2 when we have proper fixture tooling. The unit tests here focus on
    // the PlaceholderAdapterRegistry and the API surface validation.
});
