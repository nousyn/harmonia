/**
 * API integration tests — routes.ts + server.ts
 *
 * Tests HTTP endpoints using Hono's built-in request testing
 * (no actual HTTP server needed). Uses real filesystem for data.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, cp, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server.js';
import { registerProject, startIteration, startPatch } from '../src/core/registry.js';
import { submitForReview } from '../src/core/reviews.js';
import type { Hono } from 'hono';

const WORKFLOWS_SRC = resolve(join(import.meta.dirname, '..', 'workflows'));

describe('API endpoints', () => {
    let tempDir: string;
    let workflowsDir: string;
    let app: Hono;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'harmonia-api-test-'));
        process.env.HARMONIA_DATA_DIR = tempDir;

        // Copy workflows to temp
        workflowsDir = join(tempDir, '.workflows');
        await cp(WORKFLOWS_SRC, workflowsDir, { recursive: true });

        app = createApp(workflowsDir);
    });

    afterEach(async () => {
        delete process.env.HARMONIA_DATA_DIR;
        await rm(tempDir, { recursive: true, force: true });
    });

    // ─── Health ───

    describe('GET /health', () => {
        it('should return ok', async () => {
            const res = await app.request('/health');
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.status).toBe('ok');
        });
    });

    // ─── Projects ───

    describe('GET /projects', () => {
        it('should return empty list when no projects', async () => {
            const res = await app.request('/projects');
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.projects).toEqual([]);
        });

        it('should return registered projects', async () => {
            await registerProject('test-app', join(tempDir, 'src'), 'dev');

            const res = await app.request('/projects');
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.projects).toHaveLength(1);
            expect(body.projects[0].name).toBe('test-app');
        });
    });

    describe('POST /projects', () => {
        it('should create a new project', async () => {
            const res = await app.request('/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectName: 'my-app',
                    projectDir: join(tempDir, 'src'),
                    workflow: 'dev',
                }),
            });
            expect(res.status).toBe(201);
            const body = await res.json();
            expect(body.projectName).toBe('my-app');
            expect(body.alreadyRegistered).toBe(false);
        });

        it('should return 200 for already registered project', async () => {
            await registerProject('my-app', join(tempDir, 'src'), 'dev');

            const res = await app.request('/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectName: 'my-app',
                    projectDir: join(tempDir, 'src'),
                    workflow: 'dev',
                }),
            });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.alreadyRegistered).toBe(true);
        });

        it('should return 400 when missing required fields', async () => {
            const res = await app.request('/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ project_name: 'my-app' }),
            });
            expect(res.status).toBe(400);
        });
    });

    describe('GET /projects/:name/status', () => {
        it('should return 404 for unknown project', async () => {
            const res = await app.request('/projects/nonexistent/status');
            expect(res.status).toBe(404);
        });

        it('should return status for registered project with active context', async () => {
            await registerProject('my-app', join(tempDir, 'src'), 'dev');
            // Need to begin iteration to have an active context
            const initRes = await app.request('/projects/my-app/iterations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            expect(initRes.status).toBe(201);

            const res = await app.request('/projects/my-app/status');
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.projectName).toBe('my-app');
        });
    });

    // ─── Iterations ───

    describe('POST /projects/:name/iterations', () => {
        it('should create a new iteration', async () => {
            await registerProject('my-app', join(tempDir, 'src'), 'dev');

            const res = await app.request('/projects/my-app/iterations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            expect(res.status).toBe(201);
            const body = await res.json();
            expect(body.iteration).toBe(1);
            expect(body.nextAction).toBeDefined();
        });

        it('should return 404 for unknown project', async () => {
            const res = await app.request('/projects/nonexistent/iterations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            expect(res.status).toBe(404);
        });
    });

    // ─── Patches ───

    describe('POST /projects/:name/patches', () => {
        it('should create a new patch', async () => {
            await registerProject('my-app', join(tempDir, 'src'), 'dev');
            await startIteration('my-app');

            const res = await app.request('/projects/my-app/patches', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description: 'fix bug', issue_id: 'issue-1' }),
            });
            expect(res.status).toBe(201);
            const body = await res.json();
            expect(body.patchNumber).toBe(1);
        });

        it('should return error when no iterations exist', async () => {
            await registerProject('my-app', join(tempDir, 'src'), 'dev');

            const res = await app.request('/projects/my-app/patches', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            expect(res.status).toBe(400);
        });
    });

    // ─── Artifacts ───

    describe('GET /projects/:name/artifacts', () => {
        it('should list artifacts for active context', async () => {
            await registerProject('my-app', join(tempDir, 'src'), 'dev');
            // Must begin iteration via API to initialize workflow state
            await app.request('/projects/my-app/iterations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });

            const res = await app.request('/projects/my-app/artifacts');
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.artifacts).toBeDefined();
        });
    });

    describe('GET /projects/:name/artifacts/:id', () => {
        it('should read a written artifact', async () => {
            await registerProject('my-app', join(tempDir, 'src'), 'dev');
            // Start iteration via API to init workflow state
            await app.request('/projects/my-app/iterations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });

            // Write artifact directly to filesystem (agents write directly in new architecture)
            const userStoriesContent =
                '## 用户故事\n\n' +
                '作为用户，我想登录系统，以便访问受保护的资源。\n' +
                '验收标准：用户输入正确的用户名和密码后，应跳转到首页。\n'.repeat(3);
            const artifactDir = join(tempDir, 'my-app', 'iter-1', 'artifacts');
            await mkdir(artifactDir, { recursive: true });
            await writeFile(join(artifactDir, 'user-stories.md'), userStoriesContent, 'utf-8');

            // Read it back via API
            const res = await app.request('/projects/my-app/artifacts/user-stories');
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.artifactId).toBe('user-stories');
            expect(body.content).toContain('用户故事');
        });

        it('should return 404 for unknown project', async () => {
            const res = await app.request('/projects/nonexistent/artifacts/prd');
            expect(res.status).toBe(404);
        });
    });

    // POST /projects/:name/artifacts/:id — removed (agents write directly to filesystem)

    describe('POST /projects/:name/artifacts/:id/approve', () => {
        it('should approve an artifact pending review', async () => {
            await registerProject('my-app', join(tempDir, 'src'), 'dev');
            // Start iteration via API
            await app.request('/projects/my-app/iterations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });

            // Write a reviewable artifact directly to filesystem (prototype has review: true, format: html)
            const htmlContent =
                '<html><head><title>Prototype</title></head><body>' +
                '<h1>高保真原型</h1><p>页面布局和交互流程展示。</p>' +
                '<div class="container"><p>内容区域</p></div>'.repeat(3) +
                '</body></html>';
            const artifactDir = join(tempDir, 'my-app', 'iter-1', 'artifacts');
            await mkdir(artifactDir, { recursive: true });
            await writeFile(join(artifactDir, 'prototype.html'), htmlContent, 'utf-8');

            // Submit for review (in the new architecture, this is triggered by the orchestrator after validation)
            await submitForReview('my-app', 1, 'prototype', join(tempDir, 'my-app', 'iter-1'));

            // Approve it
            const res = await app.request('/projects/my-app/artifacts/prototype/approve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ approved: true, comment: 'Looks good' }),
            });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.artifactId).toBe('prototype');
            expect(body.approved).toBe(true);
            expect(body.comment).toBe('Looks good');
        });

        it('should return 400 when approved field is missing', async () => {
            await registerProject('my-app', join(tempDir, 'src'), 'dev');
            await startIteration('my-app');

            const res = await app.request('/projects/my-app/artifacts/prototype/approve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            expect(res.status).toBe(400);
            const body = await res.json();
            expect(body.error).toContain('approved');
        });
    });

    // ─── Reviews ───

    describe('GET /projects/:name/reviews', () => {
        it('should return pending reviews', async () => {
            await registerProject('my-app', join(tempDir, 'src'), 'dev');
            await startIteration('my-app');

            const res = await app.request('/projects/my-app/reviews');
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.reviews).toBeDefined();
        });
    });

    // ─── Issues ───

    describe('POST /projects/:name/issues', () => {
        it('should create an issue', async () => {
            await registerProject('my-app', join(tempDir, 'src'), 'dev');
            await startIteration('my-app');

            const res = await app.request('/projects/my-app/issues', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Test issue',
                    description: 'Something broke',
                    source: 'test',
                    iteration: 1,
                }),
            });
            expect(res.status).toBe(201);
            const body = await res.json();
            expect(body.title).toBe('Test issue');
        });

        it('should return 404 for unknown project', async () => {
            const res = await app.request('/projects/nonexistent/issues', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Test',
                    description: 'Test',
                    source: 'test',
                    iteration: 1,
                }),
            });
            expect(res.status).toBe(404);
        });

        it('should return 400 when required fields missing', async () => {
            await registerProject('my-app', join(tempDir, 'src'), 'dev');

            const res = await app.request('/projects/my-app/issues', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: 'Test' }),
            });
            expect(res.status).toBe(400);
        });
    });

    describe('GET /projects/:name/issues', () => {
        it('should list issues', async () => {
            await registerProject('my-app', join(tempDir, 'src'), 'dev');

            const res = await app.request('/projects/my-app/issues');
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.issues).toBeDefined();
        });

        it('should return 404 for unknown project', async () => {
            const res = await app.request('/projects/nonexistent/issues');
            expect(res.status).toBe(404);
        });
    });

    describe('PATCH /projects/:name/issues/:id', () => {
        it('should update an existing issue', async () => {
            await registerProject('my-app', join(tempDir, 'src'), 'dev');
            await startIteration('my-app');

            // Create an issue first
            const createRes = await app.request('/projects/my-app/issues', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Bug to fix',
                    description: 'Something is broken',
                    source: 'test',
                    iteration: 1,
                }),
            });
            expect(createRes.status).toBe(201);
            const created = await createRes.json();
            const issueId = created.id;

            // Update it
            const res = await app.request(`/projects/my-app/issues/${issueId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'closed' }),
            });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.status).toBe('closed');
        });

        it('should return 404 for unknown project', async () => {
            const res = await app.request('/projects/nonexistent/issues/some-id', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'closed' }),
            });
            expect(res.status).toBe(404);
        });
    });

    // ─── Connect placeholders ───

    describe('POST /projects/:name/agents/connect', () => {
        it('should return 501 not implemented', async () => {
            const res = await app.request('/projects/nonexistent/agents/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            expect(res.status).toBe(501);
        });
    });

    describe('GET /projects/:name/artifacts/:id/schema', () => {
        it('should return 404 for unknown project', async () => {
            const res = await app.request('/projects/nonexistent/artifacts/prd/schema');
            expect(res.status).toBe(404);
        });
    });
});
