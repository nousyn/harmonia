import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeDoc, readDoc, listDocs } from '../src/core/docs.js';

const TEST_PROJECT = 'test-project';

describe('document management', () => {
    let harmoniaHome: string;

    beforeEach(async () => {
        harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-docs-test-'));
        process.env.HARMONIA_HOME = harmoniaHome;
        // Create the project docs dir (normally done by registerProject)
        await mkdir(join(harmoniaHome, TEST_PROJECT, 'docs'), { recursive: true });
    });

    afterEach(async () => {
        delete process.env.HARMONIA_HOME;
        await rm(harmoniaHome, { recursive: true, force: true });
    });

    it('should write and read a document', async () => {
        const content = '# PRD\n\nThis is the product requirements document.';
        await writeDoc(TEST_PROJECT, 'prd', content);
        const result = await readDoc(TEST_PROJECT, 'prd');

        expect(result).toBe(content);
    });

    it('should list documents', async () => {
        await writeDoc(TEST_PROJECT, 'prd', '# PRD');
        await writeDoc(TEST_PROJECT, 'user-stories', '# User Stories');

        const docs = await listDocs(TEST_PROJECT);
        expect(docs.sort()).toEqual(['prd', 'user-stories']);
    });

    it('should return empty list when no docs exist', async () => {
        const docs = await listDocs(TEST_PROJECT);
        expect(docs).toEqual([]);
    });

    it('should overwrite existing document', async () => {
        await writeDoc(TEST_PROJECT, 'prd', 'v1');
        await writeDoc(TEST_PROJECT, 'prd', 'v2');
        const result = await readDoc(TEST_PROJECT, 'prd');

        expect(result).toBe('v2');
    });

    it('should throw when reading non-existent document', async () => {
        await expect(readDoc(TEST_PROJECT, 'nonexistent')).rejects.toThrow();
    });
});
