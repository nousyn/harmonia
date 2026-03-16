import { describe, it, expect } from 'vitest';
import { generatePmPrompt } from '../src/setup/templates.js';
import { HARMONIA_MARKER_START, HARMONIA_MARKER_END } from '../src/setup/inject.js';

describe('setup', () => {
    // ─── generatePmPrompt ───

    it('should generate prompt with all required sections', () => {
        const prompt = generatePmPrompt();

        // Prompt content should NOT contain markers (managed by agent-kit)
        expect(prompt).not.toContain(HARMONIA_MARKER_START);
        expect(prompt).not.toContain(HARMONIA_MARKER_END);

        // Should be project-agnostic — no hardcoded project names/dirs
        // Should contain workflow guidance
        expect(prompt).toContain('role_dispatch');
        expect(prompt).toContain('project_status');
        expect(prompt).toContain('doc_write');
        expect(prompt).toContain('doc_approve');
        expect(prompt).toContain('project_set_scale');
    });

    it('should not contain project-specific information', () => {
        const prompt = generatePmPrompt();
        // No hardcoded project name, dir, or scale value
        expect(prompt).not.toContain('projectName');
        expect(prompt).not.toContain('projectDir');
    });

    it('should contain Getting Started section', () => {
        const prompt = generatePmPrompt();
        expect(prompt).toContain('Getting Started');
        expect(prompt).toContain('project_init');
    });
});
