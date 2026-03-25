/**
 * PromptBuilder — assembles the complete prompt for agent dispatch.
 *
 * Extracted from src/tools/role-dispatch.ts for use by the Orchestrator.
 * Produces the `TaskPayload.prompt` field: a ready-to-use prompt containing
 * role instructions + context artifacts + output expectations.
 *
 * Key differences from the old role_dispatch tool:
 * - No dispatch tracking or session guidance (handled by Orchestrator)
 * - Focuses purely on prompt content assembly
 * - Supports Q5 strategy: default full content, large files get path reference
 */

import { readArtifact, listArtifacts, resolveArtifactDir } from './artifacts.js';
import type { ArtifactIOContext } from './artifacts.js';
import { getMergedOverrides, resolveRoleConfig } from './overrides.js';
import { loadArtifactSchema, formatSchemaGuidance } from './schema.js';
import type { StepSchemaEntry } from './schema.js';
import { buildOverrideSection } from './engine-helpers.js';
import { collectTaskNodes, findAncestorLoopId } from './tree-utils.js';
import {
    type TaskNode,
    type WorkflowPlugin,
    type WorkflowState,
    type ActionContext,
    type LoopNodeState,
    type ArtifactDefinition,
    type RoleDefinition,
} from './types.js';

// ─── Constants ───

/**
 * Content size threshold (in characters) for switching from inline content
 * to path reference. Per Q5 decision: default full content, large files get path.
 */
const LARGE_CONTENT_THRESHOLD = 50_000;

// ─── Types ───

/** A resolved input artifact reference */
export interface InputReference {
    /** Artifact ID */
    id: string;
    /** Human-readable name from artifact definition */
    name: string;
    /** Resolved file path (dir + artifactId + extension) */
    path: string;
    /** Whether this artifact was found on disk */
    found: boolean;
    /** Full content (loaded when available and below size threshold) */
    content?: string;
}

/** Options for building a prompt */
export interface PromptBuildOptions {
    /** Project name */
    projectName: string;
    /** Role ID to build prompt for */
    role: string;
    /** Task description — what the agent needs to do */
    taskBrief: string;
    /** Target workflow node */
    targetNode: TaskNode;
    /** Loaded workflow plugin */
    wf: WorkflowPlugin;
    /** Current workflow state */
    state: WorkflowState;
    /** Artifact I/O context for path resolution */
    ioCtx: ArtifactIOContext;
    /** Workflows directory (for schema loading) */
    workflowsDir: string;
    /** Additional input artifact IDs (merged with node-level declaration) */
    additionalInputIds?: string[];
    /**
     * Whether to load full artifact content into the prompt.
     * When true (default), artifacts below LARGE_CONTENT_THRESHOLD are inlined.
     * When false, only path references are included.
     */
    inlineContent?: boolean;
}

/** Result of prompt building */
export interface PromptBuildResult {
    /** The fully assembled prompt string */
    prompt: string;
    /** Resolved input references (for TaskPayload.inputArtifacts) */
    inputRefs: InputReference[];
    /** Output artifact definitions relevant to this role */
    outputArtifacts: ArtifactDefinition[];
    /** Resolved model (override > frontmatter) */
    model?: string;
    /** Resolved agent (override > frontmatter) */
    agent?: string;
}

// ─── Utility Functions ───

/**
 * Get file extension from artifact definition format.
 * - 'html' → '.html'
 * - 'json' → '.json'
 * - 'md' or undefined → '.md'
 */
export function getFormatExtension(format?: 'md' | 'html' | 'json'): string {
    switch (format) {
        case 'html':
            return '.html';
        case 'json':
            return '.json';
        default:
            return '.md';
    }
}

/**
 * Find task nodes for a given role that are active or pending.
 */
export function findDispatchableNodes(wf: WorkflowPlugin, state: WorkflowState, role: string): TaskNode[] {
    const allTasks = collectTaskNodes(wf.definition.root);
    if (wf.definition.floatingNodes) {
        allTasks.push(...wf.definition.floatingNodes);
    }
    return allTasks.filter((t) => {
        if (t.role !== role) return false;
        const nodeState = state.nodes[t.id];
        return nodeState && (nodeState.status === 'active' || nodeState.status === 'pending');
    });
}

