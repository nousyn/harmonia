import { describe, it, expect } from 'vitest';
import { loadWorkflow, listWorkflows } from '../src/core/workflow.js';
import { resolve, join } from 'node:path';

const WORKFLOWS_DIR = resolve(join(import.meta.dirname, '..', 'workflows'));
const NO_CUSTOM_DIR = join(WORKFLOWS_DIR, '..', '.workflows-nonexistent');

describe('workflow loader', () => {
    it('should list available workflows', async () => {
        const workflows = await listWorkflows(WORKFLOWS_DIR, NO_CUSTOM_DIR);
        expect(workflows).toContain('dev');
    });

    it('should load the dev workflow definition', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, NO_CUSTOM_DIR, 'dev');

        expect(wf.definition.name).toBe('dev');
        expect(wf.definition.root.type).toBe('sequence');
        expect(wf.definition.root.id).toBe('main');
        expect(wf.definition.coordinator).toBe('coordinator');
    });

    it('should load all dev workflow roles', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, NO_CUSTOM_DIR, 'dev');
        const roleIds = Object.keys(wf.roles).sort();

        expect(roleIds).toEqual(['architect', 'coordinator', 'developer', 'tester']);
    });

    it('should parse role frontmatter correctly', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, NO_CUSTOM_DIR, 'dev');

        const coordinator = wf.roles['coordinator'];
        expect(coordinator.frontmatter.model).toBe('medium');
        expect(coordinator.frontmatter.session).toBe('none');
        expect(coordinator.frontmatter.parallel).toBe(false);

        const architect = wf.roles['architect'];
        expect(architect.frontmatter.model).toBe('strong');
        expect(architect.frontmatter.session).toBe('persistent');

        const developer = wf.roles['developer'];
        expect(developer.frontmatter.parallel).toBe(true);
        expect(developer.frontmatter.session).toBe('persistent');
    });

    it('should parse role prompts as non-empty strings', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, NO_CUSTOM_DIR, 'dev');

        for (const [id, role] of Object.entries(wf.roles)) {
            expect(role.prompt.length).toBeGreaterThan(0);
            expect(role.id).toBe(id);
        }
    });

    it('should have artifact definitions', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, NO_CUSTOM_DIR, 'dev');

        expect(wf.artifactDefinitions['prd']).toBeDefined();
        expect(wf.artifactDefinitions['user-stories']).toBeDefined();
    });

    it('should have review flags on appropriate artifacts', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, NO_CUSTOM_DIR, 'dev');

        expect(wf.artifactDefinitions['prd'].review).toBe(true);
        expect(wf.artifactDefinitions['prototype'].review).toBe(true);
        expect(wf.artifactDefinitions['user-stories'].review).toBeFalsy();
    });

    it('should have artifact format defined for prototype', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, NO_CUSTOM_DIR, 'dev');
        expect(wf.artifactDefinitions['prototype'].format).toBe('html');
    });

    it('should throw on non-existent workflow', async () => {
        await expect(loadWorkflow(WORKFLOWS_DIR, NO_CUSTOM_DIR, 'nonexistent')).rejects.toThrow();
    });

    it('should have version and author metadata', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, NO_CUSTOM_DIR, 'dev');
        expect(wf.definition.version).toBe('2.0.0');
        expect(wf.definition.author).toBe('harmonia');
    });

    it('should have prd steps defined', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, NO_CUSTOM_DIR, 'dev');
        const prd = wf.artifactDefinitions['prd'];

        expect(prd.steps).toHaveLength(4);
        expect(prd.steps![0].id).toBe('requirements');
    });
});
