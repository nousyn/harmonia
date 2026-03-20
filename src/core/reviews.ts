/**
 * Artifact review state management — <context_dir>/reviews.json
 *
 * Tracks which artifacts are pending review, approved, or rejected.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ReviewState } from './types.js';

const REVIEWS_FILE = 'reviews.json';

interface ReviewsData {
    artifacts: Record<string, ReviewState>;
}

function reviewsPath(projectName: string, iteration: number, contextDir?: string): string {
    return join(contextDir!, REVIEWS_FILE);
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
        return data.artifacts ?? {};
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
    artifacts: Record<string, ReviewState>,
    contextDir?: string,
): Promise<void> {
    const filePath = reviewsPath(projectName, iteration, contextDir);
    await mkdir(dirname(filePath), { recursive: true });
    const data: ReviewsData = { artifacts };
    await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Submit an artifact for review. Sets status to "pending".
 */
export async function submitForReview(
    projectName: string,
    iteration: number,
    artifactId: string,
    contextDir?: string,
): Promise<ReviewState> {
    const reviews = await readReviews(projectName, iteration, contextDir);
    const state: ReviewState = {
        artifactId,
        status: 'pending',
        submittedAt: new Date().toISOString(),
    };
    reviews[artifactId] = state;
    await writeReviews(projectName, iteration, reviews, contextDir);
    return state;
}

/**
 * Approve or reject an artifact review.
 */
export async function resolveReview(
    projectName: string,
    iteration: number,
    artifactId: string,
    status: 'approved' | 'rejected',
    comment?: string,
    contextDir?: string,
): Promise<ReviewState> {
    const reviews = await readReviews(projectName, iteration, contextDir);
    const existing = reviews[artifactId];

    if (!existing) {
        throw new Error(`No review pending for artifact "${artifactId}". Submit it for review first.`);
    }

    if (existing.status !== 'pending') {
        throw new Error(`Artifact "${artifactId}" review is already ${existing.status}.`);
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
 * Get the review state for a specific artifact.
 */
export async function getArtifactReview(
    projectName: string,
    iteration: number,
    artifactId: string,
    contextDir?: string,
): Promise<ReviewState | null> {
    const reviews = await readReviews(projectName, iteration, contextDir);
    return reviews[artifactId] ?? null;
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
