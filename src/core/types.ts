/**
 * Core type definitions for Harmonia.
 *
 * Architecture: Core provides generic collaboration primitives.
 * Workflow plugins use these primitives to define specific processes.
 *
 * Key concepts:
 * - WorkflowNode: tree-structured workflow definition (task/sequence/parallel/gate)
 * - WorkflowState: runtime node states
 * - NextAction: unified return structure telling coordinator what to do next
 * - Artifact: generic output unit (replaces "doc")
 * - Plugin: workflow plugin interface
 */

// ─── Re-exports ───

/** Agent type for spawning team member agents (re-exported from @s_s/agent-kit) */
import type { AgentType } from '@s_s/agent-kit';
export type { AgentType };

// ─── Workflow Node Types (workflow.json tree structure) ───

export type NodeType = 'task' | 'sequence' | 'parallel' | 'gate';

/** Hook configuration for task nodes (beforeDispatch / afterComplete) */
export interface NodeHook {
    /** Extra prompt text to inject */
    inject?: string[];
    /** Registered action names to execute synchronously */
    actions?: string[];
}

/** Failure handler for task and parallel nodes */
export interface FailureHandler {
    /** Node ID to jump back to */
    goto: string;
    /** Max retry attempts (undefined = infinite) */
    maxRetries?: number;
    /** Floating node ID to jump to when retries exhausted */
    onExhausted?: string;
}

/** Goto target for gate fail paths */
export interface GotoTarget {
    /** Node ID to jump back to */
    goto: string;
    /** Max retry attempts (undefined = infinite) */
    maxRetries?: number;
    /** Floating node ID to jump to when retries exhausted */
    onExhausted?: string;
}

/** Task node — work unit assigned to a role */
export interface TaskNode {
    type: 'task';
    id: string;
    /** Role ID that executes this task */
    role: string;
    /** Optional timeout in seconds */
    timeout?: number;
    /** Optional failure handler */
    onFailed?: FailureHandler;
    /** Hook before dispatching to role */
    beforeDispatch?: NodeHook;
    /** Hook after task completion */
    afterComplete?: NodeHook;
}

/** Sequence node — children execute in order */
export interface SequenceNode {
    type: 'sequence';
    id: string;
    children: WorkflowNode[];
}

/** Parallel node — children execute simultaneously */
export interface ParallelNode {
    type: 'parallel';
    id: string;
    /** Required: how to handle child failures */
    failStrategy: 'fail-fast' | 'wait-all';
    children: WorkflowNode[];
    /** Optional failure handler */
    onFailed?: FailureHandler;
}

// ─── Gate Conditions ───

/** Condition types for gate evaluation */
export type GateConditionType = 'artifact_exists' | 'artifact_approved' | 'artifact_field';

/** Operators for artifact_field conditions */
export type FieldOperator = 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'in';

/** Base gate condition */
interface GateConditionBase {
    type: GateConditionType;
    /** Artifact ID to check */
    artifact: string;
}

/** Check if an artifact has been written */
export interface ArtifactExistsCondition extends GateConditionBase {
    type: 'artifact_exists';
}

/** Check if an artifact has been approved */
export interface ArtifactApprovedCondition extends GateConditionBase {
    type: 'artifact_approved';
}

/** Check a field value within an artifact */
export interface ArtifactFieldCondition extends GateConditionBase {
    type: 'artifact_field';
    /** Field path within the artifact (top-level key) */
    field: string;
    /** Comparison operator */
    operator: FieldOperator;
    /** Expected value */
    value: unknown;
}

export type GateCondition = ArtifactExistsCondition | ArtifactApprovedCondition | ArtifactFieldCondition;

/** Gate node — condition check with pass/fail paths */
export interface GateNode {
    type: 'gate';
    id: string;
    /** Conditions to evaluate (all must pass) */
    conditions: GateCondition[];
    /** Node to activate when all conditions pass */
    pass: WorkflowNode;
    /** Node to activate or goto target when conditions fail */
    fail: WorkflowNode | GotoTarget;
}

/** Union of all workflow node types */
export type WorkflowNode = TaskNode | SequenceNode | ParallelNode | GateNode;

// ─── Workflow Definition (workflow.json root) ───

