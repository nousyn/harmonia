/**
 * Operations — shared return types and error classes.
 *
 * Extracted from the monolithic operations.ts during the 008 split.
 */

import type { ArtifactDefinition, ArtifactStepState, DispatchRecord, SessionRecord } from '../types.js';

// ─── Return Types ───

export interface InitProjectResult {
    alreadyRegistered: boolean;
    projectName: string;
    projectDir: string;
    workflow: string;
    workflowDescription: string;
    availableRoles: string[];
    hookMessage: string;
    /** Info for already-registered projects */
    existingInfo?: {
        activeContext: string;
        totalIterations: number;
        totalPatches: number;
    };
}

export interface BeginIterationResult {
    iteration: number;
    projectName: string;
    projectDir: string;
    workflowName: string;
    availableRoles: string[];
    nextAction: string;
}

export interface BeginPatchResult {
    patchNumber: number;
    projectName: string;
    projectDir: string;
    workflowName: string;
    description?: string;
    issueId?: string;
    nextAction: string;
}

export interface ApproveArtifactResult {
    artifactId: string;
    approved: boolean;
    comment?: string;
    nextAction: string;
}

export interface PendingReviewItem {
    artifactId: string;
    submittedAt: string;
}

export interface ArtifactSchemaResult {
    text: string;
}

export interface ProjectStatusData {
    projectName: string;
    projectDir: string;
    workflow: string;
    activeContext: string;
    contextType: string;
    contextNumber: number;
    currentIteration: number;
    totalIterations: number;
    currentPatch: number;
    totalPatches: number;
    activeNodeId: string | null;
    createdAt: string;
    updatedAt: string;
    treeLines: string[];
    artifactIds: string[];
    artifactDefs: Record<string, ArtifactDefinition>;
    reviews: Record<string, { status: string; submittedAt: string }>;
    stepsData: Record<string, ArtifactStepState>;
    dispatches: DispatchRecord[];
    sessions: SessionRecord[];
    issues: import('../types.js').Issue[];
    nextAction: string;
}

export interface ProjectListItem {
    name: string;
    dir: string;
    workflow?: string;
    activeNode?: string;
    activeContext?: string;
    updatedAt?: string;
    error?: string;
}

/** Workflow choice info returned when multiple workflows are available */
export interface WorkflowChoice {
    name: string;
    description: string;
}

// ─── Error Types ───

/** Thrown when the user must choose a workflow */
export class WorkflowSelectionRequired extends Error {
    constructor(public readonly available: WorkflowChoice[]) {
        super(`有 ${available.length} 个可用工作流，请指定 workflow 参数。`);
        this.name = 'WorkflowSelectionRequired';
    }
}

/** Thrown when validation fails (schema, guard, etc.) */
export class ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ValidationError';
    }
}

/** Thrown when a sequential step has unmet prerequisites */
export class StepPrerequisiteError extends Error {
    constructor(
        public readonly stepId: string,
        public readonly missingStepId: string,
        public readonly missingStepName: string,
    ) {
        super(`无法写入步骤 "${stepId}"：前置步骤 "${missingStepId}" (${missingStepName}) 尚未完成。请先完成该步骤。`);
        this.name = 'StepPrerequisiteError';
    }
}
