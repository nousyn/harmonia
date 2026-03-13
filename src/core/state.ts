/**
 * Project state management — manages <data_dir>/<project_name>/state.json
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getProjectDataDir } from './registry.js';
import type { PhaseStatus, ProjectScale, ProjectState, LoadedWorkflow } from './types.js';

const STATE_FILE = 'state.json';

function statePath(projectName: string): string {
    return join(getProjectDataDir(projectName), STATE_FILE);
}

/**
 * Initialize a new project state file.
 * Note: directory creation and registry are handled by registry.registerProject().
 * This only writes the state.json.
 */
export async function initProjectState(
    projectName: string,
    projectDir: string,
    workflow: LoadedWorkflow,
    scale: ProjectScale = 'small',
): Promise<ProjectState> {
    const now = new Date().toISOString();
    const phases = workflow.definition.phases;
    const firstPhaseId = phases[0]?.id ?? '';

    const state: ProjectState = {
        projectName,
        projectDir,
        workflow: workflow.definition.name,
        scale,
        currentPhase: firstPhaseId,
        phases: phases.map((p, i) => ({
            id: p.id,
            status: i === 0 ? 'in_progress' : 'pending',
            ...(i === 0 ? { startedAt: now } : {}),
        })),
        createdAt: now,
        updatedAt: now,
    };

    await writeState(projectName, state);
    return state;
}

/**
 * Read the current project state.
 */
export async function readState(projectName: string): Promise<ProjectState> {
    const content = await readFile(statePath(projectName), 'utf-8');
    return JSON.parse(content) as ProjectState;
}

/**
 * Write project state to disk.
 */
export async function writeState(projectName: string, state: ProjectState): Promise<void> {
    const filePath = statePath(projectName);
    await mkdir(dirname(filePath), { recursive: true });
    state.updatedAt = new Date().toISOString();
    await writeFile(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

/**
 * Update a specific phase's status.
 */
export async function updatePhaseStatus(
    projectName: string,
    phaseId: string,
    status: PhaseStatus,
    blockedReason?: string,
): Promise<ProjectState> {
    const state = await readState(projectName);
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

    await writeState(projectName, state);
    return state;
}

/**
 * Check if a project state file exists.
 */
export async function projectStateExists(projectName: string): Promise<boolean> {
    try {
        await readFile(statePath(projectName), 'utf-8');
        return true;
    } catch {
        return false;
    }
}
