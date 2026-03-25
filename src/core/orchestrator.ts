/**
 * Orchestrator — the "conductor" that drives workflow execution.
 *
 * Combines:
 * - Engine (workflow state machine + EventBus integration)
 * - EventBus (typed event transport)
 * - DispatchManager (dispatch tracking + timeout management)
 * - PromptBuilder (prompt assembly for agent dispatch)
 * - AdapterRegistry (Phase 2 — placeholder interface in Phase 1)
 *
 * Responsibilities:
 * - Listen to EventBus events and react to state transitions
 * - Build TaskPayload using PromptBuilder and dispatch to agents via adapters
 * - Collect agent output artifacts, validate, and emit results
 * - Manage connected agent information
 * - Structured event logging
 *
 * Phase 1 scope: core class structure with placeholder adapter interface.
 * Phase 2 fills in real adapter implementations.
 */

import { EventBus } from './event-bus.js';
import type { BusEventName, BusEventMap } from './event-bus.js';
import { Engine } from './workflow-engine.js';
import { DispatchManager } from './dispatch.js';
import { readArtifact, artifactFileExists, validateArtifactContent, resolveArtifactDir } from './artifacts.js';
import type { ArtifactIOContext } from './artifacts.js';
import { buildEngineContext } from './engine-helpers.js';
import type { ResolvedContext } from './engine-helpers.js';
import { buildPrompt } from './prompt-builder.js';
import { findTaskNode } from './engine-helpers.js';
import { loadWorkflow } from './plugin.js';
import { readState, persistState } from './state.js';
import type {
    WorkflowDefinition,
    WorkflowState,
    WorkflowPlugin,
    TaskPayload,
    TaskResult,
    ArtifactDefinition,
    AgentStatus,
    NextAction,
} from './types.js';

// ─── Adapter Interfaces (canonical definitions in src/adapters/types.ts) ───

import type { AgentAdapter, AdapterConfig, AgentAdapterFactory, AdapterRegistry } from '../adapters/types.js';

// Re-export adapter types so existing imports from orchestrator.ts continue to work.
export type { AgentAdapter, AdapterConfig, AgentAdapterFactory, AdapterRegistry };

// ─── Connected Agent Tracking ───

/** Information about a connected agent (registered via connect API). */
export interface ConnectedAgent {
    agentType: string;
    sessionId?: string;
    role?: string;
    adapter?: AgentAdapter;
    connectedAt: number;
    params?: Record<string, unknown>;
}

// ─── Orchestrator Configuration ───

export interface OrchestratorConfig {
    workflowsDir: string;
    projectName: string;
    context: ResolvedContext;
    adapterRegistry?: AdapterRegistry;
    logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

// ─── Structured Logger ───

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_PRIORITY: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    silent: 4,
};

class EventLogger {
    constructor(private readonly level: LogLevel = 'info') {}

    log(level: LogLevel, event: string, data: Record<string, unknown>): void {
        if (level === 'silent') return;
        if (LOG_PRIORITY[level] < LOG_PRIORITY[this.level]) return;
        const entry = { ts: new Date().toISOString(), level, event, ...data };
        console.log(JSON.stringify(entry));
    }

    debug(event: string, data: Record<string, unknown> = {}): void {
        this.log('debug', event, data);
    }
    info(event: string, data: Record<string, unknown> = {}): void {
        this.log('info', event, data);
    }
    warn(event: string, data: Record<string, unknown> = {}): void {
        this.log('warn', event, data);
    }
    error(event: string, data: Record<string, unknown> = {}): void {
        this.log('error', event, data);
    }
}

// ─── Adapter Registry re-export ───

import { DefaultAdapterRegistry } from '../adapters/registry.js';
export { DefaultAdapterRegistry };

/**
 * @deprecated Use `DefaultAdapterRegistry` from `adapters/registry.js` instead.
 * Kept as alias for backward compatibility during migration.
 */
export const PlaceholderAdapterRegistry = DefaultAdapterRegistry;

// ─── Orchestrator ───

/**
 * The Orchestrator — Harmonia's central controller that drives workflow execution.
 *
 * Lifecycle:
 * 1. Create with `Orchestrator.create(config)` (async factory)
 * 2. Register agents via `connectAgent()`
 * 3. Call `start()` to begin workflow execution
 * 4. Orchestrator reacts to events and drives the workflow forward
 * 5. Call `shutdown()` to clean up
 */
