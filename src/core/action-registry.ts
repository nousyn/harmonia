/**
 * Action registry — manages node hook action registration and execution.
 *
 * Actions are registered by workflow plugins (via tools/index.js) and executed
 * synchronously by the Core during tool call processing (in beforeDispatch
 * and afterComplete hooks).
 *
 * Actions cannot require agent behavior — only data operations and external
 * API calls. They execute within the Harmonia server context.
 */

import type { ActionHandler, ActionContext, ActionResult } from './types.js';

export class ActionRegistry {
    private actions = new Map<string, ActionHandler>();

    /**
     * Register an action handler.
     * @throws If an action with the same name is already registered
     */
    register(name: string, handler: ActionHandler): void {
        if (this.actions.has(name)) {
            throw new Error(`Action "${name}" is already registered`);
        }
        this.actions.set(name, handler);
    }

    /**
     * Execute a registered action.
     * @throws If the action is not registered
     */
    async execute(name: string, context: ActionContext): Promise<ActionResult> {
        const handler = this.actions.get(name);
        if (!handler) {
            throw new Error(
                `Action "${name}" is not registered. Available actions: ${this.list().join(', ') || 'none'}`,
            );
        }
        return handler(context);
    }

    /**
     * Check if an action is registered.
     */
    has(name: string): boolean {
        return this.actions.has(name);
    }

    /**
     * List all registered action names.
     */
    list(): string[] {
        return Array.from(this.actions.keys());
    }

    /**
     * Remove all registered actions. Useful for testing or plugin reload.
     */
    clear(): void {
        this.actions.clear();
    }
}