/**
 * Resolve an artifact ID to a name + path reference.
 *
 * All artifacts resolve to a full file path: directory + artifactId + extension.
 * Unknown artifacts return not-found.
 */
export function resolveInputReference(
    artifactId: string,
    wf: WorkflowPlugin,
    ioCtx: ArtifactIOContext,
    existingArtifacts: Set<string>,
): InputReference {
    const artifactDef = wf.artifactDefinitions[artifactId];
    if (!artifactDef) {
        return {
            id: artifactId,
            name: artifactId,
            path: '',
            found: false,
        };
    }

    const dir = resolveArtifactDir(artifactDef.output, ioCtx);
    const ext = getFormatExtension(artifactDef.format);
    const filePath = `${dir}/${artifactId}${ext}`;

    return {
        id: artifactId,
        name: artifactDef.name,
        path: filePath,
        found: existingArtifacts.has(artifactId),
    };
}

// ─── Hook Execution ───

/**
 * Execute beforeDispatch hooks and collect prompt injections.
 *
 * Handles both static `inject` text and dynamic `actions` handlers.
 * Extracted from role-dispatch.ts lines 398-448.
 */
async function executeBeforeDispatchHooks(
    targetNode: TaskNode,
    wf: WorkflowPlugin,
    state: WorkflowState,
    role: string,
    projectName: string,
    ioCtx: ArtifactIOContext,
): Promise<string[]> {
    const hookInjections: string[] = [];

    if (!targetNode.beforeDispatch) return hookInjections;

    // Collect static inject text
    if (targetNode.beforeDispatch.inject) {
        hookInjections.push(...targetNode.beforeDispatch.inject);
    }

    // Execute registered actions
    if (targetNode.beforeDispatch.actions && wf.actions) {
        const nodeState = state.nodes[targetNode.id];

        // Resolve loopIteration: find ancestor loop node and read its current iteration
        let loopIteration: number | undefined;
        const ancestorLoopId = findAncestorLoopId(wf.definition.root, targetNode.id);
        if (ancestorLoopId) {
            const loopState = state.nodes[ancestorLoopId] as LoopNodeState | undefined;
            if (loopState) {
                loopIteration = loopState.currentIteration;
            }
        }

        const actionCtx: ActionContext = {
            nodeId: targetNode.id,
            role,
            retryCount: nodeState?.retryCount ?? 0,
            projectName,
            pluginConfig: wf.config,
            workflowState: state,
            artifacts: {
                read: (artifactId: string) => readArtifact(artifactId, ioCtx, wf.artifactDefinitions[artifactId]),
                list: () => listArtifacts(ioCtx, wf.artifactDefinitions),
            },
            loopIteration,
        };

        for (const actionName of targetNode.beforeDispatch.actions) {
            const handler = wf.actions[actionName];
            if (handler) {
                try {
                    const result = await handler(actionCtx);
                    if (result.inject) {
                        hookInjections.push(...result.inject);
                    }
                } catch (err) {
                    console.warn(`[harmonia] beforeDispatch action "${actionName}" failed:`, err);
                }
            } else {
                console.warn(`[harmonia] beforeDispatch action "${actionName}" not registered`);
            }
        }
    }

    return hookInjections;
}

// ─── Artifact Requirements ───

/**
 * Build Artifact Requirements section for the prompt.
 * Only includes schemas for artifacts associated with the dispatched role
 * (via the role's capabilities).
 *
 * Extracted from role-dispatch.ts lines 222-272.
 */
