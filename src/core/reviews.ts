/**
 * Document review state management — <data_dir>/<project_name>/reviews.json
 *
 * Tracks which documents are pending review, approved, or rejected.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getProjectDataDir } from './registry.js';
import type { DocReviewState, ReviewStatus } from './types.js';

const REVIEWS_FILE = 'reviews.json';

interface ReviewsData {
    docs: Record<string, DocReviewState>;
}

function reviewsPath(projectName: string): string {
    return join(getProjectDataDir(projectName), REVIEWS_FILE);
}

/**
 * Read the reviews state for a project.
 */
export async function readReviews(projectName: string): Promise<Record<string, DocReviewState>> {
    try {
        const content = await readFile(reviewsPath(projectName), 'utf-8');
        const data = JSON.parse(content) as ReviewsData;
        return data.docs ?? {};
    } catch {
        return {};
    }
}

/**
 * Write reviews state to disk.
 */
async function writeReviews(projectName: string, docs: Record<string, DocReviewState>): Promise<void> {
    const filePath = reviewsPath(projectName);
    await mkdir(dirname(filePath), { recursive: true });
    const data: ReviewsData = { docs };
    await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Submit a document for review. Sets status to "pending".
 */
export async function submitForReview(projectName: string, docId: string): Promise<DocReviewState> {
    const reviews = await readReviews(projectName);
    const state: DocReviewState = {
        docId,
        status: 'pending',
        submittedAt: new Date().toISOString(),
    };
    reviews[docId] = state;
    await writeReviews(projectName, reviews);
    return state;
}

/**
 * Approve or reject a document review.
 */
export async function resolveReview(
    projectName: string,
    docId: string,
    status: 'approved' | 'rejected',
    comment?: string,
): Promise<DocReviewState> {
    const reviews = await readReviews(projectName);
    const existing = reviews[docId];

    if (!existing) {
        throw new Error(`No review pending for document "${docId}". Submit it for review first.`);
    }

    if (existing.status !== 'pending') {
        throw new Error(`Document "${docId}" review is already ${existing.status}.`);
    }

    existing.status = status;
    existing.reviewedAt = new Date().toISOString();
    if (comment) {
        existing.comment = comment;
    }

    await writeReviews(projectName, reviews);
    return existing;
}

/**
 * Get the review state for a specific document.
 */
export async function getDocReview(projectName: string, docId: string): Promise<DocReviewState | null> {
    const reviews = await readReviews(projectName);
    return reviews[docId] ?? null;
}

/**
 * Get all pending reviews for a project.
 */
export async function getPendingReviews(projectName: string): Promise<DocReviewState[]> {
    const reviews = await readReviews(projectName);
    return Object.values(reviews).filter((r) => r.status === 'pending');
}