export class Orchestrator {
    readonly bus: EventBus;
    private readonly engine: Engine;
    private readonly dispatchManager: DispatchManager;
    private readonly logger: EventLogger;
    private readonly connectedAgents = new Map<string, ConnectedAgent>();
    private readonly config: OrchestratorConfig;
    private readonly wf: WorkflowPlugin;
    private readonly ioCtx: ArtifactIOContext;

    private constructor(
        config: OrchestratorConfig,
        bus: EventBus,
        engine: Engine,
        dispatchManager: DispatchManager,
        wf: WorkflowPlugin,
        ioCtx: ArtifactIOContext,
    ) {
        this.config = config;
        this.bus = bus;
        this.engine = engine;
        this.dispatchManager = dispatchManager;
        this.wf = wf;
        this.ioCtx = ioCtx;
        this.logger = new EventLogger(config.logLevel ?? 'info');
        this.setupEventListeners();
        this.setupDispatchTimeout();
    }

    static async create(config: OrchestratorConfig): Promise<Orchestrator> {
        const { workflowsDir, projectName, context } = config;
        const state = await readState(projectName, context.number, context.dir);
        const wf = await loadWorkflow(workflowsDir, state.workflow);
        const ioCtx: ArtifactIOContext = {
            contextDir: context.dir,
            projectDir: context.entry.dir,
            contextLabel: context.activeContext,
        };
        const engineCtx = await buildEngineContext(projectName, context.number, context.dir, wf, ioCtx);
        const bus = new EventBus();
        const engine = new Engine(wf.definition, state, engineCtx, bus);
        const dispatchManager = new DispatchManager(bus);
        return new Orchestrator(config, bus, engine, dispatchManager, wf, ioCtx);
    }

    // ─── Public API ───

    start(): NextAction {
        this.logger.info('orchestrator.start', {
            project: this.config.projectName,
            workflow: this.wf.name,
        });
        const nextAction = this.engine.start();
        this.logNextAction(nextAction);
        return nextAction;
    }

    getState(): WorkflowState {
        return this.engine.getState();
    }
    getNextAction(): NextAction {
        return this.engine.getNextAction();
    }
    getDefinition(): WorkflowDefinition {
        return this.engine.getDefinition();
    }
    getWorkflowPlugin(): WorkflowPlugin {
        return this.wf;
    }
    getEventBus(): EventBus {
        return this.bus;
    }

    // ─── Agent Connection Management ───

    connectAgent(info: Omit<ConnectedAgent, 'connectedAt'>): void {
        const key = info.role ?? info.agentType;
        this.connectedAgents.set(key, { ...info, connectedAt: Date.now() });
        this.logger.info('agent.connected', {
            agentType: info.agentType,
            role: info.role,
            sessionId: info.sessionId,
        });
    }

    disconnectAgent(key: string): void {
        const agent = this.connectedAgents.get(key);
        if (agent) {
            // Terminate the adapter if present (best-effort, don't block on failure)
            if (agent.adapter) {
                agent.adapter.terminate().catch((err) => {
                    this.logger.warn('agent.terminate_failed', { key, error: String(err) });
                });
            }
            this.connectedAgents.delete(key);
            this.logger.info('agent.disconnected', { agentType: agent.agentType, role: agent.role });
        }
    }

    getConnectedAgent(key: string): ConnectedAgent | undefined {
        return this.connectedAgents.get(key);
    }

    listConnectedAgents(): ConnectedAgent[] {
        return [...this.connectedAgents.values()];
    }

    // ─── Workflow Event Handling ───

    async handleNodeCompleted(nodeId: string, result?: unknown): Promise<NextAction> {
        this.logger.info('node.completing', { nodeId });
        const nextAction = this.engine.handleEvent({ type: 'node_completed', nodeId, result });
        await this.persistState();
        this.logNextAction(nextAction);
        return nextAction;
    }

    async handleNodeFailed(nodeId: string, error: string): Promise<NextAction> {
        this.logger.warn('node.failing', { nodeId, error });
        const nextAction = this.engine.handleEvent({ type: 'node_failed', nodeId, error });
        await this.persistState();
        this.logNextAction(nextAction);
        return nextAction;
    }

    async handleArtifactWritten(artifactId: string): Promise<NextAction> {
        this.logger.info('artifact.written', { artifactId });
        const nextAction = this.engine.handleEvent({ type: 'artifact_written', artifactId });
        await this.persistState();
        return nextAction;
    }