async function buildArtifactRequirements(
    wf: WorkflowPlugin,
    workflowsDir: string,
    workflowName: string,
    role: string,
): Promise<string> {
    const artifactDefs = wf.artifactDefinitions;

    // Extract artifact IDs from role capabilities
    const roleDef = wf.roles[role];
    const roleArtifactIds = new Set<string>();
    if (roleDef?.frontmatter.capabilities) {
        for (const cap of roleDef.frontmatter.capabilities) {
            if (cap.artifact) {
                roleArtifactIds.add(cap.artifact);
            }
        }
    }

    if (roleArtifactIds.size === 0) return '';

    const sections: string[] = [];

    for (const artifactId of roleArtifactIds) {
        const artifactDef = artifactDefs[artifactId];
        if (!artifactDef) continue;

        // Load main schema
        const schema = await loadArtifactSchema(workflowsDir, workflowName, artifactId);

        // Load step schemas if artifact has steps
        let stepSchemas: StepSchemaEntry[] | undefined;
        if (artifactDef.steps && artifactDef.steps.length > 0) {
            stepSchemas = [];
            for (const step of artifactDef.steps) {
                const stepSchema = await loadArtifactSchema(workflowsDir, workflowName, `${artifactId}.${step.id}`);
                stepSchemas.push({ step, schema: stepSchema });
            }
        }

        // Skip if no schema at all
        if (!schema && (!stepSchemas || stepSchemas.every((s) => !s.schema))) continue;

        sections.push(formatSchemaGuidance(artifactId, artifactDef, schema, stepSchemas));
    }

    if (sections.length === 0) return '';

    return ['## Artifact Requirements', '', ...sections].join('\n');
}

// ─── Output Path Resolution ───

/**
 * Collect output artifact definitions relevant to a role (via capabilities).
 */
function collectRoleOutputArtifacts(
    roleDef: RoleDefinition,
    artifactDefs: Record<string, ArtifactDefinition>,
): Array<{ id: string; def: ArtifactDefinition }> {
    const results: Array<{ id: string; def: ArtifactDefinition }> = [];
    if (!roleDef.frontmatter.capabilities) return results;

    for (const cap of roleDef.frontmatter.capabilities) {
        if (!cap.artifact) continue;
        const def = artifactDefs[cap.artifact];
        if (def) {
            results.push({ id: cap.artifact, def });
        }
    }
    return results;
}

/**
 * Build output path hints for the prompt.
 * All artifacts use unified path resolution: directory + artifactId + extension.
 */
function buildOutputPaths(
    roleDef: RoleDefinition,
    artifactDefs: Record<string, ArtifactDefinition>,
    ioCtx: ArtifactIOContext,
): string[] {
    const paths: string[] = [];
    for (const cap of roleDef.frontmatter.capabilities ?? []) {
        if (!cap.artifact) continue;
        const def = artifactDefs[cap.artifact];
        if (!def) continue;
        const dir = resolveArtifactDir(def.output, ioCtx);
        const ext = getFormatExtension(def.format);
        const filePath = `${dir}/${cap.artifact}${ext}`;
        paths.push(`- **${cap.artifact}** (${def.name}): \`${filePath}\``);
    }
    return paths;
}

// ─── Input Content Loading ───

/**
 * Load input artifact content for inline inclusion in the prompt.
 * Applies the Q5 strategy: inline content for small files, path reference for large ones.
 */
async function loadInputContent(
    ref: InputReference,
    wf: WorkflowPlugin,
    ioCtx: ArtifactIOContext,
): Promise<InputReference> {
    if (!ref.found) return ref;

    const artifactDef = wf.artifactDefinitions[ref.id];

    try {
        const content = await readArtifact(ref.id, ioCtx, artifactDef);
        if (content.length <= LARGE_CONTENT_THRESHOLD) {
            return { ...ref, content };
        }
        // Large file — keep as path reference only
        return ref;
    } catch {
        // Failed to read — keep as path reference
        return ref;
    }
}

// ─── Main Builder ───

/**
 * Build a complete prompt for dispatching a task to an agent.
 *
 * Assembles:
 * 1. Role system prompt (from roles/*.md)
 * 2. Override capability injections
 * 3. beforeDispatch hook injections
 * 4. Task brief
 * 5. Project context (project name, directory, workflow)
 * 6. Input artifact references (with optional inline content per Q5)
 * 7. Output artifact paths and requirements
 * 8. Artifact schema guidance
 *
 * The resulting prompt is ready to be used as `TaskPayload.prompt`.
 */
