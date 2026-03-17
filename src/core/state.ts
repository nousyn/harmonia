/**
 * Project state management — manages state.json within iteration/patch directories.
 *
 * All functions accept an optional `contextDir` parameter. When provided, it is used
 * directly as the directory containing state.json. When omitted, the directory is
 * resolved from `getIterationDir(projectName, iteration)` for backward compatibility.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getIterationDir } from './registry.js';
import type { ContextType, PhaseStatus, ProjectScale, ProjectState, LoadedWorkflow } from './types.js';

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

function resolveDir(projectName: string, iteration: number, contextDir?: string): string {
    return contextDir ?? getIterationDir(projectName, iteration);
}

function statePath(projectName: string, iteration: number, contextDir?: string): string {
    return join(resolveDir(projectName, iteration, contextDir), STATE_FILE);
}

/** Phases to skip in patch mode (clarify and design) */
const PATCH_SKIP_PHASES = new Set(['clarify', 'design']);

/**
 * Initialize a new project state file.
 *
 * For iteration mode (default): all phases start normally (first = in_progress, rest = pending).
 * For patch mode: clarify/design are marked as "skipped", first non-skipped phase is in_progress,
 * scale is set to "small" automatically.
 *
 * @param contextDir - Optional explicit directory. If omitted, uses getIterationDir().
 */
export async function initProjectState(
    projectName: string,
    projectDir: string,
    workflow: LoadedWorkflow,
    iteration: number,
    type: ContextType = 'iteration',
    contextDir?: string,
): Promise<ProjectState> {
    const now = new Date().toISOString();
    const phases = workflow.definition.phases;
    const isPatch = type === 'patch';

    // Find the first non-skipped phase
    const firstActiveIndex = isPatch ? phases.findIndex((p) => !PATCH_SKIP_PHASES.has(p.id)) : 0;
    const firstPhaseId = phases[firstActiveIndex]?.id ?? phases[0]?.id ?? '';

    const state: ProjectState = {
        projectName,
        projectDir,
        workflow: workflow.definition.name,
        type,
        iteration,
        scale: isPatch ? 'small' : null,
        currentPhase: firstPhaseId,
        phases: phases.map((p, i) => {
            if (isPatch && PATCH_SKIP_PHASES.has(p.id)) {
                return { id: p.id, status: 'skipped' as const };
            }
            if (i === firstActiveIndex) {
                return { id: p.id, status: 'in_progress' as const, startedAt: now };
            }
            return { id: p.id, status: 'pending' as const };
        }),
        createdAt: now,
        updatedAt: now,
    };

    await writeState(projectName, iteration, state, contextDir);
    return state;
}

/**
 * Read the current project state.
 */
export async function readState(projectName: string, iteration: number, contextDir?: string): Promise<ProjectState> {
    const content = await readFile(statePath(projectName, iteration, contextDir), 'utf-8');
    return JSON.parse(content) as ProjectState;
}

/**
 * Write project state to disk.
 */
export async function writeState(
    projectName: string,
    iteration: number,
    state: ProjectState,
    contextDir?: string,
): Promise<void> {
    const filePath = statePath(projectName, iteration, contextDir);
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
    contextDir?: string,
): Promise<ProjectState> {
    const state = await readState(projectName, iteration, contextDir);
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
    // (skip over phases that are already "skipped")
    if (status === 'completed') {
        const idx = state.phases.findIndex((p) => p.id === phaseId);
        const next = state.phases.find((p, i) => i > idx && p.status === 'pending');
        if (next) {
            next.status = 'in_progress';
            next.startedAt = now;
            state.currentPhase = next.id;
        }
    }

    await writeState(projectName, iteration, state, contextDir);
    return state;
}

/**
 * Check if a project state file exists.
 */
export async function projectStateExists(
    projectName: string,
    iteration: number,
    contextDir?: string,
): Promise<boolean> {
    try {
        await readFile(statePath(projectName, iteration, contextDir), 'utf-8');
        return true;
    } catch {
        return false;
    }
}

/**
 * Set the project scale. Scale is immutable once set.
 */
export async function setScale(
    projectName: string,
    iteration: number,
    scale: ProjectScale,
    contextDir?: string,
): Promise<ProjectState> {
    const state = await readState(projectName, iteration, contextDir);
    if (state.scale !== null) {
        throw new Error(`Scale 已设定为 "${state.scale}"，不可更改。如需调整规模，请重新评估 PRD。`);
    }
    state.scale = scale;
    await writeState(projectName, iteration, state, contextDir);
    return state;
}
