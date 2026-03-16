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
    scale: Record<ProjectScale, DocScale>;
    /** File format: "md" (default) or "html" */
    format?: 'md' | 'html';
    /** Whether this doc requires user review/approval after creation */
    review?: boolean;
    /** External output — not managed by write_doc (e.g. code written directly to project dir) */
    external?: boolean;
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

export interface RoleCapability {
    /** Unique ID for this capability */
    id: string;
    /** Human-readable description of what this capability does */
    description: string;
    /** Associated doc ID — if set, this capability produces this document */
    doc?: string;
}

export interface RoleFrontmatter {
    model: string;
    session: 'none' | 'persistent' | 'optional';
    parallel: boolean;
    /** Capabilities this role provides (used by override system) */
    capabilities?: RoleCapability[];
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

// ─── Project State (<data_dir>/<project_name>/state.json) ───

export type PhaseStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'review';
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

// ─── Document Review State (<data_dir>/<project_name>/reviews.json) ───

export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export interface DocReviewState {
    docId: string;
    status: ReviewStatus;
    submittedAt: string;
    reviewedAt?: string;
    comment?: string;
}

// ─── Session & Dispatch Tracking (<data_dir>/<project_name>/sessions.json, dispatches.json) ───

export type SessionStatus = 'active' | 'idle' | 'closed' | 'lost';

export interface SessionRecord {
    /** Harmonia-generated session ID, e.g. "ses-001" */
    id: string;
    /** Role this session belongs to */
    role: string;
    /** Actual session ID from the host agent (e.g. OpenCode session ID) */
    agentSessionId?: string;
    /** Agent type used for this session */
    agentType?: AgentType;
    /** Current session status */
    status: SessionStatus;
    /** PM-defined label, e.g. "dev-auth-module" */
    label?: string;
    /** When this session was created */
    createdAt: string;
    /** When this session was last active */
    lastActiveAt: string;
}

export type DispatchStatus = 'dispatched' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface DispatchRecord {
    /** Auto-incremented dispatch ID, e.g. "dispatch-001" */
    id: string;
    /** Role dispatched */
    role: string;
    /** Associated session ID (set when agent is launched) */
    sessionId?: string;
    /** Task description for the dispatched role */
    taskBrief: string;
    /** Current dispatch status */
    status: DispatchStatus;
    /** Expected output doc IDs from this dispatch */
    expectedOutputs: string[];
    /** When this dispatch was created */
    createdAt: string;
    /** Last updated timestamp */
    updatedAt: string;
    /** When this dispatch was completed */
    completedAt?: string;
    /** Failure reason or notes */
    note?: string;
}

// ─── Override Configuration ───

export type OverrideToolType = 'skill' | 'mcp';

export interface CapabilityOverride {
    /** Tool source type */
    type: OverrideToolType;
    /** Tool name */
    tool: string;
    /** MCP server name (required when type is "mcp") */
    server?: string;
    /** Static parameters to always pass when calling the tool */
    params?: Record<string, unknown>;
    /** Additional notes for prompt generation (rarely needed) */
    notes?: string;
}

/** Agent type for spawning team member agents (re-exported from @s_s/agent-kit) */
import type { AgentType } from '@s_s/agent-kit';
export type { AgentType };

/** Per-role override configuration */
export interface RoleOverride {
    /** Agent type to use for this role */
    agent?: AgentType;
    /** Model to use for this role (overrides the role's default model level) */
    model?: string;
    /** Capability overrides for this role */
    capabilities?: Record<string, CapabilityOverride>;
}

/**
 * Override configuration file structure (<data_dir>/overrides.json or project-level).
 *
 * review: boolean | Record<docId, boolean>
 *   - boolean: global toggle for all docs
 *   - Record: per-doc toggle
 *
 * roles: Record<roleId, RoleOverride>
 *   - agent: agent type for spawning
 *   - model: model override
 *   - capabilities: Record<capabilityId, CapabilityOverride>
 */
export interface OverrideConfig {
    /** Review overrides — global toggle or per-doc */
    review?: boolean | Record<string, boolean>;
    /** Role overrides (agent, model, capabilities) */
    roles?: Record<string, RoleOverride>;
}
