import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeArtifact, readArtifact, listArtifacts, resolveArtifactDir } from '../src/core/artifacts.js';
import type { ArtifactIOContext } from '../src/core/artifacts.js';

const TEST_PROJECT = 'test-project';
const ITER = 1;

describe('artifact management', () => {
    let harmoniaHome: string;
    let iterDir: string;
    let ioCtx: ArtifactIOContext;

    beforeEach(async () => {
        harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-artifacts-test-'));
        iterDir = join(harmoniaHome, TEST_PROJECT, `iter-${ITER}`);
        // Create the iteration artifacts dir (normally done by startIteration)
        await mkdir(join(iterDir, 'artifacts'), { recursive: true });
        ioCtx = {
            contextDir: iterDir,
            projectDir: join(harmoniaHome, TEST_PROJECT),
            contextLabel: `iter-${ITER}`,
        };
    });

    afterEach(async () => {
        await rm(harmoniaHome, { recursive: true, force: true });
    });

    it('should write and read an artifact', async () => {
        const content = '# PRD\n\nThis is the product requirements document.';
        await writeArtifact('prd', content, ioCtx);
        const result = await readArtifact('prd', ioCtx);

        expect(result).toBe(content);
    });

    it('should list artifacts', async () => {
        await writeArtifact('prd', '# PRD', ioCtx);
        await writeArtifact('user-stories', '# User Stories', ioCtx);

        const artifacts = await listArtifacts(ioCtx, {});
        expect(artifacts.sort()).toEqual(['prd', 'user-stories']);
    });

    it('should return empty list when no artifacts exist', async () => {
        const artifacts = await listArtifacts(ioCtx, {});
        expect(artifacts).toEqual([]);
    });

    it('should overwrite existing artifact', async () => {
        await writeArtifact('prd', 'v1', ioCtx);
        await writeArtifact('prd', 'v2', ioCtx);
        const result = await readArtifact('prd', ioCtx);

        expect(result).toBe('v2');
    });

    it('should throw when reading non-existent artifact', async () => {
        await expect(readArtifact('nonexistent', ioCtx)).rejects.toThrow();
    });

    it('should write and read an HTML artifact', async () => {
        const html = '<html><body><h1>Prototype</h1></body></html>';
        const artifactDef = {
            name: 'Prototype',
            format: 'html' as const,
        };
        await writeArtifact('prototype', html, ioCtx, artifactDef);
        const result = await readArtifact('prototype', ioCtx);
        expect(result).toBe(html);
    });

    it('should list both md and html artifacts', async () => {
        await writeArtifact('prd', '# PRD', ioCtx);
        const artifactDef = {
            name: 'Prototype',
            format: 'html' as const,
        };
        await writeArtifact('prototype', '<html></html>', ioCtx, artifactDef);

        const artifacts = await listArtifacts(ioCtx, {});
        expect(artifacts.sort()).toEqual(['prd', 'prototype']);
    });
});

// ─── resolveArtifactDir Tests ───

describe('resolveArtifactDir', () => {
    const ioCtx: ArtifactIOContext = {
        contextDir: '/data/my-project/iter-1',
        projectDir: '/src/my-project',
        contextLabel: 'iter-1',
    };

    it('should return default artifacts dir when output is undefined', () => {
        const result = resolveArtifactDir(undefined, ioCtx);
        expect(result).toBe(join('/data/my-project/iter-1', 'artifacts'));
    });

    it('should resolve {global} to contextDir/artifacts/', () => {
        const result = resolveArtifactDir('{global}', ioCtx);
        expect(result).toBe(join('/data/my-project/iter-1', 'artifacts'));
    });

    it('should resolve {global}/subdir', () => {
        const result = resolveArtifactDir('{global}/prds', ioCtx);
        expect(result).toBe(join('/data/my-project/iter-1', 'artifacts') + '/prds');
    });

    it('should resolve {project} to projectDir/', () => {
        const result = resolveArtifactDir('{project}', ioCtx);
        expect(result).toBe('/src/my-project');
    });

    it('should resolve {project}/subdir', () => {
        const result = resolveArtifactDir('{project}/docs', ioCtx);
        expect(result).toBe('/src/my-project/docs');
    });

    it('should resolve {project}/{context}/subdir', () => {
        const result = resolveArtifactDir('{project}/{context}/docs', ioCtx);
        expect(result).toBe('/src/my-project/iter-1/docs');
    });

    it('should resolve {global}/{context}', () => {
        const result = resolveArtifactDir('{global}/{context}', ioCtx);
        expect(result).toBe(join('/data/my-project/iter-1', 'artifacts') + '/iter-1');
    });

    it('should handle patch context', () => {
        const patchCtx: ArtifactIOContext = {
            contextDir: '/data/my-project/patch-2',
            projectDir: '/src/my-project',
            contextLabel: 'patch-2',
        };
        const result = resolveArtifactDir('{project}/{context}/docs', patchCtx);
        expect(result).toBe('/src/my-project/patch-2/docs');
    });
});

// ─── Output Path Write/Read Integration Tests ───

describe('artifact I/O with output paths', () => {
    let harmoniaHome: string;
    let iterDir: string;
    let projectDir: string;

    beforeEach(async () => {
        harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-output-test-'));
        iterDir = join(harmoniaHome, 'iter-1');
        projectDir = join(harmoniaHome, 'project');
        await mkdir(join(iterDir, 'artifacts'), { recursive: true });
        await mkdir(projectDir, { recursive: true });
    });

    afterEach(async () => {
        await rm(harmoniaHome, { recursive: true, force: true });
    });

    const makeIoCtx = (home: string): ArtifactIOContext => ({
        contextDir: join(home, 'iter-1'),
        projectDir: join(home, 'project'),
        contextLabel: 'iter-1',
    });

    it('should write to {project}/docs and read back', async () => {
        const ioCtx = makeIoCtx(harmoniaHome);
        const artifactDef = { name: 'Spec', output: '{project}/docs' };
        const content = '# Specification';

        const filePath = await writeArtifact('spec', content, ioCtx, artifactDef);
        expect(filePath).toBe(join(projectDir, 'docs', 'spec.md'));

        const result = await readArtifact('spec', ioCtx, artifactDef);
        expect(result).toBe(content);
    });

    it('should write to {global}/prds subdirectory', async () => {
        const ioCtx = makeIoCtx(harmoniaHome);
        const artifactDef = { name: 'PRD', output: '{global}/prds' };
        const content = '# PRD';

        const filePath = await writeArtifact('prd', content, ioCtx, artifactDef);
        expect(filePath).toBe(join(iterDir, 'artifacts', 'prds', 'prd.md'));

        const result = await readArtifact('prd', ioCtx, artifactDef);
        expect(result).toBe(content);
    });

    it('should list artifacts across different output paths using definitions', async () => {
        const ioCtx = makeIoCtx(harmoniaHome);
        const defs = {
            prd: { name: 'PRD', output: '{global}/prds' },
            spec: { name: 'Spec', output: '{project}/docs' },
            missing: { name: 'Missing' }, // default path, not written
        };

        await writeArtifact('prd', '# PRD', ioCtx, defs.prd);
        await writeArtifact('spec', '# Spec', ioCtx, defs.spec);

        const found = await listArtifacts(ioCtx, defs);
        expect(found.sort()).toEqual(['prd', 'spec']);
    });
});
