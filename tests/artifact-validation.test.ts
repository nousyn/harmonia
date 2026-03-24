/**
 * Tests for artifact validation functions added in Phase 1.5:
 * - artifactFileExists()
 * - validateArtifactContent() with three modes: none, schema, command
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { artifactFileExists, validateArtifactContent, writeArtifact } from '../src/core/artifacts.js';
import type { ArtifactIOContext } from '../src/core/artifacts.js';
import type { ArtifactDefinition, ValidationConfig } from '../src/core/types.js';

const TEST_PROJECT = 'test-project';
const ITER = 1;

describe('artifact validation', () => {
    let harmoniaHome: string;
    let iterDir: string;
    let ioCtx: ArtifactIOContext;
    let workflowsDir: string;

    beforeEach(async () => {
        harmoniaHome = await mkdtemp(join(tmpdir(), 'harmonia-artval-'));
        iterDir = join(harmoniaHome, TEST_PROJECT, `iter-${ITER}`);
        await mkdir(join(iterDir, 'artifacts'), { recursive: true });
        ioCtx = {
            contextDir: iterDir,
            projectDir: join(harmoniaHome, TEST_PROJECT),
            contextLabel: `iter-${ITER}`,
        };
        // Create a minimal workflow dir for schema validation
        workflowsDir = join(harmoniaHome, 'workflows');
        await mkdir(join(workflowsDir, 'test-wf', 'schemas'), { recursive: true });
        // resolveWorkflowDir requires workflow.json to exist
        await writeFile(
            join(workflowsDir, 'test-wf', 'workflow.json'),
            JSON.stringify({
                name: 'test-wf',
                description: 'test',
                coordinator: 'c',
                root: { type: 'task', id: 't', role: 'r' },
            }),
            'utf-8',
        );
    });

    afterEach(async () => {
        await rm(harmoniaHome, { recursive: true, force: true });
    });

    // ─── artifactFileExists ───

    describe('artifactFileExists', () => {
        it('should return true when artifact file exists', async () => {
            await writeArtifact('prd', '# PRD', ioCtx);
            const exists = await artifactFileExists('prd', ioCtx);
            expect(exists).toBe(true);
        });

        it('should return false when artifact file does not exist', async () => {
            const exists = await artifactFileExists('nonexistent', ioCtx);
            expect(exists).toBe(false);
        });

        it('should detect HTML artifacts when definition is provided', async () => {
            const artifactDef: ArtifactDefinition = { name: 'Prototype', format: 'html' };
            await writeArtifact('prototype', '<html></html>', ioCtx, artifactDef);
            const exists = await artifactFileExists('prototype', ioCtx, artifactDef);
            expect(exists).toBe(true);
        });

        it('should return false for wrong extension when no definition', async () => {
            const artifactDef: ArtifactDefinition = { name: 'Prototype', format: 'html' };
            await writeArtifact('prototype', '<html></html>', ioCtx, artifactDef);
            // Without artifact def, it looks for .md by default
            const exists = await artifactFileExists('prototype', ioCtx);
            expect(exists).toBe(false);
        });
    });

    // ─── validateArtifactContent — type: 'none' ───

    describe('validateArtifactContent — none', () => {
        it('should always return valid for type none', async () => {
            const config: ValidationConfig = { type: 'none' };
            const result = await validateArtifactContent('prd', 'any content', config);
            expect(result.valid).toBe(true);
            expect(result.errors).toEqual([]);
        });

        it('should return valid even with empty content', async () => {
            const config: ValidationConfig = { type: 'none' };
            const result = await validateArtifactContent('prd', '', config);
            expect(result.valid).toBe(true);
        });
    });

    // ─── validateArtifactContent — type: 'schema' ───

    describe('validateArtifactContent — schema', () => {
        it('should pass when no schema file exists (schema is optional)', async () => {
            const config: ValidationConfig = { type: 'schema' };
            const result = await validateArtifactContent('no-schema-artifact', 'content', config, {
                workflowsDir,
                workflowName: 'test-wf',
            });
            expect(result.valid).toBe(true);
        });

        it('should fail when workflowsDir is missing', async () => {
            const config: ValidationConfig = { type: 'schema' };
            const result = await validateArtifactContent('prd', 'content', config);
            expect(result.valid).toBe(false);
            expect(result.errors[0]).toContain('workflowsDir');
        });

        it('should validate content against schema', async () => {
            // Create a schema requiring specific sections (headings must include # for level matching)
            const schema = {
                sections: [
                    { heading: '# Overview', required: true },
                    { heading: '# Requirements', required: true },
                ],
            };
            await writeFile(join(workflowsDir, 'test-wf', 'schemas', 'prd.json'), JSON.stringify(schema), 'utf-8');

            const config: ValidationConfig = { type: 'schema' };

            // Content with required sections
            const validContent = '# Overview\n\nThis is a long enough overview section.\n\n# Requirements\n\n- Item 1';
            const validResult = await validateArtifactContent('prd', validContent, config, {
                workflowsDir,
                workflowName: 'test-wf',
            });
            expect(validResult.valid).toBe(true);

            // Content missing required section
            const invalidContent = '# Overview\n\nShort overview content here.\n\n# Other\n\nSomething';
            const invalidResult = await validateArtifactContent('prd', invalidContent, config, {
                workflowsDir,
                workflowName: 'test-wf',
            });
            expect(invalidResult.valid).toBe(false);
            expect(invalidResult.errors.length).toBeGreaterThan(0);
        });
    });

    // ─── validateArtifactContent — type: 'command' ───

    describe('validateArtifactContent — command', () => {
        it('should fail when filePath is missing', async () => {
            const config: ValidationConfig = { type: 'command', command: 'true' };
            const result = await validateArtifactContent('prd', 'content', config);
            expect(result.valid).toBe(false);
            expect(result.errors[0]).toContain('filePath');
        });

        it('should pass when command exits with 0', async () => {
            const config: ValidationConfig = { type: 'command', command: 'true' };
            const filePath = join(iterDir, 'artifacts', 'prd.md');
            await writeFile(filePath, 'content', 'utf-8');

            const result = await validateArtifactContent('prd', 'content', config, { filePath });
            expect(result.valid).toBe(true);
            expect(result.errors).toEqual([]);
        });

        it('should fail when command exits with non-zero', async () => {
            const config: ValidationConfig = { type: 'command', command: 'false' };
            const filePath = join(iterDir, 'artifacts', 'prd.md');
            await writeFile(filePath, 'content', 'utf-8');

            const result = await validateArtifactContent('prd', 'content', config, { filePath });
            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        });
    });
});
