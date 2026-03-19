import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeArtifact, readArtifact, listArtifacts } from '../src/core/artifacts.js';

const TEST_PROJECT = 'test-project';
const ITER = 1;

describe('artifact management', () => {
    let harmoniaHome: string;
    let iterDir: string;

    beforeEach(async () => {
        harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-artifacts-test-'));
        iterDir = join(harmoniaHome, TEST_PROJECT, `iter-${ITER}`);
        // Create the iteration artifacts dir (normally done by startIteration)
        await mkdir(join(iterDir, 'artifacts'), { recursive: true });
    });

    afterEach(async () => {
        await rm(harmoniaHome, { recursive: true, force: true });
    });

    it('should write and read an artifact', async () => {
        const content = '# PRD\n\nThis is the product requirements document.';
        await writeArtifact(TEST_PROJECT, ITER, 'prd', content, undefined, iterDir);
        const result = await readArtifact(TEST_PROJECT, ITER, 'prd', iterDir);

        expect(result).toBe(content);
    });

    it('should list artifacts', async () => {
        await writeArtifact(TEST_PROJECT, ITER, 'prd', '# PRD', undefined, iterDir);
        await writeArtifact(TEST_PROJECT, ITER, 'user-stories', '# User Stories', undefined, iterDir);

        const artifacts = await listArtifacts(TEST_PROJECT, ITER, iterDir);
        expect(artifacts.sort()).toEqual(['prd', 'user-stories']);
    });

    it('should return empty list when no artifacts exist', async () => {
        const artifacts = await listArtifacts(TEST_PROJECT, ITER, iterDir);
        expect(artifacts).toEqual([]);
    });

    it('should overwrite existing artifact', async () => {
        await writeArtifact(TEST_PROJECT, ITER, 'prd', 'v1', undefined, iterDir);
        await writeArtifact(TEST_PROJECT, ITER, 'prd', 'v2', undefined, iterDir);
        const result = await readArtifact(TEST_PROJECT, ITER, 'prd', iterDir);

        expect(result).toBe('v2');
    });

    it('should throw when reading non-existent artifact', async () => {
        await expect(readArtifact(TEST_PROJECT, ITER, 'nonexistent', iterDir)).rejects.toThrow();
    });

    it('should write and read an HTML artifact', async () => {
        const html = '<html><body><h1>Prototype</h1></body></html>';
        await writeArtifact(
            TEST_PROJECT,
            ITER,
            'prototype',
            html,
            {
                name: 'Prototype',
                format: 'html',
                scale: { small: 'skip', medium: 'optional', large: 'full' },
            },
            iterDir,
        );
        const result = await readArtifact(TEST_PROJECT, ITER, 'prototype', iterDir);
        expect(result).toBe(html);
    });

    it('should list both md and html artifacts', async () => {
        await writeArtifact(TEST_PROJECT, ITER, 'prd', '# PRD', undefined, iterDir);
        await writeArtifact(
            TEST_PROJECT,
            ITER,
            'prototype',
            '<html></html>',
            {
                name: 'Prototype',
                format: 'html',
                scale: { small: 'skip', medium: 'optional', large: 'full' },
            },
            iterDir,
        );

        const artifacts = await listArtifacts(TEST_PROJECT, ITER, iterDir);
        expect(artifacts.sort()).toEqual(['prd', 'prototype']);
    });
});
