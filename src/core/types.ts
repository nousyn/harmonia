/**
 * Core type definitions for Harmonia.
 *
 * Architecture: Core provides composable collaboration primitives.
 * Workflow plugins use these primitives to define specific processes.
 *
 * This file defines:
 * - Workflow node types (task, sequence, parallel, gate, loop)
 * - Workflow state (node-based, not phase-based)
 * - Engine types (nextAction, events, gate evaluation)
 * - Artifact system
 * - Plugin interface
 * - Session & Dispatch tracking
 * - Override configuration (simplified to 2-layer)
 * - Sequential step tracking
 * - Issue tracking
 * - Review state
 */

/** Agent type for spawning team member agents (re-exported from @s_s/agent-kit) */
import type { AgentType } from '@s_s/agent-kit';
export type { AgentType };

// ─── Workflow Node Types ───

export type NodeType = 'task' | 'sequence' | 'parallel' | 'gate' | 'loop';

/** Hook configuration for beforeDispatch / afterComplete */
export interface NodeHook {
    /** Extra prompt text to inject */
    inject?: string[];
    /** Registered action names to execute synchronously */
    actions?: string[];
}

/** Failure handler for task and parallel nodes */
export interface FailureHandler {
    /** Target node ID to jump back to (must satisfy ancestor-chain constraint) */
    goto: string;
    /** Max retry count; omit for unlimited */
    maxRetries?: number;
    /** Floating node ID to jump to when retries exhausted */
    onExhausted?: string;
}

