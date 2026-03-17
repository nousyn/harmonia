/**
 * Tests for core/issues.ts — Issue CRUD and filtering.
 *
 * Uses HARMONIA_DATA_DIR to redirect file I/O to a temp directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createIssue, readIssues, updateIssue, listIssues } from '../src/core/issues.js';

const PROJECT = 'test-project';

describe('core/issues', () => {
    let harmoniaHome: string;

    beforeEach(async () => {
        harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-issues-test-'));
        process.env.HARMONIA_DATA_DIR = harmoniaHome;
        // Create project data directory
        await mkdir(join(harmoniaHome, PROJECT), { recursive: true });
    });

    afterEach(async () => {
        delete process.env.HARMONIA_DATA_DIR;
        await rm(harmoniaHome, { recursive: true, force: true });
    });

    // ─── readIssues ───

    it('should return empty array when issues.json does not exist', async () => {
        const issues = await readIssues(PROJECT);
        expect(issues).toEqual([]);
    });

    // ─── createIssue ───

    it('should create a new issue with auto-generated ID', async () => {
        const issue = await createIssue(PROJECT, 'Login fails', 'Cannot login with valid credentials', 'test', 1);
        expect(issue.id).toBe('issue-1');
        expect(issue.title).toBe('Login fails');
        expect(issue.description).toBe('Cannot login with valid credentials');
        expect(issue.source).toBe('test');
        expect(issue.iteration).toBe(1);
        expect(issue.status).toBe('open');
        expect(issue.createdAt).toBeDefined();
    });

    it('should persist issue to disk', async () => {
        await createIssue(PROJECT, 'Bug A', 'Desc A', 'test', 1);
        const raw = JSON.parse(await readFile(join(harmoniaHome, PROJECT, 'issues.json'), 'utf-8'));
        expect(raw).toHaveLength(1);
        expect(raw[0].id).toBe('issue-1');
    });

    it('should auto-increment IDs', async () => {
        await createIssue(PROJECT, 'Issue 1', 'First', 'test', 1);
        const second = await createIssue(PROJECT, 'Issue 2', 'Second', 'user-feedback', 1);
        const third = await createIssue(PROJECT, 'Issue 3', 'Third', 'test', 2);

        expect(second.id).toBe('issue-2');
        expect(third.id).toBe('issue-3');
    });

    // ─── updateIssue ───

    it('should update issue status', async () => {
        await createIssue(PROJECT, 'Bug', 'Desc', 'test', 1);
        const updated = await updateIssue(PROJECT, 'issue-1', { status: 'closed' });
        expect(updated.status).toBe('closed');
        expect(updated.closedAt).toBeDefined();
    });

    it('should set resolvedBy on update', async () => {
        await createIssue(PROJECT, 'Bug', 'Desc', 'test', 1);
        const updated = await updateIssue(PROJECT, 'issue-1', {
            status: 'closed',
            resolvedBy: { type: 'patch', number: 1 },
        });
        expect(updated.resolvedBy).toEqual({ type: 'patch', number: 1 });
        expect(updated.status).toBe('closed');
    });

    it('should throw when updating non-existent issue', async () => {
        await expect(updateIssue(PROJECT, 'issue-999', { status: 'closed' })).rejects.toThrow('not found');
    });

    it('should persist updates to disk', async () => {
        await createIssue(PROJECT, 'Bug', 'Desc', 'test', 1);
        await updateIssue(PROJECT, 'issue-1', { status: 'closed' });

        const raw = JSON.parse(await readFile(join(harmoniaHome, PROJECT, 'issues.json'), 'utf-8'));
        expect(raw[0].status).toBe('closed');
        expect(raw[0].closedAt).toBeDefined();
    });

    // ─── listIssues (with filters) ───

    it('should list all issues without filters', async () => {
        await createIssue(PROJECT, 'A', 'a', 'test', 1);
        await createIssue(PROJECT, 'B', 'b', 'user-feedback', 1);
        await createIssue(PROJECT, 'C', 'c', 'test', 2);

        const all = await listIssues(PROJECT);
        expect(all).toHaveLength(3);
    });

    it('should filter by status', async () => {
        await createIssue(PROJECT, 'A', 'a', 'test', 1);
        await createIssue(PROJECT, 'B', 'b', 'test', 1);
        await updateIssue(PROJECT, 'issue-1', { status: 'closed' });

        const open = await listIssues(PROJECT, { status: 'open' });
        expect(open).toHaveLength(1);
        expect(open[0].id).toBe('issue-2');

        const closed = await listIssues(PROJECT, { status: 'closed' });
        expect(closed).toHaveLength(1);
        expect(closed[0].id).toBe('issue-1');
    });

    it('should filter by source', async () => {
        await createIssue(PROJECT, 'A', 'a', 'test', 1);
        await createIssue(PROJECT, 'B', 'b', 'user-feedback', 1);

        const testOnly = await listIssues(PROJECT, { source: 'test' });
        expect(testOnly).toHaveLength(1);
        expect(testOnly[0].title).toBe('A');

        const feedbackOnly = await listIssues(PROJECT, { source: 'user-feedback' });
        expect(feedbackOnly).toHaveLength(1);
        expect(feedbackOnly[0].title).toBe('B');
    });

    it('should filter by iteration', async () => {
        await createIssue(PROJECT, 'A', 'a', 'test', 1);
        await createIssue(PROJECT, 'B', 'b', 'test', 2);
        await createIssue(PROJECT, 'C', 'c', 'test', 1);

        const iter1 = await listIssues(PROJECT, { iteration: 1 });
        expect(iter1).toHaveLength(2);
        expect(iter1.map((i) => i.title)).toEqual(['A', 'C']);
    });

    it('should combine multiple filters', async () => {
        await createIssue(PROJECT, 'A', 'a', 'test', 1);
        await createIssue(PROJECT, 'B', 'b', 'user-feedback', 1);
        await createIssue(PROJECT, 'C', 'c', 'test', 2);
        await updateIssue(PROJECT, 'issue-1', { status: 'closed' });

        const result = await listIssues(PROJECT, { status: 'open', source: 'test' });
        expect(result).toHaveLength(1);
        expect(result[0].title).toBe('C');
    });
});
