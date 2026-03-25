/**
 * API Routes — all Harmonia HTTP endpoints.
 *
 * Delegates business logic to core/operations.ts.
 * Handles HTTP concerns: parameter extraction, error responses, status codes.
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

/**
 * Create all API route handlers.
 */
export function createApiRoutes(workflowsDir: string): Hono {
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

    // ─── Agent Connection (placeholder for Phase 4+) ───

    /** POST /connect — Agent registration */
    api.post('/connect', async (c) => {
        // TODO: Implement in Phase 4 (Orchestrator integration)
        return c.json({ error: 'Not yet implemented' }, 501);
    });

    /** DELETE /connect/:id — Agent disconnect */
    api.delete('/connect/:id', async (c) => {
        // TODO: Implement in Phase 4 (Orchestrator integration)
        return c.json({ error: 'Not yet implemented' }, 501);
    });

    return api;
}
