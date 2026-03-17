/**
 * Step state management — manages <context_dir>/steps.json
 *
 * Tracks which sequential steps have been completed for each document,
 * supporting the P3 Sequential mode feature.
 * All public functions accept an optional contextDir parameter.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getIterationDir } from './registry.js';
import type { DocStepState, DocStepRecord } from './types.js';

const STEPS_FILE = 'steps.json';

interface StepsData {
    docs: Record<string, DocStepState>;
}

function stepsPath(projectName: string, iteration: number, contextDir?: string): string {
    const base = contextDir ?? getIterationDir(projectName, iteration);
    return join(base, STEPS_FILE);
}

/**
 * Read the steps state for a project context.
 */
export async function readSteps(
    projectName: string,
    iteration: number,
    contextDir?: string,
): Promise<Record<string, DocStepState>> {
    try {
        const content = await readFile(stepsPath(projectName, iteration, contextDir), 'utf-8');
        const data = JSON.parse(content) as StepsData;
        return data.docs ?? {};
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
    docs: Record<string, DocStepState>,
    contextDir?: string,
): Promise<void> {
    const filePath = stepsPath(projectName, iteration, contextDir);
    await mkdir(dirname(filePath), { recursive: true });
    const data: StepsData = { docs };
    await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Get the step state for a specific document.
 */
export async function getDocStepState(
    projectName: string,
    iteration: number,
    docId: string,
    contextDir?: string,
): Promise<DocStepState | null> {
    const docs = await readSteps(projectName, iteration, contextDir);
    return docs[docId] ?? null;
}

/**
 * Get the set of completed step IDs for a document.
 */
export function getCompletedStepIds(state: DocStepState | null): Set<string> {
    if (!state) return new Set();
    return new Set(state.completedSteps.map((s) => s.stepId));
}

/**
 * Record a step as completed. If the step was already completed,
 * it is overwritten and all subsequent steps are cleared (rollback).
 *
 * @returns The updated DocStepState
 */
export async function recordStepCompletion(
    projectName: string,
    iteration: number,
    docId: string,
    stepId: string,
    artifactPath: string,
    allStepIds: string[],
    contextDir?: string,
): Promise<DocStepState> {
    const docs = await readSteps(projectName, iteration, contextDir);
    let state = docs[docId];

    if (!state) {
        state = {
            docId,
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
    const record: DocStepRecord = {
        stepId,
        completedAt: new Date().toISOString(),
        artifactPath,
    };
    state.completedSteps.push(record);

    docs[docId] = state;
    await writeSteps(projectName, iteration, docs, contextDir);
    return state;
}

/**
 * Mark a document as finalized (all steps completed + final doc written).
 */
export async function markFinalized(
    projectName: string,
    iteration: number,
    docId: string,
    contextDir?: string,
): Promise<DocStepState> {
    const docs = await readSteps(projectName, iteration, contextDir);
    const state = docs[docId];

    if (!state) {
        throw new Error(`No step state found for document "${docId}"`);
    }

    state.finalized = true;
    state.finalizedAt = new Date().toISOString();

    await writeSteps(projectName, iteration, docs, contextDir);
    return state;
}

/**
 * Check if a document's sequential process is finalized.
 */
export async function isDocFinalized(
    projectName: string,
    iteration: number,
    docId: string,
    contextDir?: string,
): Promise<boolean> {
    const state = await getDocStepState(projectName, iteration, docId, contextDir);
    return state?.finalized ?? false;
}