    async handleArtifactApproved(artifactId: string): Promise<NextAction> {
        this.logger.info('artifact.approved', { artifactId });
        const nextAction = this.engine.handleEvent({ type: 'artifact_approved', artifactId });
        await this.persistState();
        return nextAction;
    }

    async handleLoopDone(nodeId: string): Promise<NextAction> {
        this.logger.info('loop.done', { nodeId });
        const nextAction = this.engine.handleEvent({ type: 'loop_done', nodeId });
        await this.persistState();
        return nextAction;
    }

    // ─── Dispatch & Prompt Assembly ───

    async buildTaskPayload(nodeId: string, taskBrief: string, additionalInputIds?: string[]): Promise<TaskPayload> {
        const targetNode = findTaskNode(this.wf, nodeId);
        if (!targetNode) {
            throw new Error('Node "' + nodeId + '" not found or is not a task node.');
        }
        const state = this.engine.getState();
        const promptResult = await buildPrompt({
            projectName: this.config.projectName,
            role: targetNode.role,
            taskBrief,
            targetNode,
            wf: this.wf,
            state,
            ioCtx: this.ioCtx,
            workflowsDir: this.config.workflowsDir,
            additionalInputIds,
        });
        return {
            nodeId,
            role: targetNode.role,
            prompt: promptResult.prompt,
            inputArtifacts: promptResult.inputRefs.filter((r) => r.found).map((r) => r.path),
            outputExpectations: promptResult.outputArtifacts,
            timeout: targetNode.timeout,
        };
    }

    async dispatchTask(nodeId: string, taskBrief: string, additionalInputIds?: string[]): Promise<TaskResult> {
        const targetNode = findTaskNode(this.wf, nodeId);
        if (!targetNode) {
            throw new Error('Node "' + nodeId + '" not found or is not a task node.');
        }
        const role = targetNode.role;
        const state = this.engine.getState();

        const promptResult = await buildPrompt({
            projectName: this.config.projectName,
            role,
            taskBrief,
            targetNode,
            wf: this.wf,
            state,
            ioCtx: this.ioCtx,
            workflowsDir: this.config.workflowsDir,
            additionalInputIds,
        });

        const agentType = promptResult.agent ?? 'unknown';
        const payload: TaskPayload = {
            nodeId,
            role,
            prompt: promptResult.prompt,
            inputArtifacts: promptResult.inputRefs.filter((r) => r.found).map((r) => r.path),
            outputExpectations: promptResult.outputArtifacts,
            timeout: targetNode.timeout,
        };

        const dispatchRecord = await this.dispatchManager.dispatch({
            projectName: this.config.projectName,
            iteration: this.config.context.number,
            role,
            taskBrief,
            expectedOutputs: [],
            nodeId,
            agentType,
            contextDir: this.config.context.dir,
            timeout: targetNode.timeout,
        });

        this.logger.info('task.dispatching', {
            dispatchId: dispatchRecord.id,
            nodeId,
            role,
            agentType,
        });

        const registry = this.config.adapterRegistry;
        const factory = registry?.getFactory(agentType);
        if (!factory) {
            const msg = 'No adapter registered for agent type "' + agentType + '". Phase 2 required.';
            this.logger.warn('adapter.notFound', { agentType, available: registry?.listTypes() ?? [] });
            return { status: 'failed', artifacts: [], error: msg };
        }

        const adapter = factory.create({});
        let taskResult: TaskResult;
        try {
            taskResult = await adapter.dispatchTask(payload);
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            this.logger.error('task.dispatchFailed', { dispatchId: dispatchRecord.id, nodeId, error: errorMsg });
            await this.dispatchManager.updateStatus(
                this.config.projectName,
                this.config.context.number,
                dispatchRecord.id,
                'failed',
                this.config.context.dir,
                errorMsg,
            );
            return { status: 'failed', artifacts: [], error: errorMsg };
        }

        await this.dispatchManager.updateStatus(
            this.config.projectName,
            this.config.context.number,
            dispatchRecord.id,
            taskResult.status,
            this.config.context.dir,
        );

        if (taskResult.status === 'completed') {
            await this.collectAndValidateArtifacts(nodeId, role);
        }

        this.logger.info('task.completed', {
            dispatchId: dispatchRecord.id,
            nodeId,
            status: taskResult.status,
        });
        return taskResult;
    }

    // ─── Artifact Collection ───

