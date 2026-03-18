/**
 * Document review state management — <context_dir>/reviews.json
 *
 * Tracks which documents are pending review, approved, or rejected.
 * All public functions accept an optional contextDir parameter.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getIterationDir } from './registry.js';
import type { ReviewState, ReviewStatus } from './types.js';

const REVIEWS_FILE = 'reviews.json';

interface ReviewsData {
    docs: Record<string, ReviewState>;
}

function reviewsPath(projectName: string, iteration: number, contextDir?: string): string {
    const base = contextDir ?? getIterationDir(projectName, iteration);
    return join(base, REVIEWS_FILE);
}

/**
 * Read the reviews state for a project context.
 */
export async function readReviews(
    projectName: string,
    iteration: number,
    contextDir?: string,
): Promise<Record<string, ReviewState>> {
    try {
        const content = await readFile(reviewsPath(projectName, iteration, contextDir), 'utf-8');
        const data = JSON.parse(content) as ReviewsData;
        return data.docs ?? {};
    } catch {
        return {};
    }
}

/**
 * Write reviews state to disk.
 */
async function writeReviews(
    projectName: string,
    iteration: number,
    docs: Record<string, ReviewState>,
    contextDir?: string,
): Promise<void> {
    const filePath = reviewsPath(projectName, iteration, contextDir);
    await mkdir(dirname(filePath), { recursive: true });
    const data: ReviewsData = { docs };
    await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Submit a document for review. Sets status to "pending".
 */
export async function submitForReview(
    projectName: string,
    iteration: number,
    docId: string,
    contextDir?: string,
): Promise<ReviewState> {
    const reviews = await readReviews(projectName, iteration, contextDir);
    const state: ReviewState = {
        artifactId: docId,
        status: 'pending',
        submittedAt: new Date().toISOString(),
    };
    reviews[docId] = state;
    await writeReviews(projectName, iteration, reviews, contextDir);
    return state;
}

/**
 * Approve or reject a document review.
 */
export async function resolveReview(
    projectName: string,
    iteration: number,
    docId: string,
    status: 'approved' | 'rejected',
    comment?: string,
    contextDir?: string,
): Promise<ReviewState> {
    const reviews = await readReviews(projectName, iteration, contextDir);
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

    await writeReviews(projectName, iteration, reviews, contextDir);
    return existing;
}

/**
 * Get the review state for a specific document.
 */
export async function getDocReview(
    projectName: string,
    iteration: number,
    docId: string,
    contextDir?: string,
): Promise<ReviewState | null> {
    const reviews = await readReviews(projectName, iteration, contextDir);
    return reviews[docId] ?? null;
}

/**
 * Get all pending reviews for a project context.
 */
export async function getPendingReviews(
    projectName: string,
    iteration: number,
    contextDir?: string,
): Promise<ReviewState[]> {
    const reviews = await readReviews(projectName, iteration, contextDir);
    return Object.values(reviews).filter((r) => r.status === 'pending');
}
