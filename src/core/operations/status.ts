/**
 * Status Operations — project status queries + display formatting helpers.
 *
 * Extracted from the monolithic operations.ts during the 008 split.
 */

import { getProject, listProjects, resolveContextDir } from '../registry.js';
import { readState } from '../state.js';
import { loadWorkflow } from '../plugin.js';
import { listArtifacts, resolveArtifactDir } from '../artifacts.js';
import type { ArtifactIOContext } from '../artifacts.js';
import { readReviews } from '../reviews.js';
import { getCompletedStepIds, readSteps, recordStepCompletion, buildStepGuidanceFromState } from '../steps.js';
import { readDispatches, readSessions } from '../dispatch.js';
import { readIssues } from '../issues.js';
import { processWorkflowEvent, formatNextAction, loadWorkflowForContext, findTaskNode } from '../engine-helpers.js';
import { loadArtifactSchema, validateArtifact } from '../schema.js';
import type { ResolvedContext } from '../engine-helpers.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
    ArtifactDefinition,
    WorkflowNode,
    NodeState,
    LoopNodeState,
    DispatchRecord,
    SessionRecord,
    ArtifactStepState,
} from '../types.js';
import type { ProjectStatusData, ProjectListItem } from './types.js';
import { ValidationError } from './types.js';

// ─── Status Formatting Helpers ───
// These are pure presentation functions extracted from get-project-status.ts.
// They can be used by any transport layer for consistent formatting.

/** Get status icon for a node. */
export function statusIcon(status: string): string {
    switch (status) {
        case 'completed':
            return '✓';
        case 'active':
            return '●';
        case 'failed':
            return '✗';
        case 'cancelled':
            return '—';
        case 'skipped':
            return '⊘';
        default:
            return '○';
    }
}

/** Format the workflow tree as an indented status view. */
export function formatNodeTree(
    node: WorkflowNode,
    nodes: Record<string, NodeState>,
    dispatches: DispatchRecord[],
    depth: number = 0,
): string[] {
    const indent = '  '.repeat(depth);
    const lines: string[] = [];
    const state = nodes[node.id];
    const status = state?.status ?? 'pending';
    const icon = statusIcon(status);

    switch (node.type) {
        case 'task': {
            const dispatchInfo = getNodeDispatchInfo(node.id, dispatches);
            lines.push(indent + icon + ' ' + node.id + ' (task, ' + node.role + ') — ' + status + dispatchInfo);
            break;
        }
        case 'sequence':
            lines.push(indent + icon + ' ' + node.id + ' (sequence) — ' + status);
            for (const child of node.children) {
                lines.push(...formatNodeTree(child, nodes, dispatches, depth + 1));
            }
            break;
        case 'parallel':
            lines.push(indent + icon + ' ' + node.id + ' (parallel, ' + node.failStrategy + ') — ' + status);
            for (const child of node.children) {
                lines.push(...formatNodeTree(child, nodes, dispatches, depth + 1));
            }
            break;
        case 'gate': {
            const gateStatus = status === 'completed' ? 'passed' : status === 'failed' ? 'failed' : status;
            lines.push(indent + icon + ' ' + node.id + ' (gate) — ' + gateStatus);
            lines.push(...formatNodeTree(node.pass, nodes, dispatches, depth + 1));
            if ('type' in node.fail) {
                lines.push(...formatNodeTree(node.fail as WorkflowNode, nodes, dispatches, depth + 1));
            } else {
                const failTarget = node.fail as { goto: string };
                lines.push(indent + '  ↩ fail → goto ' + failTarget.goto);
            }
            break;
        }
        case 'loop': {
            const loopState = state as LoopNodeState | undefined;
            const iteration = loopState?.currentIteration ?? 0;
            const done = loopState?.done ? ', done marked' : '';
            lines.push(
                indent +
                    icon +
                    ' ' +
                    node.id +
                    ' (loop, ' +
                    iteration +
                    '/' +
                    node.maxIterations +
                    done +
                    ') — ' +
                    status,
            );
            lines.push(...formatNodeTree(node.body, nodes, dispatches, depth + 1));
            break;
        }
    }

    return lines;
}

function getNodeDispatchInfo(nodeId: string, dispatches: DispatchRecord[]): string {
    const nodeDispatches = dispatches.filter(
        (d) => d.nodeId === nodeId && (d.status === 'dispatched' || d.status === 'running'),
    );
    if (nodeDispatches.length === 0) return '';
    const info = nodeDispatches.map((d) => d.id + ':' + d.status).join(', ');
    return ' [' + info + ']';
}

