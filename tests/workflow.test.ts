import { describe, it, expect } from 'vitest';
import { loadWorkflow, listWorkflows } from '../src/core/workflow.js';
import { resolve, join } from 'node:path';

const WORKFLOWS_DIR = resolve(join(import.meta.dirname, '..', 'workflows'));

describe('workflow loader', () => {
    it('should list available workflows', async () => {
        const workflows = await listWorkflows(WORKFLOWS_DIR);
        expect(workflows).toContain('dev');
    });

    it('should load the dev workflow definition', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, 'dev');

        expect(wf.definition.name).toBe('dev');
        expect(wf.definition.phases).toHaveLength(5);
        expect(wf.definition.phases[0].id).toBe('clarify');
        expect(wf.definition.phases[4].id).toBe('deliver');
    });

    it('should load all dev workflow roles', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, 'dev');
        const roleIds = Object.keys(wf.roles).sort();

        expect(roleIds).toEqual(['architect', 'developer', 'pm', 'tester']);
    });

    it('should parse role frontmatter correctly', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, 'dev');

        const pm = wf.roles['pm'];
        expect(pm.frontmatter.model).toBe('medium');
        expect(pm.frontmatter.session).toBe('none');
        expect(pm.frontmatter.parallel).toBe(false);

        const architect = wf.roles['architect'];
        expect(architect.frontmatter.model).toBe('strong');
        expect(architect.frontmatter.session).toBe('persistent');

        const developer = wf.roles['developer'];
        expect(developer.frontmatter.parallel).toBe(true);
        expect(developer.frontmatter.session).toBe('persistent');
    });

    it('should parse role prompts as non-empty strings', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, 'dev');

        for (const [id, role] of Object.entries(wf.roles)) {
            expect(role.prompt.length).toBeGreaterThan(0);
            expect(role.id).toBe(id);
        }
    });

    it('should have docs with scale definitions', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, 'dev');

        expect(wf.definition.docs['prd']).toBeDefined();
        expect(wf.definition.docs['prd'].scale.small).toBe('lite');
        expect(wf.definition.docs['prd'].scale.large).toBe('full');
    });

    it('should throw on non-existent workflow', async () => {
        await expect(loadWorkflow(WORKFLOWS_DIR, 'nonexistent')).rejects.toThrow();
    });

    it('should parse role capabilities from frontmatter', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, 'dev');

        const pm = wf.roles['pm'];
        expect(pm.frontmatter.capabilities).toBeDefined();
        expect(pm.frontmatter.capabilities!.length).toBeGreaterThan(0);

        // Check a specific capability
        const writePrd = pm.frontmatter.capabilities!.find((c) => c.id === 'write-prd');
        expect(writePrd).toBeDefined();
        expect(writePrd!.doc).toBe('prd');
        expect(writePrd!.description).toBeTruthy();
    });

    it('should parse architect capabilities', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, 'dev');

        const architect = wf.roles['architect'];
        expect(architect.frontmatter.capabilities).toBeDefined();

        const ids = architect.frontmatter.capabilities!.map((c) => c.id);
        expect(ids).toContain('analyze-codebase');
        expect(ids).toContain('write-tech-design');
        expect(ids).toContain('write-task-breakdown');
    });

    it('should have doc format defined for prototype', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, 'dev');
        expect(wf.definition.docs['prototype'].format).toBe('html');
    });

    it('should have review flags on appropriate docs', async () => {
        const wf = await loadWorkflow(WORKFLOWS_DIR, 'dev');
        expect(wf.definition.docs['prd'].review).toBe(true);
        expect(wf.definition.docs['prototype'].review).toBe(true);
        expect(wf.definition.docs['user-stories'].review).toBe(false);
    });
});
