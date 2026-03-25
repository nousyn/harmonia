/**
 * OrchestratorPool — manages Orchestrator instances across projects.
 *
 * Maintains a Map<key, Orchestrator> where key = "projectName:activeContext".
 * Instances are lazily created on first access and cached for the service lifetime.
 * When a project's activeContext changes (new iteration/patch), the old instance
 * is shut down and a new one is created.
 */

import { Orchestrator } from './orchestrator.js';
import type { OrchestratorConfig } from './orchestrator.js';
import { resolveActive } from './engine-helpers.js';
import type { ResolvedContext } from './engine-helpers.js';
import type { AdapterRegistry } from '../adapters/types.js';

export interface OrchestratorPoolConfig {
    workflowsDir: string;
    adapterRegistry: AdapterRegistry;
    logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

/**
 * Pool key: "projectName:activeContext" (e.g. "my-app:iter-1").
 */
function poolKey(projectName: string, activeContext: string): string {
    return `${projectName}:${activeContext}`;
}

export class OrchestratorPool {
    private readonly instances = new Map<string, Orchestrator>();
    private readonly config: OrchestratorPoolConfig;

    constructor(config: OrchestratorPoolConfig) {
        this.config = config;
    }

    /** Expose the adapter registry for use by API routes (connect endpoint). */
    get adapterRegistry(): AdapterRegistry {
        return this.config.adapterRegistry;
    }

    /**
     * Get or create an Orchestrator for the given project.
     *
     * Resolves the project's active context, then either returns an existing
     * instance or creates a new one. If the project's activeContext has changed
     * (e.g. new iteration started), the old instance is shut down.
     */
    async getOrCreate(projectName: string): Promise<Orchestrator> {
        const ctx = await resolveActive(projectName);
        const key = poolKey(projectName, ctx.activeContext);

        // Check for existing instance with matching context
        const existing = this.instances.get(key);
        if (existing) {
            return existing;
        }

        // Shut down any stale instance for the same project but different context
        for (const [k, orch] of this.instances) {
            if (k.startsWith(projectName + ':')) {
                orch.shutdown();
                this.instances.delete(k);
            }
        }

        // Create new instance
        const orchConfig: OrchestratorConfig = {
            workflowsDir: this.config.workflowsDir,
            projectName,
            context: ctx,
            adapterRegistry: this.config.adapterRegistry,
            logLevel: this.config.logLevel,
        };
        const orch = await Orchestrator.create(orchConfig);
        this.instances.set(key, orch);
        return orch;
    }

    /**
     * Get an existing Orchestrator for the given project (no creation).
     * Returns undefined if no instance is cached.
     */
    get(projectName: string): Orchestrator | undefined {
        for (const [key, orch] of this.instances) {
            if (key.startsWith(projectName + ':')) {
                return orch;
            }
        }
        return undefined;
    }

    /**
     * Remove and shut down an Orchestrator for the given project.
     */
    remove(projectName: string): void {
        for (const [key, orch] of this.instances) {
            if (key.startsWith(projectName + ':')) {
                orch.shutdown();
                this.instances.delete(key);
            }
        }
    }

    /**
     * Shut down all instances. Called on server shutdown.
     */
    shutdownAll(): void {
        for (const orch of this.instances.values()) {
            orch.shutdown();
        }
        this.instances.clear();
    }

    /**
     * List all active project names.
     */
    listProjects(): string[] {
        const projects = new Set<string>();
        for (const key of this.instances.keys()) {
            projects.add(key.split(':')[0]);
        }
        return [...projects];
    }

    /**
     * Number of active instances.
     */
    get size(): number {
        return this.instances.size;
    }
}