/** Format a dispatch record for display. */
export function formatDispatch(d: DispatchRecord, sessions: SessionRecord[]): string {
    const icon = statusIcon(d.status === 'dispatched' ? 'pending' : d.status === 'running' ? 'active' : d.status);
    const session = sessions.find((s) => s.id === d.sessionId);
    const sessionInfo = session?.agentSessionId ? ' session:' + session.agentSessionId : '';
    const note = d.note ? ' (' + d.note + ')' : '';
    const nodeInfo = d.nodeId ? ' node:' + d.nodeId : '';
    const brief = d.taskBrief.length > 60 ? d.taskBrief.slice(0, 57) + '...' : d.taskBrief;
    return (
        '  ' +
        icon +
        ' ' +
        d.id +
        '  ' +
        d.role.padEnd(12) +
        ' [' +
        d.status +
        ']  ' +
        brief +
        nodeInfo +
        sessionInfo +
        note
    );
}

/** Format a session record for display. */
export function formatSession(s: SessionRecord): string {
    const agentInfo = s.agentSessionId ? 'agent:' + s.agentSessionId : 'no agent ID';
    const label = s.label ? ' (' + s.label + ')' : '';
    const agentType = s.agentType ? ' via ' + s.agentType : '';
    return '  ' + s.id + '  ' + s.role.padEnd(12) + ' [' + s.status + ']  ' + agentInfo + agentType + label;
}

/** Format step progress for a sequential artifact. */
export function formatStepProgress(artifactDef: ArtifactDefinition, stepState: ArtifactStepState | undefined): string {
    const steps = artifactDef.steps!;
    const completedIds = stepState ? getCompletedStepIds(stepState) : new Set<string>();
    const finalized = stepState?.finalized ?? false;

    if (finalized) {
        return '  Steps: all completed ✓ (finalized)';
    }

    let firstIncomplete = steps.length;
    for (let i = 0; i < steps.length; i++) {
        if (!completedIds.has(steps[i].id)) {
            firstIncomplete = i;
            break;
        }
    }

    const parts = steps.map((s, i) => {
        if (completedIds.has(s.id)) return '[✓] ' + s.name;
        if (i === firstIncomplete) return '[→] ' + s.name;
        return '[ ] ' + s.name;
    });

    return '  Steps: ' + parts.join(' → ');
}

/** Format artifacts summary. */
export function formatArtifactsSummary(
    existingArtifacts: string[],
    artifactDefs: Record<string, ArtifactDefinition>,
    reviews: Record<string, { status: string; submittedAt: string }>,
    stepsData: Record<string, ArtifactStepState>,
): string {
    if (existingArtifacts.length === 0) return '(none yet)';

    return existingArtifacts
        .map((id) => {
            const review = reviews[id];
            const reviewTag = review ? ' [' + review.status + ']' : '';
            const def = artifactDefs[id];
            const hasSteps = def?.steps && def.steps.length > 0;
            let line = '- ' + id + reviewTag;
            if (hasSteps) {
                line += '\n' + formatStepProgress(def, stepsData[id]);
            }
            return line;
        })
        .join('\n');
}

/** Format in-progress artifacts (steps started but artifact not yet finalized). */
export function formatInProgressArtifacts(
    existingArtifacts: string[],
    artifactDefs: Record<string, ArtifactDefinition>,
    stepsData: Record<string, ArtifactStepState>,
): string {
    const inProgress = Object.keys(stepsData)
        .filter((id) => !existingArtifacts.includes(id))
        .map((id) => {
            const def = artifactDefs[id];
            if (!def?.steps?.length) return null;
            const stepState = stepsData[id];
            const completedCount = stepState?.completedSteps.length ?? 0;
            if (completedCount === 0) return null;
            return (
                '- ' +
                id +
                ' (in progress, ' +
                completedCount +
                '/' +
                def.steps.length +
                ' steps)\n' +
                formatStepProgress(def, stepState)
            );
        })
        .filter(Boolean);

    return inProgress.length > 0 ? inProgress.join('\n') : '';
}

// ─── Step Guidance Building ───

/**
 * Build step guidance for all stepped artifacts that have progress.
 *
 * Includes: (1) the active node's artifact (if any), and
 * (2) any other artifacts with at least one completed step.
 */