export interface WorkflowDefinition {
    /** Workflow name, e.g. "dev" */
    name: string;
    /** Human-readable description */
    description: string;
    /** Semver version */
    version?: string;
    /** Author */
    author?: string;
    /** Coordinator role ID — the role that talks to users and drives the workflow */
    coordinator: string;
    /** Root node of the workflow tree */
    root: WorkflowNode;
    /** Floating nodes — independent nodes referenced by onExhausted/onFailed */
    floatingNodes?: TaskNode[];
}

// ─── Gate Evaluation Result ───

export interface GateConditionResult {
    /** The condition that was evaluated */
    condition: GateCondition;
    /** Whether the condition was met */
    met: boolean;
    /** Actual value found (for artifact_field) */
    actualValue?: unknown;
}

export interface GateEvaluationResult {
    /** Whether all conditions passed */
    passed: boolean;
    /** Per-condition evaluation details */
    conditions: GateConditionResult[];
}

// ─── Workflow State (runtime, stored in state.json) ───

export type NodeStatus = 'pending' | 'active' | 'completed' | 'failed' | 'cancelled' | 'skipped';
export type ContextType = 'iteration' | 'patch';

/** Runtime state of a single node */
export interface NodeState {
    /** Node ID (matches WorkflowNode.id) */
    id: string;
    /** Current status */
    status: NodeStatus;
    /** Number of times this node has been retried via goto (0 = first execution) */
    retryCount: number;
    /** When this node was first activated */
    startedAt?: string;
    /** When this node completed or failed */
    completedAt?: string;
    /** Error message if failed */
    error?: string;
}

/** Complete workflow state persisted to state.json */
export interface WorkflowState {
    /** Project name (unique identifier) */
    projectName: string;
    /** Absolute path to the project source directory */
    projectDir: string;
    /** Workflow name, e.g. "dev" */
    workflow: string;
    /** Context type: "iteration" or "patch" */
    type: ContextType;
    /** Iteration or patch number */
    iteration: number;
    /** Currently active node ID (null when workflow is completed or not started) */
    activeNodeId: string | null;
    /** State of all nodes, keyed by node ID */
    nodes: Record<string, NodeState>;
    /** Timestamp of state creation */
    createdAt: string;
    /** Last updated timestamp */
    updatedAt: string;
}

// ─── NextAction (unified return from Core tools) ───

export type NextActionType =
    | 'dispatch'
    | 'write_artifact'
    | 'approve_artifact'
    | 'wait'
    | 'completed'
    | 'evaluate_gate';

export interface NextAction {
    /** What the coordinator should do next */
    type: NextActionType;
    /** Relevant node ID */
    nodeId?: string;
    /** Role to dispatch to (when type='dispatch') */
    role?: string;
    /** Human-readable instructions for the coordinator */
    instructions: string;
    /** Fully assembled prompt for the team member (role prompt + inject + context) */
    rolePrompt?: string;
    /** Artifact IDs the team member should reference */
    inputArtifacts?: string[];
    /** Gate evaluation results (when returning from a gate fail → goto) */
    gateResults?: GateEvaluationResult;
}

// ─── Workflow Events (input to engine) ───

export type WorkflowEvent =
    | { type: 'node_completed'; nodeId: string; result?: unknown }
    | { type: 'node_failed'; nodeId: string; error: string }
    | { type: 'artifact_written'; artifactId: string }
    | { type: 'artifact_approved'; artifactId: string }
    | { type: 'dispatch_requested'; nodeId: string }
    | { type: 'query_status' };

// ─── Action System (node hooks) ───

export interface ActionContext {
    /** Current node ID */
    nodeId: string;
    /** Current node's role */
    role: string;
    /** Current retry count (0 = first execution) */
    retryCount: number;
    /** Project name */
    projectName: string;
    /** Plugin custom configuration (opaque to Core) */
    pluginConfig: unknown;
    /** Gate evaluation result (when node was reached via goto from a gate fail) */
    gateResults?: GateEvaluationResult;
    /** Current workflow state snapshot */
    workflowState: WorkflowState;
    /** Artifact access API */
    artifacts: {
        read: (artifactId: string) => Promise<string>;
        list: () => Promise<string[]>;
    };
    /** Task result (only available in afterComplete hooks) */
    taskResult?: unknown;
}