export async function buildPrompt(options: PromptBuildOptions): Promise<PromptBuildResult> {
    const {
        projectName,
        role,
        taskBrief,
        targetNode,
        wf,
        state,
        ioCtx,
        workflowsDir,
        additionalInputIds,
        inlineContent = true,
    } = options;

    const roleDef = wf.roles[role];
    if (!roleDef) {
        throw new Error(`Role "${role}" not found. Available: ${Object.keys(wf.roles).join(', ')}`);
    }

    // ── 1. Role prompt + overrides ──
    const overrides = await getMergedOverrides(projectName);
    const overrideSection = buildOverrideSection(role, overrides);
    let rolePrompt = overrideSection ? `${roleDef.prompt}\n${overrideSection}` : roleDef.prompt;

    // ── 2. Hook injections ──
    const hookInjections = await executeBeforeDispatchHooks(targetNode, wf, state, role, projectName, ioCtx);
    if (hookInjections.length > 0) {
        rolePrompt += '\n\n' + hookInjections.join('\n\n');
    }

    // ── 3. Resolve input artifact references ──
    const nodeInputIds = targetNode.inputArtifacts ?? [];
    const paramInputIds = additionalInputIds ?? [];
    const mergedInputIds = [...new Set([...nodeInputIds, ...paramInputIds])];

    const existingArtifacts = new Set(await listArtifacts(ioCtx, wf.artifactDefinitions));

    let inputRefs: InputReference[] = mergedInputIds.map((id) =>
        resolveInputReference(id, wf, ioCtx, existingArtifacts),
    );

    // Load inline content if requested
    if (inlineContent) {
        inputRefs = await Promise.all(inputRefs.map((ref) => loadInputContent(ref, wf, ioCtx)));
    }

    const foundRefs = inputRefs.filter((r) => r.found);
    const missingRefs = inputRefs.filter((r) => !r.found);

    // ── 4. Resolve agent/model config ──
    const roleConfig = resolveRoleConfig(role, overrides);
    const model = roleConfig.model ?? roleDef.frontmatter.model;
    const agent = roleConfig.agent ?? roleDef.frontmatter.agent;

    // ── 5. Build artifact requirements ──
    const artifactRequirements = await buildArtifactRequirements(wf, workflowsDir, state.workflow, role);

    // ── 6. Collect output artifact definitions ──
    const outputArtifactEntries = collectRoleOutputArtifacts(roleDef, wf.artifactDefinitions);
    const outputArtifacts = outputArtifactEntries.map((e) => e.def);

    // ── 7. Assemble the prompt ──
    const sections: string[] = [];

    // Role system prompt (including overrides and hooks)
    sections.push(rolePrompt);

    // Task brief
    sections.push('');
    sections.push('## Task');
    sections.push('');
    sections.push(taskBrief);

    // Project context
    sections.push('');
    sections.push('## Project Context');
    sections.push(`- Project: ${projectName}`);
    sections.push(`- Directory: ${state.projectDir}`);
    sections.push(`- Workflow: ${state.workflow}`);
    sections.push(`- Node: ${targetNode.id}`);

    // Input references
    if (foundRefs.length > 0 || missingRefs.length > 0) {
        sections.push('');
        sections.push(
            `## Input Artifacts (${foundRefs.length}${missingRefs.length > 0 ? `, ${missingRefs.length} missing` : ''})`,
        );

        for (const ref of foundRefs) {
            if (ref.content) {
                // Inline content (Q5: small files)
                sections.push('');
                sections.push(`### ${ref.id} (${ref.name})`);
                sections.push(`Path: \`${ref.path}\``);
                sections.push('');
                sections.push(ref.content);
            } else {
                // Path reference only (Q5: large files or agent-direct)
                sections.push(`- **${ref.id}** (${ref.name}): \`${ref.path}\``);
            }
        }

        if (missingRefs.length > 0) {
            sections.push('');
            sections.push('### Missing');
            for (const ref of missingRefs) {
                sections.push(`- **${ref.id}** (${ref.name}): not found`);
            }
        }
    }

    // Output paths — all artifacts use unified path resolution
    const outputPaths = buildOutputPaths(roleDef, wf.artifactDefinitions, ioCtx);
    if (outputPaths.length > 0) {
        sections.push('');
        sections.push('## Output Paths');
        sections.push('Write the following artifacts directly to the specified paths:');
        sections.push(...outputPaths);
    }

    // Artifact requirements (schema guidance)
    if (artifactRequirements) {
        sections.push('');
        sections.push(artifactRequirements);
    }

    const prompt = sections.join('\n');

    return {
        prompt,
        inputRefs,
        outputArtifacts,
        model,
        agent,
    };
}