/** Goto target for gate fail paths */
export interface GotoTarget {
    /** Target node ID to jump back to */
    goto: string;
    /** Max retry count; omit for unlimited */
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
    /** Artifact IDs this task needs as input (resolved to name + path references at dispatch time) */
    inputArtifacts?: string[];
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

// ─── Gate Types ───

/** Gate condition types */
export interface ArtifactExistsCondition {
    type: 'artifact_exists';
    /** Artifact ID to check */
    artifact: string;
}

export interface ArtifactApprovedCondition {
    type: 'artifact_approved';
    /** Artifact ID to check */
    artifact: string;
}

export type ArtifactFieldOperator = 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'in';

export interface ArtifactFieldCondition {
    type: 'artifact_field';
    /** Artifact ID to check */
    artifact: string;
    /** Field path within the artifact */
    field: string;
    /** Comparison operator */
    operator: ArtifactFieldOperator;
    /** Expected value */
    value: unknown;
}

export type GateCondition = ArtifactExistsCondition | ArtifactApprovedCondition | ArtifactFieldCondition;

/** Gate node — condition check with pass/fail paths */
export interface GateNode {
    type: 'gate';
    id: string;
    /** All conditions must be met for pass */
    conditions: GateCondition[];
    /** Path when all conditions pass (inline node) */
    pass: WorkflowNode;
    /** Path when conditions fail — inline node or goto */
    fail: WorkflowNode | GotoTarget;
}

/** Loop node — repeated execution of a sub-workflow with iteration state */
export interface LoopNode {
    type: 'loop';
    id: string;
    /** Maximum iterations (safety cap) */
    maxIterations: number;
    /** The sub-workflow to repeat each iteration */
    body: WorkflowNode;
    /** Optional failure handler */
    onFailed?: FailureHandler;
}

/** Union of all workflow node types */
export type WorkflowNode = TaskNode | SequenceNode | ParallelNode | GateNode | LoopNode;

// ─── Workflow Definition (workflow.json root) ───

/** Complete workflow definition loaded from workflow.json */
export interface WorkflowDefinition {
    name: string;
    description: string;
    version?: string;
    /** Author of this workflow */
    author?: string;
    /**
     * Coordinator role ID — every workflow must have one.
     *
     * In the orchestrator architecture, the coordinator is the "user communication
     * bridge" rather than the "flow driver" (Orchestrator handles flow driving).
     * The Orchestrator uses this field to identify which connected agent is the
     * coordinator for push-targeting (approval requests, status notifications, etc.).
     */
    coordinator: string;
    /** Root node of the workflow tree */
    root: WorkflowNode;
    /** Standalone nodes referenced by onExhausted/onFailed */
    floatingNodes?: TaskNode[];
}

// ─── Artifact System ───

/** Step definition within an artifact (for sequential mode) */
export interface ArtifactStepDefinition {
    /** Step ID, e.g. "requirements", "draft", "final" */
    id: string;
    /** Human-readable name */
    name: string;
    /** Output format for this step */
    format: 'json' | 'md';
    /** Description shown to agent */
    description: string;
}

/** Artifact definition — metadata for an artifact type */
export interface ArtifactDefinition {
    /** Human-readable name */
    name: string;
    /** File format: "md" (default), "html", or "json" */
    format?: 'md' | 'html' | 'json';
    /** Whether this artifact requires user review/approval */
    review?: boolean;
    /**
     * Validation strategy for agent-produced artifacts.
     * When undefined, defaults to `{ type: 'none' }`.
     */
    validation?: ValidationConfig;
    /**
     * Output directory template using placeholders:
     * - `{global}` → `<data_dir>/<project>/iter-N/artifacts/`
     * - `{project}` → `<projectDir>/`
     * - `{context}` → `iter-N` or `patch-N` (must follow `{global}` or `{project}`)
     *
     * When undefined, defaults to `{global}` behavior.
     * File name is always `<artifactId>.<ext>` — output only controls the directory.
     */
    output?: string;
    /** Sequential steps — when defined, artifact write requires step parameter */
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
    /** Required top-level JSON fields */
    jsonFields?: ArtifactSchemaJsonField[];
    /** Minimum content length in characters */
    minLength?: number;
    /** Human-readable guidance for agents */
    guidance?: string;
}

// ─── Role Definition (loaded from workflows/<name>/roles/*.md) ───

export interface RoleCapability {
    /** Unique ID for this capability */
    id: string;
    /** Human-readable description */
    description: string;
    /** Associated artifact ID — if set, this capability produces this artifact */
    artifact?: string;
}

export interface RoleFrontmatter {
    model?: string;
    session: 'none' | 'persistent' | 'optional';
    parallel: boolean;
    agent?: string;
    /** Capabilities this role provides (used by override system) */
    capabilities?: RoleCapability[];
}

export interface RoleDefinition {
    id: string;
    frontmatter: RoleFrontmatter;
    prompt: string;
}

// ─── Workflow State (runtime, stored in state.json) ───

export type NodeStatus = 'pending' | 'active' | 'completed' | 'failed' | 'cancelled' | 'skipped';
export type ContextType = 'iteration' | 'patch';

/** Runtime state of a single node */
export interface NodeState {
    /** Node ID (matches definition) */
    id: string;
    /** Current status */
    status: NodeStatus;
    /** Number of times this node has been retried (0 = first execution) */
    retryCount: number;
    /** When this node became active */
    startedAt?: string;
    /** When this node completed (or failed) */
    completedAt?: string;
    /** Error message if failed */
    error?: string;
}

/** Runtime state for loop nodes (extends NodeState) */
export interface LoopNodeState extends NodeState {
    /** Current iteration index (0-based) */
    currentIteration: number;
    /** Whether loop_done has been called — loop will terminate after current iteration completes */
    done: boolean;
}

/** Complete workflow state (persisted in state.json) */
export interface WorkflowState {
    /** Project name (unique identifier) */
    projectName: string;
    /** Absolute path to the project source directory */
    projectDir: string;
    /** Workflow plugin name, e.g. "dev" */
    workflow: string;
    /** Context type: iteration or patch */
    type: ContextType;
    /** Iteration or patch number */
    iteration: number;
    /** Currently active node ID (null when workflow is completed or not started) */
    activeNodeId: string | null;
    /** State of every node, keyed by node ID */
    nodes: Record<string, NodeState>;
    /** Timestamp of state initialization */
    createdAt: string;
    /** Last updated timestamp */
    updatedAt: string;
    /** Optional metadata (e.g. patch description, linked issue) */
    meta?: Record<string, unknown>;
}

// ─── Engine Types (nextAction, events, gate evaluation) ───

/** Per-condition evaluation detail */
export interface GateConditionResult {
    /** The condition that was evaluated */
    condition: GateCondition;
    /** Whether the condition was met */
    met: boolean;
    /** Actual value found (for artifact_field conditions) */
    actualValue?: unknown;
}

/** Gate evaluation result */
export interface GateEvaluationResult {
    /** Whether all conditions passed */
    passed: boolean;
    /** Per-condition evaluation details */
    conditions: GateConditionResult[];
}

/** nextAction type — tells the coordinator what to do next */
export type NextActionType =
    | 'dispatch'
    | 'write_artifact'
    | 'approve_artifact'
    | 'wait'
    | 'completed'
    | 'failed'
    | 'evaluate_gate'
    | 'none';

/** Unified nextAction return structure */
export interface NextAction {
    /** What the coordinator should do */
    type: NextActionType;
    /** Target node ID (if applicable) */
    nodeId?: string;
    /** Role to dispatch (if type is 'dispatch') */
    role?: string;
    /** Human-readable instructions for the coordinator */
    instructions: string;
    /** Fully assembled prompt for the team member (if dispatching) */
    rolePrompt?: string;
    /** Gate evaluation results (if coming from a gate fail/goto) */
    gateResults?: GateEvaluationResult;
    /** Parallel dispatch targets (when dispatching multiple tasks simultaneously) */
    parallelDispatch?: Array<{ nodeId: string; role: string }>;
}

/** Events that trigger engine state transitions */
export type WorkflowEvent =
    | { type: 'node_completed'; nodeId: string; result?: unknown }
    | { type: 'node_failed'; nodeId: string; error: string }
    | { type: 'artifact_written'; artifactId: string }
    | { type: 'artifact_approved'; artifactId: string }
    | { type: 'dispatch_requested'; nodeId: string }
    | { type: 'query_status' }
    | { type: 'loop_done'; nodeId: string };

// ─── Action System (node hooks) ───

/** Context passed to action handlers */
export interface ActionContext {
    /** Current node ID */
    nodeId: string;
    /** Current node's role */
    role: string;
    /** Current retry count (0 = first execution) */
    retryCount: number;
    /** Project name */
    projectName: string;
    /** Plugin-specific configuration (opaque to Core) */
    pluginConfig: unknown;
    /** Gate evaluation results (if arriving via goto from gate fail) */
    gateResults?: GateEvaluationResult;
    /** Current workflow state snapshot */
    workflowState: WorkflowState;
    /** Artifact access API */
    artifacts: {
        read: (artifactId: string) => Promise<string>;
        list: () => Promise<string[]>;
    };
    /** Task completion result (only in afterComplete) */
    taskResult?: unknown;
    /** Current loop iteration index (0-based), only set when task is inside a loop */
    loopIteration?: number;
}

/** Return value from action handlers */
export interface ActionResult {
    /** Dynamic prompt text to inject */
    inject?: string[];
    /** Additional data to pass downstream */
    data?: unknown;
}

/** Action handler function signature */
export type ActionHandler = (context: ActionContext) => Promise<ActionResult>;

// ─── Plugin Interface ───

/** Hook creator function signature */
export type HookCreator = (agentType: AgentType, context: HookCreatorContext) => unknown;

/** Context passed to plugin's createHooks function */
export interface HookCreatorContext {
    /** defineHooks function from agent-kit */
    defineHooks: unknown;
    /** Harmonia data directory */
    dataDir: string;
    /** Project name */
    projectName: string;
}

/** Complete loaded workflow plugin */
export interface WorkflowPlugin {
    /** Plugin name (matches workflow name) */
    name: string;
    /** Workflow tree definition */
    definition: WorkflowDefinition;
    /** Role definitions keyed by role ID */
    roles: Record<string, RoleDefinition>;
    /** Artifact schemas keyed by artifact ID */
    artifactSchemas: Record<string, ArtifactSchema>;
    /** Artifact definitions keyed by artifact ID */
    artifactDefinitions: Record<string, ArtifactDefinition>;
    /** Registered actions (from tools/index.js) */
    actions?: Record<string, ActionHandler>;
    /** Hook creator (from hooks/index.js) */
    hooks?: HookCreator;
    /** Plugin-specific configuration (from config.json) */
    config?: unknown;
    /** Filesystem path to the plugin directory */
    pluginDir: string;
}

/** Plugin entry in config.json */
export interface PluginEntry {
    /** Workflow name */
    name?: string;
    /** Filesystem path to the plugin directory */
    path: string;
    /** Plugin-specific configuration */
    config?: unknown;
}

/** Global config.json structure */
export interface GlobalConfig {
    /** Registered workflow plugins */
    workflows: Record<string, PluginEntry>;
}

// ─── Review State (<data_dir>/<project>/reviews.json) ───

export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export interface ReviewState {
    /** Artifact ID */
    artifactId: string;
    status: ReviewStatus;
    submittedAt: string;
    reviewedAt?: string;
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
    /** Coordinator-defined label */
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
    /** Node ID this dispatch is for */
    nodeId?: string;
    /** Expected output artifact IDs from this dispatch */
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

// ─── Override Configuration (simplified to 2-layer) ───

/**
 * Override tool type — describes where the agent should find a tool.
 * - `'skill'` — a built-in skill tool available to the agent
 * - `'mcp'`   — a tool exposed by an MCP server the agent is connected to
 *
 * Note: This is a prompt-level concept — it tells the agent which tool to use.
 * It does NOT imply that Harmonia itself is or acts as an MCP server.
 */
export type OverrideToolType = 'skill' | 'mcp';

export interface CapabilityOverride {
    /** Tool source type */
    type: OverrideToolType;
    /** Tool name */
    tool: string;
    /** MCP server name (required when type is "mcp") */
    server?: string;
    /** Static parameters to always pass */
    params?: Record<string, unknown>;
    /** Additional notes for prompt generation */
    notes?: string;
}

/** Per-role override configuration */
export interface RoleOverride {
    /** Agent type to use for this role */
    agent?: AgentType;
    /** Model to use (overrides role's default) */
    model?: string;
    /** Capability overrides */
    capabilities?: Record<string, CapabilityOverride>;
}

/**
 * Override configuration (project-level only, no global layer).
 * Merges: project-level > workflow defaults.
 */
export interface OverrideConfig {
    /** Review overrides — global toggle or per-artifact */
    review?: boolean | Record<string, boolean>;
    /** Role overrides (agent, model, capabilities) */
    roles?: Record<string, RoleOverride>;
}

// ─── Sequential Step State ───

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

// ─── Issue Tracking ───

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
        | 'invalid_artifact_output'
        | 'invalid_input_artifact'
        | 'other';
    /** Human-readable error message */
    message: string;
    /** Node ID where the error was found (if applicable) */
    nodeId?: string;
}

// ─── Orchestrator Types (added for orchestrator refactor) ───

/**
 * Artifact validation strategy.
 * - `schema`  — JSON Schema validation (reuses existing schema system)
 * - `command` — Run a custom validation command
 * - `none`    — No validation (default)
 */
export type ValidationConfig = { type: 'schema' } | { type: 'command'; command: string } | { type: 'none' };

/** Status of a connected agent */
export type AgentStatus = 'running' | 'idle' | 'exited' | 'unreachable';

/**
 * Task payload dispatched to an agent via an adapter.
 *
 * `prompt` is the fully assembled prompt built by PromptBuilder (Phase 1.7),
 * containing role instructions + context artifacts + output expectations.
 * This differs from the `description` field in the 003 adapter draft — the
 * adapter receives a ready-to-use prompt, not a raw task description.
 */
export interface TaskPayload {
    /** Workflow node that triggered this dispatch */
    nodeId: string;
    /** Role assigned to this task */
    role: string;
    /** Fully assembled prompt (built by PromptBuilder) */
    prompt: string;
    /** Artifact IDs/paths the agent should read as context */
    inputArtifacts: string[];
    /** Expected output artifact definitions */
    outputExpectations: ArtifactDefinition[];
    /** Additional constraints (e.g. coding standards, format rules) */
    constraints?: string;
    /** Timeout in seconds (from TaskNode.timeout or global default) */
    timeout?: number;
}

/** Result returned by an agent after completing a dispatched task */
export interface TaskResult {
    /** Whether the task succeeded or failed */
    status: 'completed' | 'failed';
    /** Artifact IDs produced by the agent */
    artifacts: string[];
    /** Error message if status is 'failed' */
    error?: string;
    /** Adapter-specific metadata (e.g. exit code, duration) */
    metadata?: Record<string, unknown>;
}
