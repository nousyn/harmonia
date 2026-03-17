import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeDoc, readDoc, listDocs } from '../src/core/docs.js';

const TEST_PROJECT = 'test-project';
const ITER = 1;

describe('document management', () => {
    let harmoniaHome: string;

    beforeEach(async () => {
        harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-docs-test-'));
        process.env.HARMONIA_DATA_DIR = harmoniaHome;
        // Create the iteration docs dir (normally done by startIteration)
        await mkdir(join(harmoniaHome, TEST_PROJECT, `iter-${ITER}`, 'docs'), { recursive: true });
    });

    afterEach(async () => {
        delete process.env.HARMONIA_DATA_DIR;
        await rm(harmoniaHome, { recursive: true, force: true });
    });

    it('should write and read a document', async () => {
        const content = '# PRD\n\nThis is the product requirements document.';
        await writeDoc(TEST_PROJECT, ITER, 'prd', content);
        const result = await readDoc(TEST_PROJECT, ITER, 'prd');

        expect(result).toBe(content);
    });

    it('should list documents', async () => {
        await writeDoc(TEST_PROJECT, ITER, 'prd', '# PRD');
        await writeDoc(TEST_PROJECT, ITER, 'user-stories', '# User Stories');

        const docs = await listDocs(TEST_PROJECT, ITER);
        expect(docs.sort()).toEqual(['prd', 'user-stories']);
    });

    it('should return empty list when no docs exist', async () => {
        const docs = await listDocs(TEST_PROJECT, ITER);
        expect(docs).toEqual([]);
    });

    it('should overwrite existing document', async () => {
        await writeDoc(TEST_PROJECT, ITER, 'prd', 'v1');
        await writeDoc(TEST_PROJECT, ITER, 'prd', 'v2');
        const result = await readDoc(TEST_PROJECT, ITER, 'prd');

        expect(result).toBe('v2');
    });

    it('should throw when reading non-existent document', async () => {
        await expect(readDoc(TEST_PROJECT, ITER, 'nonexistent')).rejects.toThrow();
    });

    it('should write and read an HTML document', async () => {
        const html = '<html><body><h1>Prototype</h1></body></html>';
        await writeDoc(TEST_PROJECT, ITER, 'prototype', html, {
            name: 'Prototype',
            format: 'html',
            scale: { small: 'skip', medium: 'optional', large: 'full' },
        });
        const result = await readDoc(TEST_PROJECT, ITER, 'prototype');
        expect(result).toBe(html);
    });

    it('should list both md and html documents', async () => {
        await writeDoc(TEST_PROJECT, ITER, 'prd', '# PRD');
        await writeDoc(TEST_PROJECT, ITER, 'prototype', '<html></html>', {
            name: 'Prototype',
            format: 'html',
            scale: { small: 'skip', medium: 'optional', large: 'full' },
        });

        const docs = await listDocs(TEST_PROJECT, ITER);
        expect(docs.sort()).toEqual(['prd', 'prototype']);
    });
});
