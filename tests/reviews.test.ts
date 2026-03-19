import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { submitForReview, resolveReview, getArtifactReview, getPendingReviews } from '../src/core/reviews.js';

const TEST_PROJECT = 'test-project';
const ITER = 1;

describe('artifact review system', () => {
    let harmoniaHome: string;
    let iterDir: string;

    beforeEach(async () => {
        harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-review-test-'));
        iterDir = join(harmoniaHome, TEST_PROJECT, 'iter-' + ITER);
        // Create the iteration dir (normally done by startIteration)
        await mkdir(join(harmoniaHome, TEST_PROJECT, `iter-${ITER}`), { recursive: true });
    });

    afterEach(async () => {
        await rm(harmoniaHome, { recursive: true, force: true });
    });

    it('should submit an artifact for review', async () => {
        const review = await submitForReview(TEST_PROJECT, ITER, 'prd', iterDir);
        expect(review.artifactId).toBe('prd');
        expect(review.status).toBe('pending');
        expect(review.submittedAt).toBeDefined();
    });

    it('should approve a pending review', async () => {
        await submitForReview(TEST_PROJECT, ITER, 'prd', iterDir);
        const review = await resolveReview(TEST_PROJECT, ITER, 'prd', 'approved', undefined, iterDir);
        expect(review.status).toBe('approved');
        expect(review.reviewedAt).toBeDefined();
    });

    it('should reject a pending review with comment', async () => {
        await submitForReview(TEST_PROJECT, ITER, 'prd', iterDir);
        const review = await resolveReview(
            TEST_PROJECT,
            ITER,
            'prd',
            'rejected',
            'Needs more detail on error handling',
            iterDir,
        );
        expect(review.status).toBe('rejected');
        expect(review.comment).toBe('Needs more detail on error handling');
    });

    it('should throw when resolving non-existent review', async () => {
        await expect(resolveReview(TEST_PROJECT, ITER, 'nonexistent', 'approved', undefined, iterDir)).rejects.toThrow(
            'No review pending',
        );
    });

    it('should throw when resolving already resolved review', async () => {
        await submitForReview(TEST_PROJECT, ITER, 'prd', iterDir);
        await resolveReview(TEST_PROJECT, ITER, 'prd', 'approved', undefined, iterDir);
        await expect(resolveReview(TEST_PROJECT, ITER, 'prd', 'approved', undefined, iterDir)).rejects.toThrow(
            'already approved',
        );
    });

    it('should get a specific artifact review', async () => {
        await submitForReview(TEST_PROJECT, ITER, 'prd', iterDir);
        const review = await getArtifactReview(TEST_PROJECT, ITER, 'prd', iterDir);
        expect(review).not.toBeNull();
        expect(review!.artifactId).toBe('prd');
    });

    it('should return null for non-existent artifact review', async () => {
        const review = await getArtifactReview(TEST_PROJECT, ITER, 'nonexistent', iterDir);
        expect(review).toBeNull();
    });

    it('should list pending reviews', async () => {
        await submitForReview(TEST_PROJECT, ITER, 'prd', iterDir);
        await submitForReview(TEST_PROJECT, ITER, 'prototype', iterDir);
        await resolveReview(TEST_PROJECT, ITER, 'prd', 'approved', undefined, iterDir);

        const pending = await getPendingReviews(TEST_PROJECT, ITER, iterDir);
        expect(pending).toHaveLength(1);
        expect(pending[0].artifactId).toBe('prototype');
    });

    it('should return empty list when no pending reviews', async () => {
        const pending = await getPendingReviews(TEST_PROJECT, ITER, iterDir);
        expect(pending).toHaveLength(0);
    });

    it('should allow re-submitting a previously resolved artifact', async () => {
        await submitForReview(TEST_PROJECT, ITER, 'prd', iterDir);
        await resolveReview(TEST_PROJECT, ITER, 'prd', 'rejected', 'Needs work', iterDir);

        // Re-submit after rejection (doc was revised)
        const review = await submitForReview(TEST_PROJECT, ITER, 'prd', iterDir);
        expect(review.status).toBe('pending');
        expect(review.comment).toBeUndefined();
    });
});
