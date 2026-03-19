/**
 * Step state management — manages <context_dir>/steps.json
 *
 * Tracks which sequential steps have been completed for each artifact,
 * supporting the P3 Sequential mode feature.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ArtifactStepState, ArtifactStepRecord } from './types.js';

const STEPS_FILE = 'steps.json';

interface StepsData {
    artifacts: Record<string, ArtifactStepState>;
}

function stepsPath(projectName: string, iteration: number, contextDir?: string): string {
    return join(contextDir!, STEPS_FILE);
}

/**
 * Read the steps state for a project context.
 */
export async function readSteps(
    projectName: string,
    iteration: number,
    contextDir?: string,
): Promise<Record<string, ArtifactStepState>> {
    try {
        const content = await readFile(stepsPath(projectName, iteration, contextDir), 'utf-8');
        const data = JSON.parse(content) as StepsData;
        return data.artifacts ?? {};
    } catch {
        return {};
    }
}

/**
 * Write steps state to disk.
 */
async function writeSteps(
    projectName: string,
    iteration: number,
    artifacts: Record<string, ArtifactStepState>,
    contextDir?: string,
): Promise<void> {
    const filePath = stepsPath(projectName, iteration, contextDir);
    await mkdir(dirname(filePath), { recursive: true });
    const data: StepsData = { artifacts };
    await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Get the step state for a specific artifact.
 */
export async function getArtifactStepState(
    projectName: string,
    iteration: number,
    artifactId: string,
    contextDir?: string,
): Promise<ArtifactStepState | null> {
    const artifacts = await readSteps(projectName, iteration, contextDir);
    return artifacts[artifactId] ?? null;
}

/**
 * Get the set of completed step IDs for an artifact.
 */
export function getCompletedStepIds(state: ArtifactStepState | null): Set<string> {
    if (!state) return new Set();
    return new Set(state.completedSteps.map((s) => s.stepId));
}

/**
 * Record a step as completed. If the step was already completed,
 * it is overwritten and all subsequent steps are cleared (rollback).
 *
 * @returns The updated ArtifactStepState
 */
export async function recordStepCompletion(
    projectName: string,
    iteration: number,
    artifactId: string,
    stepId: string,
    artifactPath: string,
    allStepIds: string[],
    contextDir?: string,
): Promise<ArtifactStepState> {
    const artifacts = await readSteps(projectName, iteration, contextDir);
    let state = artifacts[artifactId];

    if (!state) {
        state = {
            artifactId,
            completedSteps: [],
            finalized: false,
        };
    }

    // Find the index of this step in the workflow's step order
    const stepIndex = allStepIds.indexOf(stepId);

    // Check if this step was already completed — if so, rollback subsequent steps
    const existingIndex = state.completedSteps.findIndex((s) => s.stepId === stepId);
    if (existingIndex >= 0) {
        // Clear this step and all subsequent steps
        state.completedSteps = state.completedSteps.filter((s) => {
            const sIdx = allStepIds.indexOf(s.stepId);
            return sIdx < stepIndex;
        });
        // Reset finalized flag
        state.finalized = false;
        delete state.finalizedAt;
    }

    // Record the new step
    const record: ArtifactStepRecord = {
        stepId,
        completedAt: new Date().toISOString(),
        artifactPath,
    };
    state.completedSteps.push(record);

    artifacts[artifactId] = state;
    await writeSteps(projectName, iteration, artifacts, contextDir);
    return state;
}

/**
 * Mark an artifact as finalized (all steps completed + final artifact written).
 */
export async function markFinalized(
    projectName: string,
    iteration: number,
    artifactId: string,
    contextDir?: string,
): Promise<ArtifactStepState> {
    const artifacts = await readSteps(projectName, iteration, contextDir);
    const state = artifacts[artifactId];

    if (!state) {
        throw new Error(`No step state found for artifact "${artifactId}"`);
    }

    state.finalized = true;
    state.finalizedAt = new Date().toISOString();

    await writeSteps(projectName, iteration, artifacts, contextDir);
    return state;
}

/**
 * Check if an artifact's sequential process is finalized.
 */
export async function isArtifactFinalized(
    projectName: string,
    iteration: number,
    artifactId: string,
    contextDir?: string,
): Promise<boolean> {
    const state = await getArtifactStepState(projectName, iteration, artifactId, contextDir);
    return state?.finalized ?? false;
}
