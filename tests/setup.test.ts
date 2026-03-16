import { describe, it, expect } from 'vitest';
import { generatePmPrompt } from '../src/setup/templates.js';
import { HARMONIA_MARKER_START, HARMONIA_MARKER_END } from '../src/setup/inject.js';

describe('setup', () => {
    // ─── generatePmPrompt ───

    it('should generate prompt with all required sections', () => {
        const prompt = generatePmPrompt({
            projectName: 'my-app',
            projectDir: '/home/user/my-app',
            workflow: 'dev',
            scale: 'medium',
        });

        // Prompt content should NOT contain markers (managed by agent-kit)
        expect(prompt).not.toContain(HARMONIA_MARKER_START);
        expect(prompt).not.toContain(HARMONIA_MARKER_END);
        expect(prompt).toContain('my-app');
        expect(prompt).toContain('/home/user/my-app');
        expect(prompt).toContain('dev');
        expect(prompt).toContain('medium');
        expect(prompt).toContain('dispatch_role');
        expect(prompt).toContain('get_project_status');
        expect(prompt).toContain('write_doc');
        expect(prompt).toContain('approve_doc');
    });
});
