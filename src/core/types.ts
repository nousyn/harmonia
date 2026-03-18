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

/** Step definition within a doc (for sequential mode) */
export interface DocStepDefinition {
    /** Step ID, e.g. "requirements", "draft", "final" */
    id: string;
    /** Human-readable name */
    name: string;
    /** Output format for this step's artifact */
    format: 'json' | 'md';
    /** Description shown to agent */
    description: string;
}

export interface DocDefinition {
    name: string;
    scale: Record<ProjectScale, DocScale>;
    /** File format: "md" (default) or "html" */
    format?: 'md' | 'html';
    /** Whether this doc requires user review/approval after creation */
    review?: boolean;
    /** External output — not managed by write_doc (e.g. code written directly to project dir) */
    external?: boolean;
    /** Sequential steps — when defined and scale >= medium, write_doc requires step parameter */
    steps?: DocStepDefinition[];
}

export interface ScaleDimension {
    small: string | number | boolean;
    medium: string | number | boolean;
    large: string | number | boolean;
}

export interface WorkflowDefinition {
    name: string;
    description: string;
    version?: string;
    author?: string;
    phases: PhaseDefinition[];
    docs: Record<string, DocDefinition>;
    scale_criteria: {
        description: string;
        dimensions: Record<string, ScaleDimension>;
    };
}

// ─── Document Schema (loaded from workflows/<name>/schemas/*.json) ───

/**
 * A required section (heading) in a markdown document.
 * Validation checks that the document contains a heading matching the primary
 * pattern or one of the aliases.
 */
export interface DocSchemaSection {
    /** Primary heading text, e.g. "## 项目概述" */
    heading: string;
    /** Per-scale requirement: true = required, false = optional */
    required: Record<ProjectScale, boolean>;
    /** Alternative heading texts that satisfy this requirement */
    aliases?: string[];
}

/**
 * Schema definition for a document type.
 * Used by write_doc to validate content structure before writing.
 */
export interface DocSchema {
    /** Required sections for markdown documents */
    sections?: DocSchemaSection[];
    /** Required HTML tags for html-format documents (e.g. ["html", "body", "nav"]) */
    htmlTags?: string[];
    /** Required top-level JSON fields (for JSON step artifacts) */
    jsonFields?: DocSchemaJsonField[];
    /** Minimum content length in characters (optional) */
    minLength?: number;
    /** Human-readable guidance for agents — describes content scope and boundaries */
    guidance?: string;
}

/**
 * A required top-level field in a JSON document.
 * Used for validating structured step artifacts.
 */
export interface DocSchemaJsonField {
    /** Field name (top-level key in JSON) */
    field: string;
    /** Per-scale requirement: true = required, false = optional */
    required: Record<ProjectScale, boolean>;
    /** Expected type: "string", "array", "object", "number", "boolean" */
    type?: string;
    /** If type is "array", minimum number of items */
    minItems?: number;
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

export type PhaseStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'review' | 'skipped';
export type ProjectScale = 'small' | 'medium' | 'large';
export type ContextType = 'iteration' | 'patch';

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
    /** Context type: "iteration" for full iterations, "patch" for lightweight patches */
    type: ContextType;
    /** Iteration or patch number this state belongs to */
    iteration: number;
    /** Project scale determined by PM (null until set via project_set_scale) */
    scale: ProjectScale | null;
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

// ─── Sequential Step State (<data_dir>/<project_name>/steps.json) ───

/** Step completion record */
export interface DocStepRecord {
    /** Step ID */
    stepId: string;
    /** When this step was completed */
    completedAt: string;
    /** File path of the step artifact (relative to project data dir) */
    artifactPath: string;
}

/** Per-doc step tracking state */
export interface DocStepState {
    /** Doc ID */
    docId: string;
    /** Completed steps (in order) */
    completedSteps: DocStepRecord[];
    /** Whether the final doc has been written (last step completed + merged) */
    finalized: boolean;
    /** Finalized at timestamp */
    finalizedAt?: string;
}

// ─── Issue Tracking (<data_dir>/<project_name>/issues.json) ───

export type IssueStatus = 'open' | 'closed';
export type IssueSource = 'test' | 'user-feedback';

export interface IssueResolvedBy {
    type: ContextType;
    number: number;
}

export interface Issue {
    /** Auto-generated ID, e.g. "issue-1" */
    id: string;
    /** Short title */
    title: string;
    /** Detailed description */
    description: string;
    /** Where this issue was discovered */
    source: IssueSource;
    /** Which iteration this issue relates to */
    iteration: number;
    /** How this issue was resolved (set when closing) */
    resolvedBy?: IssueResolvedBy;
    /** Current status */
    status: IssueStatus;
    /** When this issue was created */
    createdAt: string;
    /** When this issue was closed */
    closedAt?: string;
}