export interface ActionResult {
    /** Dynamic prompt text to inject into rolePrompt or coordinator instructions */
    inject?: string[];
    /** Additional data to pass to subsequent processing */
    data?: unknown;
}

/** Action handler function signature */
export type ActionHandler = (context: ActionContext) => Promise<ActionResult>;

// ─── Artifact System (replaces "doc") ───

/** Step definition within an artifact (for sequential writing mode) */
export interface ArtifactStepDefinition {
    /** Step ID, e.g. "requirements", "draft", "final" */
    id: string;
    /** Human-readable name */
    name: string;
    /** Output format for this step's artifact */
    format: 'json' | 'md';
    /** Description shown to agent */
    description: string;
}

/** Artifact definition (declared in workflow plugin) */
export interface ArtifactDefinition {
    /** Human-readable name */
    name: string;
    /** File format: "md" (default), "html", or "json" */
    format?: 'md' | 'html' | 'json';
    /** Whether this artifact requires user review/approval */
    review?: boolean;
    /** External output — not managed by artifact_write (e.g. code) */
    external?: boolean;
    /** Sequential steps — when defined, artifact_write requires step parameter */
    steps?: ArtifactStepDefinition[];
}

// ─── Artifact Schema (loaded from workflows/<name>/schemas/*.json) ───

/** A required section (heading) in a markdown artifact */
export interface ArtifactSchemaSection {
    /** Primary heading text, e.g. "## 项目概述" */
    heading: string;
    /** Whether this section is required */
    required: boolean;
    /** Alternative heading texts that satisfy this requirement */
    aliases?: string[];
}

/** A required top-level field in a JSON artifact */
export interface ArtifactSchemaJsonField {
    /** Field name (top-level key in JSON) */
    field: string;
    /** Whether this field is required */
    required: boolean;
    /** Expected type: "string", "array", "object", "number", "boolean" */
    type?: string;
    /** If type is "array", minimum number of items */
    minItems?: number;
}

/** Schema definition for an artifact type */
export interface ArtifactSchema {
    /** Required sections for markdown artifacts */
    sections?: ArtifactSchemaSection[];
    /** Required HTML tags for html-format artifacts */
    htmlTags?: string[];
    /** Required top-level JSON fields (for JSON step artifacts) */
    jsonFields?: ArtifactSchemaJsonField[];
    /** Minimum content length in characters */
    minLength?: number;
    /** Human-readable guidance for agents — describes content scope and boundaries */
    guidance?: string;
}

// ─── Role Definition (loaded from workflows/<name>/roles/*.md) ───

export interface RoleCapability {
    /** Unique ID for this capability */
    id: string;
    /** Human-readable description of what this capability does */
    description: string;
    /** Associated artifact ID — if set, this capability produces this artifact */
    artifact?: string;
}

export interface RoleFrontmatter {
    /** Model level: "low", "medium", "high" */
    model: string;
    /** Session persistence: "none", "persistent", "optional" */
    session: 'none' | 'persistent' | 'optional';
    /** Whether multiple instances can run in parallel */
    parallel: boolean;
    /** Capabilities this role provides (used by override system) */
    capabilities?: RoleCapability[];
}

export interface RoleDefinition {
    /** Role ID (filename without extension) */
    id: string;
    /** Parsed frontmatter */
    frontmatter: RoleFrontmatter;
    /** Role prompt (markdown body) */
    prompt: string;
}

// ─── Review State (<data_dir>/<project>/reviews.json) ───

export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export interface ArtifactReviewState {
    /** Artifact ID */
    artifactId: string;
    /** Current review status */
    status: ReviewStatus;
    /** When submitted for review */
    submittedAt: string;
    /** When reviewed */
    reviewedAt?: string;
    /** Review comment */
    comment?: string;
}

// ─── Session & Dispatch Tracking ───

export type SessionStatus = 'active' | 'idle' | 'closed' | 'lost';

