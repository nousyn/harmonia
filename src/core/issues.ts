/**
 * Issue tracking — manages <data_dir>/<project_name>/issues.json
 *
 * Issues are project-level (not per-iteration/patch). They track problems
 * discovered during testing or from user feedback, and can be linked to
 * the patch or iteration that resolves them.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectDataDir } from './registry.js';
import type { Issue, IssueResolvedBy, IssueSource, IssueStatus } from './types.js';

const ISSUES_FILE = 'issues.json';

function issuesPath(projectName: string): string {
    return join(getProjectDataDir(projectName), ISSUES_FILE);
}

/**
 * Read all issues for a project. Returns empty array if file doesn't exist.
 */
export async function readIssues(projectName: string): Promise<Issue[]> {
    try {
        const content = await readFile(issuesPath(projectName), 'utf-8');
        return JSON.parse(content) as Issue[];
    } catch {
        return [];
    }
}

/**
 * Write issues array to disk.
 */
async function writeIssues(projectName: string, issues: Issue[]): Promise<void> {
    await writeFile(issuesPath(projectName), JSON.stringify(issues, null, 2) + '\n', 'utf-8');
}

/**
 * Create a new issue. Auto-generates an incremental ID.
 *
 * @returns The created issue
 */
export async function createIssue(
    projectName: string,
    title: string,
    description: string,
    source: IssueSource,
    iteration: number,
): Promise<Issue> {
    const issues = await readIssues(projectName);

    // Generate next ID
    const maxNum = issues.reduce((max, iss) => {
        const match = iss.id.match(/^issue-(\d+)$/);
        return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);

    const issue: Issue = {
        id: `issue-${maxNum + 1}`,
        title,
        description,
        source,
        iteration,
        status: 'open',
        createdAt: new Date().toISOString(),
    };

    issues.push(issue);
    await writeIssues(projectName, issues);
    return issue;
}

/**
 * Update an existing issue.
 * Supports partial updates: status, resolvedBy, closedAt.
 *
 * @returns The updated issue
 */
export async function updateIssue(
    projectName: string,
    issueId: string,
    updates: {
        status?: IssueStatus;
        resolvedBy?: IssueResolvedBy;
    },
): Promise<Issue> {
    const issues = await readIssues(projectName);
    const issue = issues.find((i) => i.id === issueId);

    if (!issue) {
        throw new Error(`Issue "${issueId}" not found.`);
    }

    if (updates.status !== undefined) {
        issue.status = updates.status;
        if (updates.status === 'closed') {
            issue.closedAt = new Date().toISOString();
        }
    }

    if (updates.resolvedBy !== undefined) {
        issue.resolvedBy = updates.resolvedBy;
    }

    await writeIssues(projectName, issues);
    return issue;
}

export interface IssueFilters {
    status?: IssueStatus;
    source?: IssueSource;
    iteration?: number;
}

/**
 * List issues with optional filters.
 */
export async function listIssues(projectName: string, filters?: IssueFilters): Promise<Issue[]> {
    let issues = await readIssues(projectName);

    if (filters) {
        if (filters.status) {
            issues = issues.filter((i) => i.status === filters.status);
        }
        if (filters.source) {
            issues = issues.filter((i) => i.source === filters.source);
        }
        if (filters.iteration !== undefined) {
            issues = issues.filter((i) => i.iteration === filters.iteration);
        }
    }

    return issues;
}
