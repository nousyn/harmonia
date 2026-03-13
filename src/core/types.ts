/**
 * Core type definitions for Harmonia.
 * These types are workflow-agnostic — no hardcoded role names or phase names.
 */

// ─── Workflow Definition (loaded from workflows/<name>/) ───

export interface PhaseDefinition {
    id: string;
    name: string;
    roles: string[];
    inputs?: string[];
    outputs: string[];
    description: string;
}

export type DocScale = 'full' | 'lite' | 'skip' | 'optional';

export interface DocDefinition {
    name: string;
    scale: Record<string, DocScale>;
}

export interface ScaleDimension {
    small: string | number | boolean;
    medium: string | number | boolean;
    large: string | number | boolean;
}

export interface WorkflowDefinition {
    name: string;
    description: string;
    phases: PhaseDefinition[];
    docs: Record<string, DocDefinition>;
    scale_criteria: {
        description: string;
        dimensions: Record<string, ScaleDimension>;
    };
}

// ─── Role Definition (loaded from workflows/<name>/roles/*.md) ───

export interface RoleFrontmatter {
    model: string;
    session: 'none' | 'persistent' | 'optional';
    parallel: boolean;
}

export interface RoleDefinition {
    id: string;
    frontmatter: RoleFrontmatter;
    prompt: string;
}

// ─── Loaded Workflow (workflow.json + all roles) ───

export interface LoadedWorkflow {
    definition: WorkflowDefinition;
    roles: Record<string, RoleDefinition>;
}

// ─── Project State (~/.harmonia/<project_name>/state.json) ───

export type PhaseStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';
export type ProjectScale = 'small' | 'medium' | 'large';

export interface PhaseState {
    id: string;
    status: PhaseStatus;
    startedAt?: string;
    completedAt?: string;
    blockedReason?: string;
}

export interface ProjectState {
    /** Project name (unique identifier) */
    projectName: string;
    /** Absolute path to the project source directory */
    projectDir: string;
    /** Workflow name, e.g. "dev" */
    workflow: string;
    /** Project scale determined by PM */
    scale: ProjectScale;
    /** Current phase id */
    currentPhase: string;
    /** State of each phase */
    phases: PhaseState[];
    /** Timestamp of project initialization */
    createdAt: string;
    /** Last updated timestamp */
    updatedAt: string;
}