export interface SessionRecord {
    /** Harmonia-generated session ID, e.g. "ses-001" */
    id: string;
    /** Role this session belongs to */
    role: string;
    /** Actual session ID from the host agent */
    agentSessionId?: string;
    /** Agent type used for this session */
    agentType?: AgentType;
    /** Current session status */
    status: SessionStatus;
    /** Coordinator-defined label, e.g. "dev-auth-module" */
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
    /** Associated Harmonia session ID */
    sessionId?: string;
    /** Task description for the dispatched role */
    taskBrief: string;
    /** Current dispatch status */
    status: DispatchStatus;
    /** Expected output artifact IDs from this dispatch */
    expectedOutputs: string[];
    /** Associated workflow node ID */
    nodeId?: string;
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
    /** Additional notes for prompt generation */
    notes?: string;
}

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
 * Override configuration — two-layer merge: project-level > workflow defaults.
 *
 * review: boolean | Record<artifactId, boolean>
 *   - boolean: global toggle for all artifacts
 *   - Record: per-artifact toggle
 *
 * roles: Record<roleId, RoleOverride>
 */
export interface OverrideConfig {
    /** Review overrides — global toggle or per-artifact */
    review?: boolean | Record<string, boolean>;
    /** Role overrides (agent, model, capabilities) */
    roles?: Record<string, RoleOverride>;
}

// ─── Sequential Step State (<data_dir>/<project>/steps.json) ───

/** Step completion record */
export interface ArtifactStepRecord {
    /** Step ID */
    stepId: string;
    /** When this step was completed */
    completedAt: string;
    /** File path of the step artifact (relative to project data dir) */
    artifactPath: string;
}

/** Per-artifact step tracking state */
export interface ArtifactStepState {
    /** Artifact ID */
    artifactId: string;
    /** Completed steps (in order) */
    completedSteps: ArtifactStepRecord[];
    /** Whether the final artifact has been written */
    finalized: boolean;
    /** Finalized at timestamp */
    finalizedAt?: string;
}

// ─── Issue Tracking (<data_dir>/<project>/issues.json) ───

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

// ─── Plugin Interface ───

/** Hook creator function — provided by workflow plugin */
export type HookCreator = (agentType: AgentType, context: HookContext) => unknown;

/** Context passed to plugin's createHooks function */
export interface HookContext {
    /** defineHooks function from agent-kit */
    defineHooks: unknown;
    /** Harmonia data directory */
    dataDir: string;
    /** Current project name */
    projectName: string;
}

/** Plugin registration context (passed to registerActions) */
export interface PluginContext {
    /** Plugin custom configuration (from config.json) */
    pluginConfig: unknown;
    /** Harmonia data directory */
    dataDir: string;
    /** Current project name */
    projectName: string;
}

/** Loaded workflow plugin — everything Core needs to run a workflow */
export interface WorkflowPlugin {
    /** Workflow name */
    name: string;
    /** Parsed workflow definition (node tree) */
    definition: WorkflowDefinition;
    /** Role definitions (keyed by role ID) */
    roles: Record<string, RoleDefinition>;
    /** Artifact schemas (keyed by artifact ID) */
    artifactSchemas: Record<string, ArtifactSchema>;
    /** Artifact definitions (keyed by artifact ID) */
    artifactDefinitions: Record<string, ArtifactDefinition>;
    /** Registered action handlers (keyed by action name) */
    actions: Record<string, ActionHandler>;
    /** Hook creator function (if plugin provides hooks) */
    hookCreator?: HookCreator;
    /** Plugin custom configuration */
    config?: unknown;
    /** Filesystem path to the plugin directory */
    pluginDir: string;
}

/** Plugin entry in config.json */
export interface PluginEntry {
    /** Workflow name */
    name: string;
    /** Filesystem path to the plugin directory */
    path: string;
    /** Plugin custom configuration */
    config?: unknown;
}

/** Global config.json structure */
export interface GlobalConfig {
    /** Registered workflow plugins */
    workflows: Record<string, { path: string; config?: unknown }>;
}

// ─── Validation ───

/** Validation error from workflow validator */
export interface ValidationError {
    /** Error type */
    type:
        | 'duplicate_id'
        | 'invalid_goto'
        | 'cycle'
        | 'missing_fail_strategy'
        | 'invalid_floating_ref'
        | 'invalid_role_ref'
        | 'invalid_coordinator'
        | 'other';
    /** Human-readable error message */
    message: string;
    /** Node ID where the error was found (if applicable) */
    nodeId?: string;
}
