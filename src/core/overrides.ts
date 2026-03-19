/**
 * Override configuration — two-layer system: project overrides > workflow defaults.
 *
 * Project-level overrides are stored in:
 *   <data_dir>/<project_name>/overrides.json
 *
 * Workflow defaults come from the workflow definition (artifactDefinitions, roles).
 * The override system lets users customize per-project settings without modifying
 * the workflow definition itself.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getProjectDataDir } from './registry.js';
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
 * Write project-level overrides.
 */
export async function writeProjectOverrides(projectName: string, config: OverrideConfig): Promise<void> {
    await writeOverrideFile(join(getProjectDataDir(projectName), OVERRIDES_FILE), config);
}

/**
 * Get the override config for a project.
 * Returns the project-level overrides directly — no global merge.
 */
export async function getMergedOverrides(projectName: string): Promise<OverrideConfig> {
    return readProjectOverrides(projectName);
}

/**
 * Resolve whether a specific artifact requires review.
 *
 * Priority: project override > workflow default
 */
export function resolveArtifactReview(
    artifactId: string,
    artifactDef: ArtifactDefinition,
    overrides: OverrideConfig,
): boolean {
    const review = overrides.review;

    // Override is a per-artifact record
    if (typeof review === 'object' && review !== null) {
        if (artifactId in review) {
            return review[artifactId];
        }
        // Not mentioned in override, fall through to workflow default
    }

    // Override is a global boolean toggle
    if (typeof review === 'boolean') {
        return review;
    }

    // No override — use workflow default
    return artifactDef.review ?? false;
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
 * Set a single role capability override at project level.
 */
export async function setCapabilityOverride(
    projectName: string,
    roleId: string,
    capabilityId: string,
    override: CapabilityOverride,
): Promise<void> {
    const config = await readProjectOverrides(projectName);

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

    await writeProjectOverrides(projectName, config);
}

/**
 * Set review override for a specific artifact at project level.
 */
export async function setReviewOverride(projectName: string, artifactId: string, enabled: boolean): Promise<void> {
    const config = await readProjectOverrides(projectName);

    // Ensure review is a per-artifact record
    if (typeof config.review !== 'object' || config.review === null) {
        config.review = {};
    }
    config.review[artifactId] = enabled;

    await writeProjectOverrides(projectName, config);
}

/**
 * Resolve the agent/model configuration for a role.
 * Returns { agent, model } from the overrides, or undefined fields if not set.
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
 * Set agent/model config for a role at project level.
 */
export async function setRoleAgentConfig(
    projectName: string,
    roleId: string,
    agent?: string,
    model?: string,
): Promise<void> {
    const config = await readProjectOverrides(projectName);

    if (!config.roles) {
        config.roles = {};
    }
    if (!config.roles[roleId]) {
        config.roles[roleId] = {};
    }
    if (agent) config.roles[roleId].agent = agent as RoleOverride['agent'];
    if (model) config.roles[roleId].model = model;

    await writeProjectOverrides(projectName, config);
}
