/**
 * Override configuration — three-layer merge system.
 *
 * Priority: project-level > global-level > workflow defaults
 *
 * Files:
 *   <data_dir>/overrides.json                    (global)
 *   <data_dir>/<project_name>/overrides.json     (project)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getGlobalDir, getProjectDataDir } from './registry.js';
import type { CapabilityOverride, ArtifactDefinition, OverrideConfig, RoleOverride } from './types.js';

const OVERRIDES_FILE = 'overrides.json';

/**
 * Read an override config file. Returns empty config if file doesn't exist.
 */
async function readOverrideFile(filePath: string): Promise<OverrideConfig> {
    try {
        const content = await readFile(filePath, 'utf-8');
        return JSON.parse(content) as OverrideConfig;
    } catch {
        return {};
    }
}

/**
 * Read global overrides (<data_dir>/overrides.json).
 */
export async function readGlobalOverrides(): Promise<OverrideConfig> {
    return readOverrideFile(join(getGlobalDir(), OVERRIDES_FILE));
}

/**
 * Read project-level overrides (<data_dir>/<project_name>/overrides.json).
 */
export async function readProjectOverrides(projectName: string): Promise<OverrideConfig> {
    return readOverrideFile(join(getProjectDataDir(projectName), OVERRIDES_FILE));
}

/**
 * Write an override config file.
 */
async function writeOverrideFile(filePath: string, config: OverrideConfig): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Write global overrides.
 */
export async function writeGlobalOverrides(config: OverrideConfig): Promise<void> {
    await writeOverrideFile(join(getGlobalDir(), OVERRIDES_FILE), config);
}

/**
 * Write project-level overrides.
 */
export async function writeProjectOverrides(projectName: string, config: OverrideConfig): Promise<void> {
    await writeOverrideFile(join(getProjectDataDir(projectName), OVERRIDES_FILE), config);
}

/**
 * Merge two override configs. `higher` takes priority over `lower`.
 */
function mergeConfigs(lower: OverrideConfig, higher: OverrideConfig): OverrideConfig {
    const merged: OverrideConfig = {};

    // Merge review: higher wins entirely if present
    if (higher.review !== undefined) {
        merged.review = higher.review;
    } else if (lower.review !== undefined) {
        merged.review = lower.review;
    }

    // Merge roles: deep merge per role (agent, model, capabilities)
    const lowerRoles = lower.roles ?? {};
    const higherRoles = higher.roles ?? {};
    const allRoleIds = new Set([...Object.keys(lowerRoles), ...Object.keys(higherRoles)]);

    if (allRoleIds.size > 0) {
        merged.roles = {};
        for (const roleId of allRoleIds) {
            const lo = lowerRoles[roleId] ?? {};
            const hi = higherRoles[roleId] ?? {};
            merged.roles[roleId] = {
                ...lo,
                ...hi,
                // Deep merge capabilities
                capabilities: {
                    ...(lo.capabilities ?? {}),
                    ...(hi.capabilities ?? {}),
                },
            };
            // Clean up empty capabilities
            if (Object.keys(merged.roles[roleId].capabilities!).length === 0) {
                delete merged.roles[roleId].capabilities;
            }
        }
    }

    return merged;
}

/**
 * Get the fully merged override config for a project.
 * Priority: project > global
 */
export async function getMergedOverrides(projectName: string): Promise<OverrideConfig> {
    const global = await readGlobalOverrides();
    const project = await readProjectOverrides(projectName);
    return mergeConfigs(global, project);
}

/**
 * Resolve whether a specific doc requires review.
 *
 * Priority: project override > global override > workflow default
 */
export function resolveDocReview(docId: string, docDef: ArtifactDefinition, overrides: OverrideConfig): boolean {
    const review = overrides.review;

    // Override is a per-doc record
    if (typeof review === 'object' && review !== null) {
        if (docId in review) {
            return review[docId];
        }
        // Not mentioned in override, fall through to workflow default
    }

    // Override is a global boolean toggle
    if (typeof review === 'boolean') {
        return review;
    }

    // No override — use workflow default
    return docDef.review ?? false;
}

/**
 * Resolve the capability override for a specific role + capability.
 * Returns null if no override is configured.
 */
export function resolveCapabilityOverride(
    roleId: string,
    capabilityId: string,
    overrides: OverrideConfig,
): CapabilityOverride | null {
    return overrides.roles?.[roleId]?.capabilities?.[capabilityId] ?? null;
}

/**
 * Set a single role capability override at project or global level.
 */
export async function setCapabilityOverride(
    scope: 'global' | 'project',
    projectName: string | null,
    roleId: string,
    capabilityId: string,
    override: CapabilityOverride,
): Promise<void> {
    const config = scope === 'global' ? await readGlobalOverrides() : await readProjectOverrides(projectName!);

    if (!config.roles) {
        config.roles = {};
    }
    if (!config.roles[roleId]) {
        config.roles[roleId] = {};
    }
    if (!config.roles[roleId].capabilities) {
        config.roles[roleId].capabilities = {};
    }
    config.roles[roleId].capabilities![capabilityId] = override;

    if (scope === 'global') {
        await writeGlobalOverrides(config);
    } else {
        await writeProjectOverrides(projectName!, config);
    }
}

/**
 * Set review override for a specific doc at project or global level.
 */
export async function setReviewOverride(
    scope: 'global' | 'project',
    projectName: string | null,
    docId: string,
    enabled: boolean,
): Promise<void> {
    const config = scope === 'global' ? await readGlobalOverrides() : await readProjectOverrides(projectName!);

    // Ensure review is a per-doc record
    if (typeof config.review !== 'object' || config.review === null) {
        config.review = {};
    }
    config.review[docId] = enabled;

    if (scope === 'global') {
        await writeGlobalOverrides(config);
    } else {
        await writeProjectOverrides(projectName!, config);
    }
}

/**
 * Resolve the agent/model configuration for a role.
 * Returns { agent, model } from the merged overrides, or undefined fields if not set.
 */
export function resolveRoleConfig(roleId: string, overrides: OverrideConfig): { agent?: string; model?: string } {
    const role = overrides.roles?.[roleId];
    if (!role) return {};
    return {
        ...(role.agent ? { agent: role.agent } : {}),
        ...(role.model ? { model: role.model } : {}),
    };
}

/**
 * Set agent/model config for a role at project or global level.
 */
export async function setRoleAgentConfig(
    scope: 'global' | 'project',
    projectName: string | null,
    roleId: string,
    agent?: string,
    model?: string,
): Promise<void> {
    const config = scope === 'global' ? await readGlobalOverrides() : await readProjectOverrides(projectName!);

    if (!config.roles) {
        config.roles = {};
    }
    if (!config.roles[roleId]) {
        config.roles[roleId] = {};
    }
    if (agent) config.roles[roleId].agent = agent as RoleOverride['agent'];
    if (model) config.roles[roleId].model = model;

    if (scope === 'global') {
        await writeGlobalOverrides(config);
    } else {
        await writeProjectOverrides(projectName!, config);
    }
}