function buildAllStepGuidances(
    wf: { artifactDefinitions: Record<string, ArtifactDefinition> },
    stepsData: Record<string, ArtifactStepState>,
    activeArtifactId: string | undefined,
    ioCtx: ArtifactIOContext,
): import('../types.js').StepGuidance[] {
    const guidances: import('../types.js').StepGuidance[] = [];
    const seen = new Set<string>();

    // Priority 1: active node's artifact
    if (activeArtifactId) {
        const def = wf.artifactDefinitions[activeArtifactId];
        if (def?.steps?.length) {
            const guidance = buildStepGuidanceFromState(
                activeArtifactId,
                def,
                stepsData[activeArtifactId] ?? null,
                ioCtx,
            );
            if (guidance) {
                guidances.push(guidance);
                seen.add(activeArtifactId);
            }
        }
    }

    // Priority 2: any other artifacts with in-progress steps
    for (const [artifactId, stepState] of Object.entries(stepsData)) {
        if (seen.has(artifactId)) continue;
        if (!stepState.completedSteps?.length) continue;
        const def = wf.artifactDefinitions[artifactId];
        if (!def?.steps?.length) continue;
        const guidance = buildStepGuidanceFromState(artifactId, def, stepState, ioCtx);
        if (guidance) guidances.push(guidance);
    }

    return guidances;
}

// ─── Step Auto-Detection ───

/**
 * Detect and sync completed steps by scanning step files on disk.
 *
 * This enables recovery when agent disconnects and reconnects - Harmonia
 * automatically detects which steps have been completed by checking:
 * 1. Step file exists
 * 2. Step file passes schema validation
 *
 * @param workflowsDir - Workflows directory
 * @param projectName - Project name
 * @param iteration - Iteration number
 * @param wf - Workflow plugin
 * @param ioCtx - Artifact I/O context
 * @param contextDir - Context directory
 */
export async function detectAndSyncCompletedSteps(
    workflowsDir: string,
    projectName: string,
    iteration: number,
    wf: { artifactDefinitions: Record<string, ArtifactDefinition> },
    ioCtx: ArtifactIOContext,
    contextDir: string,
    workflowName: string,
): Promise<void> {
    for (const [artifactId, artifactDef] of Object.entries(wf.artifactDefinitions)) {
        if (!artifactDef.steps?.length) continue;

        const stepState = await readSteps(projectName, iteration, contextDir);
        const artifactState = stepState[artifactId];
        const completedIds = getCompletedStepIds(artifactState ?? null);
        const dir = resolveArtifactDir(artifactDef.output, ioCtx);

        for (const step of artifactDef.steps) {
            if (completedIds.has(step.id)) continue; // Already recorded

            const ext = step.format === 'json' ? '.json' : '.md';
            const filePath = join(dir, `${artifactId}.${step.id}${ext}`);

            if (!existsSync(filePath)) continue; // File doesn't exist

            // File exists, validate against schema
            try {
                const content = await readFile(filePath, 'utf-8');
                const schema = await loadArtifactSchema(workflowsDir, workflowName, `${artifactId}.${step.id}`);

                if (schema) {
                    const isJson = step.format === 'json';
                    const validation = validateArtifact(content, schema, false, isJson);
                    if (!validation.valid) continue; // Validation failed, not complete
                }

                // Validation passed (or no schema), auto-record
                const allStepIds = artifactDef.steps.map((s) => s.id);
                await recordStepCompletion(
                    projectName,
                    iteration,
                    artifactId,
                    step.id,
                    filePath,
                    allStepIds,
                    contextDir,
                );
                console.log(`[Harmonia] Auto-detected completed step: ${artifactId}.${step.id}`);
            } catch {
                // Read or validation error, skip
            }
        }
    }
}

// ─── getProjectStatus / getProjectList ───

/**
 * Get detailed project status data.
 *
 * Extracted from: src/tools/get-project-status.ts (detail mode)
 *
 * Returns raw structured data — the API layer handles formatting.
 */
