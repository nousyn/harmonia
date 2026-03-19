/**
 * Dev workflow — action registration.
 *
 * This module exports a registerActions function called by the plugin loader.
 * Actions are invoked by beforeDispatch/afterComplete hooks defined in workflow.json
 * node definitions.
 *
 * Currently no custom actions are registered for the dev workflow.
 */

/**
 * Register dev workflow actions.
 *
 * @param api - Registration API provided by the plugin loader
 * @param api.register - Function to register an action by name and handler
 */
export function registerActions(_api: {
    register: (name: string, handler: (...args: unknown[]) => unknown) => void;
}): void {
    // No custom actions yet.
    // Example:
    //   api.register('check-dependencies', async (ctx) => {
    //       return { inject: ['Dependencies are up to date.'] };
    //   });
}
