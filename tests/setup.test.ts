import { describe, it, expect } from 'vitest';
import { generateCoordinatorPrompt } from '../src/setup/templates.js';
import { HARMONIA_MARKER_START, HARMONIA_MARKER_END } from '../src/setup/inject.js';

describe('setup', () => {
    // ─── generateCoordinatorPrompt ───

    it('should generate prompt with all required sections', () => {
        const prompt = generateCoordinatorPrompt();

        // Prompt content should NOT contain markers (managed by agent-kit)
        expect(prompt).not.toContain(HARMONIA_MARKER_START);
        expect(prompt).not.toContain(HARMONIA_MARKER_END);

        // Should be project-agnostic — no hardcoded project names/dirs
        // Should contain workflow guidance with new tool names
        expect(prompt).toContain('role_dispatch');
        expect(prompt).toContain('project_status');
        expect(prompt).toContain('artifact_write');
        expect(prompt).toContain('artifact_approve');
        // nextAction-driven — no more project_set_scale
        expect(prompt).toContain('nextAction');
    });

    it('should not contain project-specific information', () => {
        const prompt = generateCoordinatorPrompt();
        // No hardcoded project name, dir, or scale value
        expect(prompt).not.toContain('projectName');
        expect(prompt).not.toContain('projectDir');
    });

    it('should contain Getting Started section', () => {
        const prompt = generateCoordinatorPrompt();
        expect(prompt).toContain('Getting Started');
        expect(prompt).toContain('project_init');
    });
});
