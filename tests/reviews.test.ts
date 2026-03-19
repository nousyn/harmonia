import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { submitForReview, resolveReview, getDocReview, getPendingReviews } from '../src/core/reviews.js';

const TEST_PROJECT = 'test-project';
const ITER = 1;

describe('document review system', () => {
    let harmoniaHome: string;

    beforeEach(async () => {
        harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-review-test-'));
        process.env.HARMONIA_DATA_DIR = harmoniaHome;
        // Create the iteration dir (normally done by startIteration)
        await mkdir(join(harmoniaHome, TEST_PROJECT, `iter-${ITER}`), { recursive: true });
    });

    afterEach(async () => {
        delete process.env.HARMONIA_DATA_DIR;
        await rm(harmoniaHome, { recursive: true, force: true });
    });

    it('should submit a document for review', async () => {
        const review = await submitForReview(TEST_PROJECT, ITER, 'prd');
        expect(review.artifactId).toBe('prd');
        expect(review.status).toBe('pending');
        expect(review.submittedAt).toBeDefined();
    });

    it('should approve a pending review', async () => {
        await submitForReview(TEST_PROJECT, ITER, 'prd');
        const review = await resolveReview(TEST_PROJECT, ITER, 'prd', 'approved');
        expect(review.status).toBe('approved');
        expect(review.reviewedAt).toBeDefined();
    });

    it('should reject a pending review with comment', async () => {
        await submitForReview(TEST_PROJECT, ITER, 'prd');
        const review = await resolveReview(
            TEST_PROJECT,
            ITER,
            'prd',
            'rejected',
            'Needs more detail on error handling',
        );
        expect(review.status).toBe('rejected');
        expect(review.comment).toBe('Needs more detail on error handling');
    });

    it('should throw when resolving non-existent review', async () => {
        await expect(resolveReview(TEST_PROJECT, ITER, 'nonexistent', 'approved')).rejects.toThrow('No review pending');
    });

    it('should throw when resolving already resolved review', async () => {
        await submitForReview(TEST_PROJECT, ITER, 'prd');
        await resolveReview(TEST_PROJECT, ITER, 'prd', 'approved');
        await expect(resolveReview(TEST_PROJECT, ITER, 'prd', 'approved')).rejects.toThrow('already approved');
    });

    it('should get a specific doc review', async () => {
        await submitForReview(TEST_PROJECT, ITER, 'prd');
        const review = await getDocReview(TEST_PROJECT, ITER, 'prd');
        expect(review).not.toBeNull();
        expect(review!.artifactId).toBe('prd');
    });

    it('should return null for non-existent doc review', async () => {
        const review = await getDocReview(TEST_PROJECT, ITER, 'nonexistent');
        expect(review).toBeNull();
    });

    it('should list pending reviews', async () => {
        await submitForReview(TEST_PROJECT, ITER, 'prd');
        await submitForReview(TEST_PROJECT, ITER, 'prototype');
        await resolveReview(TEST_PROJECT, ITER, 'prd', 'approved');

        const pending = await getPendingReviews(TEST_PROJECT, ITER);
        expect(pending).toHaveLength(1);
        expect(pending[0].artifactId).toBe('prototype');
    });

    it('should return empty list when no pending reviews', async () => {
        const pending = await getPendingReviews(TEST_PROJECT, ITER);
        expect(pending).toHaveLength(0);
    });

    it('should allow re-submitting a previously resolved doc', async () => {
        await submitForReview(TEST_PROJECT, ITER, 'prd');
        await resolveReview(TEST_PROJECT, ITER, 'prd', 'rejected', 'Needs work');

        // Re-submit after rejection (doc was revised)
        const review = await submitForReview(TEST_PROJECT, ITER, 'prd');
        expect(review.status).toBe('pending');
        expect(review.comment).toBeUndefined();
    });
});