    private async collectAndValidateArtifacts(nodeId: string, role: string): Promise<void> {
        const roleDef = this.wf.roles[role];
        if (!roleDef?.frontmatter.capabilities) return;

        for (const cap of roleDef.frontmatter.capabilities) {
            if (!cap.artifact) continue;
            const artifactDef = this.wf.artifactDefinitions[cap.artifact];
            if (!artifactDef) continue;

            const exists = await artifactFileExists(cap.artifact, this.ioCtx, artifactDef);
            if (!exists) {
                this.logger.debug('artifact.notFound', { artifactId: cap.artifact, nodeId });
                continue;
            }

            let content: string;
            try {
                content = await readArtifact(cap.artifact, this.ioCtx, artifactDef);
            } catch (err) {
                this.logger.warn('artifact.readFailed', {
                    artifactId: cap.artifact,
                    error: err instanceof Error ? err.message : String(err),
                });
                continue;
            }

            const valConfig = artifactDef.validation ?? { type: 'none' as const };
            const valResult = await validateArtifactContent(cap.artifact, content, valConfig, {
                workflowsDir: this.config.workflowsDir,
                workflowName: this.wf.name,
                artifactDef,
                filePath: resolveArtifactDir(artifactDef.output, this.ioCtx) + '/' + cap.artifact,
            });

            if (valResult.valid) {
                this.bus.emit('artifact.written', {
                    artifactId: cap.artifact,
                    nodeId,
                    path: resolveArtifactDir(artifactDef.output, this.ioCtx),
                    ts: Date.now(),
                });
                this.logger.info('artifact.validated', { artifactId: cap.artifact, nodeId });
            } else {
                this.logger.warn('artifact.validationFailed', {
                    artifactId: cap.artifact,
                    nodeId,
                    errors: valResult.errors,
                });
                await this.notifyCoordinator(
                    'Artifact "' +
                        cap.artifact +
                        '" validation failed:\n' +
                        valResult.errors.map((e) => '- ' + e).join('\n'),
                );
            }
        }
    }

    // ─── Coordinator Communication ───

    async notifyCoordinator(message: string): Promise<void> {
        const coordinatorRole = this.wf.definition.coordinator;
        const coordinator = this.connectedAgents.get(coordinatorRole);

        if (!coordinator?.adapter?.pushMessage) {
            this.logger.debug('coordinator.pushUnavailable', {
                coordinatorRole,
                connected: !!coordinator,
            });
            return;
        }

        try {
            await coordinator.adapter.pushMessage(message);
            this.logger.info('coordinator.notified', { coordinatorRole });
        } catch (err) {
            this.logger.error('coordinator.notifyFailed', {
                coordinatorRole,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // ─── Shutdown ───

    shutdown(): void {
        this.logger.info('orchestrator.shutdown', { project: this.config.projectName });
        this.dispatchManager.clearAllTimeouts();
        this.bus.removeAllListeners();
        this.connectedAgents.clear();
    }

    // ─── Private Helpers ───

    private logNextAction(nextAction: NextAction): void {
        this.logger.info('orchestrator.nextAction', {
            type: nextAction.type,
            nodeId: nextAction.nodeId,
            role: nextAction.role,
        });
    }

    private async persistState(): Promise<void> {
        const state = this.engine.getState();
        await persistState(this.config.projectName, this.config.context.number, state, this.config.context.dir);
    }

    private setupEventListeners(): void {
        const logEvents: Array<{ name: BusEventName; level: LogLevel }> = [
            { name: 'node.activated', level: 'info' },
            { name: 'node.completed', level: 'info' },
            { name: 'node.failed', level: 'warn' },
            { name: 'artifact.written', level: 'info' },
            { name: 'artifact.approved', level: 'info' },
            { name: 'gate.evaluated', level: 'info' },
            { name: 'task.dispatched', level: 'info' },
            { name: 'task.timeout', level: 'warn' },
            { name: 'task.stalled', level: 'warn' },
            { name: 'agent.unreachable', level: 'error' },
        ];
        for (const { name, level } of logEvents) {
            this.bus.on(name, (payload) => {
                this.logger.log(level, 'bus.' + name, payload as unknown as Record<string, unknown>);
            });
        }
    }

    private setupDispatchTimeout(): void {
        this.dispatchManager.onTimeout(async (dispatchId, nodeId, elapsed) => {
            this.logger.warn('dispatch.timeout', { dispatchId, nodeId, elapsed });
            // TODO: integrate adapter.checkStatus() to decide retry vs fail on timeout
        });
    }
}