export async function getProjectStatus(workflowsDir: string, projectName: string): Promise<ProjectStatusData> {
    const entry = await getProject(projectName);
    if (!entry) {
        throw new Error(`项目 "${projectName}" 未注册。`);
    }

    if (!entry.activeContext) {
        throw new ValidationError(
            `项目 "${projectName}" 已注册但无活跃上下文。` +
                `迭代: ${entry.totalIterations}, 补丁: ${entry.totalPatches}。` +
                `请开始迭代或补丁。`,
        );
    }

    const resolved = resolveContextDir(projectName, entry.activeContext);
    if (!resolved) {
        throw new Error(`项目 "${projectName}" 的 activeContext "${entry.activeContext}" 无法解析。数据可能已损坏。`);
    }

    const contextDir = resolved.dir;
    const contextNumber = resolved.number;
    const state = await readState(projectName, contextNumber, contextDir);
    const wf = await loadWorkflow(workflowsDir, state.workflow);
    const statusIoCtx: ArtifactIOContext = {
        contextDir,
        projectDir: entry.dir,
        contextLabel: entry.activeContext,
    };
    const artifactIds = await listArtifacts(statusIoCtx, wf.artifactDefinitions);
    const reviews = await readReviews(projectName, contextNumber, contextDir);
    const dispatches = await readDispatches(projectName, contextNumber, contextDir);
    const sessions = await readSessions(projectName, contextNumber, contextDir);
    let stepsData = await readSteps(projectName, contextNumber, contextDir);
    const issues = await readIssues(projectName);

    // Auto-detect completed steps (for recovery after disconnect)
    await detectAndSyncCompletedSteps(
        workflowsDir,
        projectName,
        contextNumber,
        wf,
        statusIoCtx,
        contextDir,
        state.workflow,
    );

    // Re-read stepsData after sync
    stepsData = await readSteps(projectName, contextNumber, contextDir);

    // Workflow tree view
    const treeLines = formatNodeTree(wf.definition.root, state.nodes, dispatches);

    // Floating nodes
    if (wf.definition.floatingNodes && wf.definition.floatingNodes.length > 0) {
        treeLines.push('');
        treeLines.push('Floating nodes:');
        for (const fn of wf.definition.floatingNodes) {
            const fnState = state.nodes[fn.id];
            const fnStatus = fnState?.status ?? 'pending';
            const fnIcon = statusIcon(fnStatus);
            treeLines.push(`  ${fnIcon} ${fn.id} (task, ${fn.role}) \u2014 ${fnStatus}`);
        }
    }

    // Engine nextAction
    let nextActionText = '';
    let stepGuidance: import('../types.js').StepGuidance | undefined;
    let stepGuidances: import('../types.js').StepGuidance[] | undefined;
    try {
        const ctx: ResolvedContext = {
            entry,
            number: contextNumber,
            dir: contextDir,
            type: resolved.type as 'iteration' | 'patch',
            activeContext: entry.activeContext!,
        };
        const engineResult = await processWorkflowEvent(workflowsDir, projectName, ctx, {
            type: 'query_status',
        });
        nextActionText = formatNextAction(engineResult.nextAction);

        // Determine the active node's artifact (if any)
        let activeArtifactId: string | undefined;
        if (state.activeNodeId) {
            const activeNode = findTaskNode(wf, state.activeNodeId);
            if (activeNode?.role) {
                const roleDef = wf.roles[activeNode.role];
                activeArtifactId = roleDef?.frontmatter?.capabilities?.find((c) => c.artifact)?.artifact;
            }
        }

        // Build step guidance for all in-progress stepped artifacts
        const guidances = buildAllStepGuidances(wf, stepsData, activeArtifactId, statusIoCtx);
        if (guidances.length > 0) {
            stepGuidance = guidances[0];
            stepGuidances = guidances;
        }
    } catch {
        nextActionText = '\n[Next Action] (could not compute — engine error)';
    }

    return {
        projectName: state.projectName,
        projectDir: state.projectDir,
        workflow: state.workflow,
        activeContext: entry.activeContext,
        contextType: resolved.type,
        contextNumber,
        currentIteration: entry.currentIteration,
        totalIterations: entry.totalIterations,
        currentPatch: entry.currentPatch,
        totalPatches: entry.totalPatches,
        activeNodeId: state.activeNodeId ?? null,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        treeLines,
        artifactIds,
        artifactDefs: wf.artifactDefinitions,
        reviews,
        stepsData,
        dispatches,
        sessions,
        issues,
        nextAction: nextActionText,
        stepGuidance,
        stepGuidances,
    };
}

/**
 * Get project list summary.
 *
 * Extracted from: src/tools/get-project-status.ts (list mode)
 */
export async function getProjectList(): Promise<ProjectListItem[]> {
    const projectNames = await listProjects();

    if (projectNames.length === 0) {
        return [];
    }

    const items: ProjectListItem[] = [];
    for (const name of projectNames) {
        try {
            const entry = await getProject(name);
            if (!entry || !entry.activeContext) {
                items.push({
                    name,
                    dir: entry?.dir ?? '?',
                    activeContext: entry?.activeContext || undefined,
                });
                continue;
            }
            const resolved = resolveContextDir(name, entry.activeContext);
            if (!resolved) {
                items.push({ name, dir: entry.dir, error: 'context error' });
                continue;
            }
            const state = await readState(name, resolved.number, resolved.dir);
            items.push({
                name,
                dir: state.projectDir,
                workflow: state.workflow,
                activeNode: state.activeNodeId ?? undefined,
                activeContext: entry.activeContext,
                updatedAt: state.updatedAt.split('T')[0],
            });
        } catch {
            items.push({ name, dir: '?', error: 'cannot read state' });
        }
    }

    return items;
}
