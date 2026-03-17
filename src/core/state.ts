/**
 * Project state management — manages <data_dir>/<project_name>/iter-<n>/state.json
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getIterationDir } from './registry.js';
import type { PhaseStatus, ProjectScale, ProjectState, LoadedWorkflow } from './types.js';

/**
 * Error thrown when a tool requires scale but it hasn't been set yet.
 */
export class ScaleNotSetError extends Error {
    constructor(projectName: string) {
        super(`项目 "${projectName}" 尚未设定 scale。请先完成 PRD 审批，然后调用 project_set_scale 设定项目规模。`);
        this.name = 'ScaleNotSetError';
    }
}

const STATE_FILE = 'state.json';

function statePath(projectName: string, iteration: number): string {
    return join(getIterationDir(projectName, iteration), STATE_FILE);
}

/**
 * Initialize a new project state file for a specific iteration.
 * Note: directory creation is handled by registry.startIteration().
 * This only writes the state.json.
 */
export async function initProjectState(
    projectName: string,
    projectDir: string,
    workflow: LoadedWorkflow,
    iteration: number,
): Promise<ProjectState> {
    const now = new Date().toISOString();
    const phases = workflow.definition.phases;
    const firstPhaseId = phases[0]?.id ?? '';

    const state: ProjectState = {
        projectName,
        projectDir,
        workflow: workflow.definition.name,
        iteration,
        scale: null,
        currentPhase: firstPhaseId,
        phases: phases.map((p, i) => ({
            id: p.id,
            status: i === 0 ? 'in_progress' : 'pending',
            ...(i === 0 ? { startedAt: now } : {}),
        })),
        createdAt: now,
        updatedAt: now,
    };

    await writeState(projectName, iteration, state);
    return state;
}

/**
 * Read the current project state for a specific iteration.
 */
export async function readState(projectName: string, iteration: number): Promise<ProjectState> {
    const content = await readFile(statePath(projectName, iteration), 'utf-8');
    return JSON.parse(content) as ProjectState;
}

/**
 * Write project state to disk for a specific iteration.
 */
export async function writeState(projectName: string, iteration: number, state: ProjectState): Promise<void> {
    const filePath = statePath(projectName, iteration);
    await mkdir(dirname(filePath), { recursive: true });
    state.updatedAt = new Date().toISOString();
    await writeFile(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

/**
 * Update a specific phase's status.
 */
export async function updatePhaseStatus(
    projectName: string,
    iteration: number,
    phaseId: string,
    status: PhaseStatus,
    blockedReason?: string,
): Promise<ProjectState> {
    const state = await readState(projectName, iteration);
    const phase = state.phases.find((p) => p.id === phaseId);

    if (!phase) {
        throw new Error(`Phase "${phaseId}" not found in project state`);
    }

    const now = new Date().toISOString();
    phase.status = status;

    if (status === 'in_progress' && !phase.startedAt) {
        phase.startedAt = now;
    }
    if (status === 'completed') {
        phase.completedAt = now;
        delete phase.blockedReason;
    }
    if (status === 'blocked' && blockedReason) {
        phase.blockedReason = blockedReason;
    }

    // If advancing to in_progress, update currentPhase
    if (status === 'in_progress') {
        state.currentPhase = phaseId;
    }

    // If completing a phase, auto-advance currentPhase to the next pending one
    if (status === 'completed') {
        const idx = state.phases.findIndex((p) => p.id === phaseId);
        const next = state.phases.find((p, i) => i > idx && p.status === 'pending');
        if (next) {
            next.status = 'in_progress';
            next.startedAt = now;
            state.currentPhase = next.id;
        }
    }

    await writeState(projectName, iteration, state);
    return state;
}

/**
 * Check if a project state file exists for a specific iteration.
 */
export async function projectStateExists(projectName: string, iteration: number): Promise<boolean> {
    try {
        await readFile(statePath(projectName, iteration), 'utf-8');
        return true;
    } catch {
        return false;
    }
}

/**
 * Set the project scale. Scale is immutable once set.
 */
export async function setScale(projectName: string, iteration: number, scale: ProjectScale): Promise<ProjectState> {
    const state = await readState(projectName, iteration);
    if (state.scale !== null) {
        throw new Error(`Scale 已设定为 "${state.scale}"，不可更改。如需调整规模，请重新评估 PRD。`);
    }
    state.scale = scale;
    await writeState(projectName, iteration, state);
    return state;
}
