/**
 * API Routes — all Harmonia HTTP endpoints.
 *
 * Delegates business logic to core/operations.ts.
 * Handles HTTP concerns: parameter extraction, error responses, status codes.
 * Connect/disconnect endpoints delegate to OrchestratorPool when available.
 */

import { Hono } from 'hono';
import {
    initProject,
    beginIteration,
    beginPatch,
    writeArtifactOrchestrated,
    readArtifactOrchestrated,
    listArtifactsOrchestrated,
    approveArtifactOrchestrated,
    listPendingReviewsOrchestrated,
    getArtifactSchemaInfo,
    getProjectStatus,
    getProjectList,
    WorkflowSelectionRequired,
    ValidationError,
    StepPrerequisiteError,
} from '../core/operations.js';
import { getProject } from '../core/registry.js';
import { createIssue, updateIssue, listIssues } from '../core/issues.js';
import type { OrchestratorPool } from '../core/orchestrator-pool.js';

/**
 * Create all API route handlers.
 *
 * @param workflowsDir — path to the workflows directory
 * @param pool — optional OrchestratorPool for orchestration features.
 *               When omitted, connect endpoints return 501.
 */
export function createApiRoutes(workflowsDir: string, pool?: OrchestratorPool): Hono {
    const api = new Hono();

    // ─── Error handler helper ───
    function handleError(c: any, err: unknown) {
        if (err instanceof WorkflowSelectionRequired) {
            return c.json({ error: err.message, available: err.available }, 409);
        }
        if (err instanceof ValidationError || err instanceof StepPrerequisiteError) {
            return c.json({ error: err.message }, 400);
        }
        const message = err instanceof Error ? err.message : String(err);
        // "未注册" means not found
        if (message.includes('未注册') || message.includes('not found') || message.includes('not registered')) {
            return c.json({ error: message }, 404);
        }
        return c.json({ error: message }, 500);
    }

    // ─── Projects ───

    /** GET /projects — List all projects */
    api.get('/projects', async (c) => {
        try {
            const items = await getProjectList();
            return c.json({ projects: items });
        } catch (err) {
            return handleError(c, err);
        }
    });

    /** POST /projects — Initialize a new project */
    api.post('/projects', async (c) => {
        try {
            const body = await c.req.json();
            const { project_name, project_dir, workflow } = body;
            if (!project_name || !project_dir) {
                return c.json({ error: 'project_name and project_dir are required' }, 400);
            }
            const result = await initProject(workflowsDir, project_name, project_dir, workflow);
            const status = result.alreadyRegistered ? 200 : 201;
            return c.json(result, status);
        } catch (err) {
            return handleError(c, err);
        }
    });

    /** GET /projects/:name/status — Get project status */
    api.get('/projects/:name/status', async (c) => {
        try {
            const name = c.req.param('name');
            const data = await getProjectStatus(workflowsDir, name);
            return c.json(data);
        } catch (err) {
            return handleError(c, err);
        }
    });

    // ─── Iterations & Patches ───

    /** POST /projects/:name/iterations — Start a new iteration */
    api.post('/projects/:name/iterations', async (c) => {
        try {
            const name = c.req.param('name');
            const body = await c.req.json().catch(() => ({}));
            const result = await beginIteration(workflowsDir, name, body.force);
            return c.json(result, 201);
        } catch (err) {
            return handleError(c, err);
        }
    });

    /** POST /projects/:name/patches — Start a new patch */
    api.post('/projects/:name/patches', async (c) => {
        try {
            const name = c.req.param('name');
            const body = await c.req.json().catch(() => ({}));
            const result = await beginPatch(workflowsDir, name, body.description, body.issue_id);
            return c.json(result, 201);
        } catch (err) {
            return handleError(c, err);
        }
    });

    // ─── Artifacts ───

    /** GET /projects/:name/artifacts — List artifacts */
    api.get('/projects/:name/artifacts', async (c) => {
        try {
            const name = c.req.param('name');
            const context = c.req.query('context');
            const result = await listArtifactsOrchestrated(workflowsDir, name, context);
            return c.json(result);
        } catch (err) {
            return handleError(c, err);
        }
    });

    /** GET /projects/:name/artifacts/:id — Read an artifact */
    api.get('/projects/:name/artifacts/:id', async (c) => {
        try {
            const name = c.req.param('name');
            const artifactId = c.req.param('id');
            const context = c.req.query('context');
            const content = await readArtifactOrchestrated(workflowsDir, name, artifactId, context);
            return c.json({ artifactId, content });
        } catch (err) {
            return handleError(c, err);
        }
    });

    /** POST /projects/:name/artifacts/:id — Write an artifact
     *  TRANSITIONAL: 006 计划标记为"不再暴露"，但过渡期仍需外部写入能力。Phase 5 评估去留。
     */
    api.post('/projects/:name/artifacts/:id', async (c) => {
        try {
            const name = c.req.param('name');
            const artifactId = c.req.param('id');
            const body = await c.req.json();
            if (!body.content) {
                return c.json({ error: 'content is required' }, 400);
            }
            const result = await writeArtifactOrchestrated(workflowsDir, name, artifactId, body.content, body.step);
            return c.json(result, 201);
        } catch (err) {
            return handleError(c, err);
        }
    });

    /** POST /projects/:name/artifacts/:id/approve — Approve or reject an artifact */
    api.post('/projects/:name/artifacts/:id/approve', async (c) => {
        try {
            const name = c.req.param('name');
            const artifactId = c.req.param('id');
            const body = await c.req.json();
            if (body.approved === undefined) {
                return c.json({ error: 'approved (boolean) is required' }, 400);
            }
            const result = await approveArtifactOrchestrated(
                workflowsDir,
                name,
                artifactId,
                body.approved,
                body.comment,
            );
            return c.json(result);
        } catch (err) {
            return handleError(c, err);
        }
    });

    /** GET /projects/:name/artifacts/:id/schema — Get artifact schema */
    api.get('/projects/:name/artifacts/:id/schema', async (c) => {
        try {
            const name = c.req.param('name');
            const artifactId = c.req.param('id');
            const step = c.req.query('step');
            const result = await getArtifactSchemaInfo(workflowsDir, name, artifactId, step);
            return c.json(result);
        } catch (err) {
            return handleError(c, err);
        }
    });

    // ─── Reviews ───

    /** GET /projects/:name/reviews — List pending reviews */
    api.get('/projects/:name/reviews', async (c) => {
        try {
            const name = c.req.param('name');
            const pending = await listPendingReviewsOrchestrated(name);
            return c.json({ pending });
        } catch (err) {
            return handleError(c, err);
        }
    });

    // ─── Issues ───

    /** GET /projects/:name/issues — List issues */
    api.get('/projects/:name/issues', async (c) => {
        try {
            const name = c.req.param('name');
            const entry = await getProject(name);
            if (!entry) {
                return c.json({ error: `项目 "${name}" 未注册。` }, 404);
            }
            const status = c.req.query('status') as 'open' | 'closed' | undefined;
            const source = c.req.query('source') as 'test' | 'user-feedback' | undefined;
            const iteration = c.req.query('iteration') ? Number(c.req.query('iteration')) : undefined;
            const filters: Record<string, unknown> = {};
            if (status) filters.status = status;
            if (source) filters.source = source;
            if (iteration !== undefined) filters.iteration = iteration;
            const issues = await listIssues(name, Object.keys(filters).length > 0 ? (filters as any) : undefined);
            return c.json({ issues });
        } catch (err) {
            return handleError(c, err);
        }
    });

    /** POST /projects/:name/issues — Create an issue */
    api.post('/projects/:name/issues', async (c) => {
        try {
            const name = c.req.param('name');
            const entry = await getProject(name);
            if (!entry) {
                return c.json({ error: `项目 "${name}" 未注册。` }, 404);
            }
            const body = await c.req.json();
            const { title, description, source, iteration } = body;
            if (!title || !description || !source || !iteration) {
                return c.json({ error: 'title, description, source, and iteration are required' }, 400);
            }
            const issue = await createIssue(name, title, description, source, iteration);
            return c.json(issue, 201);
        } catch (err) {
            return handleError(c, err);
        }
    });

    /** PATCH /projects/:name/issues/:id — Update an issue */
    api.patch('/projects/:name/issues/:id', async (c) => {
        try {
            const name = c.req.param('name');
            const issueId = c.req.param('id');
            const entry = await getProject(name);
            if (!entry) {
                return c.json({ error: `项目 "${name}" 未注册。` }, 404);
            }
            const body = await c.req.json();
            const updates: Record<string, unknown> = {};
            if (body.status !== undefined) updates.status = body.status;
            if (body.resolved_by_type && body.resolved_by_number) {
                updates.resolvedBy = { type: body.resolved_by_type, number: body.resolved_by_number };
            }
            const issue = await updateIssue(name, issueId, updates as any);
            return c.json(issue);
        } catch (err) {
            return handleError(c, err);
        }
    });

    // ─── Agent Connection ───

    /**
     * POST /connect — Agent registration (002 §4.2)
     *
     * Body: { project_name, agent, sessionId?, role?, ...params }
     *
     * - `project_name` — which project's Orchestrator to register with
     * - `agent` — agent type string (e.g. "openclaw", "opencode")
     * - `sessionId` — optional session identifier on the agent side
     * - `role` — optional workflow role override (defaults to agent type)
     * - extra fields are forwarded as `params`
     *
     * When `pool` is not provided, returns 501.
     */
    api.post('/connect', async (c) => {
        if (!pool) {
            return c.json({ error: 'Orchestration not available' }, 501);
        }
        try {
            const body = await c.req.json();
            const { project_name, agent, sessionId, role, ...rest } = body;
            if (!project_name || !agent) {
                return c.json({ error: 'project_name and agent are required' }, 400);
            }

            // SECURITY: Whitelist safe adapter params only.
            // CliAdapterConfig allows `command`, `extraArgs`, and `env` which
            // could be abused for arbitrary command injection if passed through
            // from untrusted HTTP input. `env` is also dangerous because
            // overriding PATH/LD_PRELOAD/NODE_OPTIONS enables indirect code
            // execution. Only forward known-safe fields.
            const SAFE_PARAMS = new Set(['timeout', 'cwd']);
            const params: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(rest)) {
                if (SAFE_PARAMS.has(k)) {
                    params[k] = v;
                }
            }

            const orch = await pool.getOrCreate(project_name);

            // Resolve adapter from the pool's adapter registry.
            //
            // DESIGN NOTE: The adapter created here is attached to connectedAgents
            // and used exclusively for pushMessage() (e.g. coordinator notifications).
            // dispatchTask() creates its OWN adapter instance per dispatch via
            // registry.getFactory().create() — this is intentional because CLI
            // dispatches are stateless one-shot executions, whereas the connected
            // adapter represents a persistent session (e.g. OpenClaw's --deliver).
            const factory = pool.adapterRegistry.getFactory(agent);
            if (!factory) {
                return c.json({ error: `Unknown agent type: "${agent}"` }, 422);
            }
            const adapter = factory.create(params ?? {});

            const key = role ?? agent;
            orch.connectAgent({
                agentType: agent,
                sessionId,
                role,
                adapter,
                params,
            });

            return c.json(
                {
                    connected: true,
                    key,
                    agentType: agent,
                    project: project_name,
                },
                200,
            );
        } catch (err) {
            return handleError(c, err);
        }
    });

    /**
     * DELETE /connect/:id — Agent disconnect
     *
     * Query: ?project_name=xxx
     * Param: :id — the agent key (role or agentType used at connect time)
     */
    api.delete('/connect/:id', async (c) => {
        if (!pool) {
            return c.json({ error: 'Orchestration not available' }, 501);
        }
        try {
            const key = c.req.param('id');
            const projectName = c.req.query('project_name');
            if (!projectName) {
                return c.json({ error: 'project_name query parameter is required' }, 400);
            }

            const orch = pool.get(projectName);
            if (!orch) {
                return c.json({ error: `No active orchestrator for project "${projectName}"` }, 404);
            }

            const agent = orch.getConnectedAgent(key);
            if (!agent) {
                return c.json({ error: `Agent "${key}" is not connected` }, 404);
            }

            orch.disconnectAgent(key);
            return c.json({ disconnected: true, key, project: projectName }, 200);
        } catch (err) {
            return handleError(c, err);
        }
    });

    return api;
}
