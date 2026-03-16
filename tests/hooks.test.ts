/**
 * Tests for P2 Agent Hook — content generation and routing logic.
 *
 * Tests Harmonia's own hook logic (content generation, parameter embedding,
 * agent routing). Does NOT test agent-kit's defineHooks/installHooks.
 */

import { describe, it, expect } from 'vitest';
import type { HookParams } from '../src/hooks/content.js';
import {
    BLOCKED_TOOLS,
    BLOCKED_COMMANDS,
    CODE_EXTENSIONS,
    HARMONIA_TOOLS,
    DISPATCH_TIMEOUT_MINUTES,
    PHASE_IDLE_TIMEOUT_MINUTES,
    REVIEW_PENDING_TIMEOUT_MINUTES,
} from '../src/hooks/content.js';
import { createClaudeCodeHooks } from '../src/hooks/claude-code.js';
import { createOpenCodeHooks } from '../src/hooks/opencode.js';
import { createOpenClawHooks } from '../src/hooks/openclaw.js';
import { createHooksForAgent } from '../src/hooks/install.js';

const TEST_PARAMS: HookParams = {
    dataDir: '/test/data',
    projectName: 'test-project',
    projectDir: '/test/project',
};

// ─── Shared Constants ───

describe('hook shared constants', () => {
    it('BLOCKED_TOOLS should include Write and Edit variants', () => {
        expect(BLOCKED_TOOLS).toContain('Write');
        expect(BLOCKED_TOOLS).toContain('Edit');
        expect(BLOCKED_TOOLS).toContain('write');
        expect(BLOCKED_TOOLS).toContain('edit');
    });

    it('BLOCKED_TOOLS should include Bash variants', () => {
        expect(BLOCKED_TOOLS).toContain('Bash');
        expect(BLOCKED_TOOLS).toContain('bash');
    });

    it('BLOCKED_COMMANDS should include common dev commands', () => {
        expect(BLOCKED_COMMANDS).toContain('npm run');
        expect(BLOCKED_COMMANDS).toContain('npm test');
        expect(BLOCKED_COMMANDS).toContain('node ');
    });

    it('CODE_EXTENSIONS should include common source file extensions', () => {
        expect(CODE_EXTENSIONS).toContain('.ts');
        expect(CODE_EXTENSIONS).toContain('.tsx');
        expect(CODE_EXTENSIONS).toContain('.js');
        expect(CODE_EXTENSIONS).toContain('.py');
        expect(CODE_EXTENSIONS).toContain('.rs');
    });

    it('HARMONIA_TOOLS should include all MCP tools', () => {
        expect(HARMONIA_TOOLS).toContain('project_init');
        expect(HARMONIA_TOOLS).toContain('role_dispatch');
        expect(HARMONIA_TOOLS).toContain('doc_write');
        expect(HARMONIA_TOOLS).toContain('doc_read');
        expect(HARMONIA_TOOLS).toContain('doc_approve');
        expect(HARMONIA_TOOLS).not.toContain('project_setup');
    });

    it('timeout thresholds should be positive numbers', () => {
        expect(DISPATCH_TIMEOUT_MINUTES).toBeGreaterThan(0);
        expect(PHASE_IDLE_TIMEOUT_MINUTES).toBeGreaterThan(0);
        expect(REVIEW_PENDING_TIMEOUT_MINUTES).toBeGreaterThan(0);
    });
});

// ─── Claude Code Hook Content ───

describe('createClaudeCodeHooks', () => {
    const hookSet = createClaudeCodeHooks(TEST_PARAMS);

    it('should return a HookSet for claude-code', () => {
        expect(hookSet.agent).toBe('claude-code');
        expect(hookSet.__brand).toBe('HookSet');
    });

    it('should have two hook definitions', () => {
        expect(hookSet.definitions).toHaveLength(2);
    });

    it('should define PreToolUse hook', () => {
        const preToolUse = hookSet.definitions.find((d) => d.events.includes('PreToolUse' as any));
        expect(preToolUse).toBeDefined();
        expect(preToolUse!.content).toContain('#!/bin/bash');
    });

    it('should define UserPromptSubmit hook', () => {
        const userPrompt = hookSet.definitions.find((d) => d.events.includes('UserPromptSubmit' as any));
        expect(userPrompt).toBeDefined();
        expect(userPrompt!.content).toContain('#!/bin/bash');
    });

    describe('PreToolUse script content', () => {
        const preToolUse = hookSet.definitions.find((d) => d.events.includes('PreToolUse' as any))!;
        const content = preToolUse.content;

        it('should embed project directory', () => {
            expect(content).toContain(`PROJECT_DIR="${TEST_PARAMS.projectDir}"`);
        });

        it('should embed data directory', () => {
            expect(content).toContain(`DATA_DIR="${TEST_PARAMS.dataDir}"`);
        });

        it('should embed project name', () => {
            expect(content).toContain(`PROJECT_NAME="${TEST_PARAMS.projectName}"`);
        });

        it('should check Write/Edit tools', () => {
            expect(content).toContain('Write|Edit|MultiEdit|write|edit');
        });

        it('should check Bash/Terminal tools', () => {
            expect(content).toContain('Bash|bash|Terminal|terminal');
        });

        it('should include code extension pattern', () => {
            for (const ext of CODE_EXTENSIONS) {
                expect(content).toContain(`*${ext}`);
            }
        });

        it('should include blocked command checks', () => {
            for (const cmd of BLOCKED_COMMANDS) {
                expect(content).toContain(`"${cmd}"`);
            }
        });

        it('should use JSON decision block format', () => {
            // In the shell script, quotes are escaped: \"decision\":\"block\"
            expect(content).toContain('\\"decision\\":\\"block\\"');
        });
    });

    describe('UserPromptSubmit script content', () => {
        const userPrompt = hookSet.definitions.find((d) => d.events.includes('UserPromptSubmit' as any))!;
        const content = userPrompt.content;

        it('should embed data directory and project name', () => {
            expect(content).toContain(`DATA_DIR="${TEST_PARAMS.dataDir}"`);
            expect(content).toContain(`PROJECT_NAME="${TEST_PARAMS.projectName}"`);
        });

        it('should read dispatches.json', () => {
            expect(content).toContain('dispatches.json');
        });

        it('should read reviews.json', () => {
            expect(content).toContain('reviews.json');
        });

        it('should read state.json', () => {
            expect(content).toContain('state.json');
        });

        it('should use harmonia-reminder tags', () => {
            expect(content).toContain('<harmonia-reminder>');
            expect(content).toContain('</harmonia-reminder>');
        });

        it('should embed timeout thresholds', () => {
            expect(content).toContain(String(DISPATCH_TIMEOUT_MINUTES));
            expect(content).toContain(String(REVIEW_PENDING_TIMEOUT_MINUTES));
            expect(content).toContain(String(PHASE_IDLE_TIMEOUT_MINUTES));
        });
    });
});

// ─── OpenCode Hook Content ───

describe('createOpenCodeHooks', () => {
    const hookSet = createOpenCodeHooks(TEST_PARAMS);

    it('should return a HookSet for opencode', () => {
        expect(hookSet.agent).toBe('opencode');
        expect(hookSet.__brand).toBe('HookSet');
    });

    it('should have one hook definition (single plugin)', () => {
        expect(hookSet.definitions).toHaveLength(1);
    });

    it('should target both events', () => {
        const def = hookSet.definitions[0];
        expect(def.events).toContain('tool.execute.before');
        expect(def.events).toContain('experimental.chat.messages.transform');
    });

    describe('plugin content', () => {
        const content = hookSet.definitions[0].content;

        it('should be a valid TypeScript plugin with Plugin type', () => {
            expect(content).toContain("import type { Plugin } from 'opencode'");
            expect(content).toContain('satisfies Plugin');
        });

        it('should embed project parameters', () => {
            expect(content).toContain(JSON.stringify(TEST_PARAMS.projectDir));
            expect(content).toContain(JSON.stringify(TEST_PARAMS.dataDir));
            expect(content).toContain(JSON.stringify(TEST_PARAMS.projectName));
        });

        it('should embed code extensions array', () => {
            expect(content).toContain(JSON.stringify(CODE_EXTENSIONS));
        });

        it('should embed blocked commands array', () => {
            expect(content).toContain(JSON.stringify(BLOCKED_COMMANDS));
        });

        it('should implement tool.execute.before hook', () => {
            expect(content).toContain("'tool.execute.before'");
        });

        it('should implement messages.transform hook', () => {
            expect(content).toContain("'experimental.chat.messages.transform'");
        });

        it('should check Write/Edit tools', () => {
            expect(content).toContain("'Write'");
            expect(content).toContain("'Edit'");
            expect(content).toContain("'MultiEdit'");
        });

        it('should check Bash tools', () => {
            expect(content).toContain("'Bash'");
            expect(content).toContain("'bash'");
        });

        it('should read Harmonia data files for reminders', () => {
            expect(content).toContain('dispatches.json');
            expect(content).toContain('reviews.json');
            expect(content).toContain('state.json');
        });

        it('should use harmonia-reminder tags', () => {
            expect(content).toContain('<harmonia-reminder>');
            expect(content).toContain('</harmonia-reminder>');
        });

        it('should use HARMONIA interception marker for soft blocking', () => {
            expect(content).toContain('HARMONIA 拦截');
        });

        it('should embed timeout thresholds', () => {
            expect(content).toContain(`DISPATCH_TIMEOUT_MINUTES = ${DISPATCH_TIMEOUT_MINUTES}`);
            expect(content).toContain(`PHASE_IDLE_TIMEOUT_MINUTES = ${PHASE_IDLE_TIMEOUT_MINUTES}`);
            expect(content).toContain(`REVIEW_PENDING_TIMEOUT_MINUTES = ${REVIEW_PENDING_TIMEOUT_MINUTES}`);
        });

        it('should export a named harmonia plugin', () => {
            expect(content).toContain("name: 'harmonia'");
        });
    });
});

// ─── OpenClaw Hook Content ───

describe('createOpenClawHooks', () => {
    const hookSet = createOpenClawHooks(TEST_PARAMS);

    it('should return a HookSet for openclaw', () => {
        expect(hookSet.agent).toBe('openclaw');
        expect(hookSet.__brand).toBe('HookSet');
    });

    it('should have one hook definition (openclaw single-definition limit)', () => {
        expect(hookSet.definitions).toHaveLength(1);
    });

    it('should target both events in one definition', () => {
        const def = hookSet.definitions[0];
        expect(def.events).toContain('message_received');
        expect(def.events).toContain('before_tool_call');
    });

    it('should include description', () => {
        const def = hookSet.definitions[0];
        expect(def.description).toBeTruthy();
    });

    describe('handler content', () => {
        const content = hookSet.definitions[0].content;

        it('should export a default async handler function', () => {
            expect(content).toContain('export default async function handler');
        });

        it('should embed project parameters', () => {
            expect(content).toContain(JSON.stringify(TEST_PARAMS.projectDir));
            expect(content).toContain(JSON.stringify(TEST_PARAMS.dataDir));
            expect(content).toContain(JSON.stringify(TEST_PARAMS.projectName));
        });

        it('should handle before_tool_call event', () => {
            expect(content).toContain("event.type === 'before_tool_call'");
        });

        it('should handle message_received event', () => {
            expect(content).toContain("event.type === 'message_received'");
        });

        it('should use block: true for tool blocking', () => {
            expect(content).toContain('block: true');
        });

        it('should use inject for session_start reminders', () => {
            expect(content).toContain('inject:');
        });

        it('should check Write/Edit tools', () => {
            expect(content).toContain("'Write'");
            expect(content).toContain("'Edit'");
        });

        it('should check Bash tools', () => {
            expect(content).toContain("'Bash'");
            expect(content).toContain("'bash'");
        });

        it('should read Harmonia data files for reminders', () => {
            expect(content).toContain('dispatches.json');
            expect(content).toContain('reviews.json');
            expect(content).toContain('state.json');
        });

        it('should use harmonia-reminder tags', () => {
            expect(content).toContain('<harmonia-reminder>');
            expect(content).toContain('</harmonia-reminder>');
        });

        it('should embed timeout thresholds', () => {
            expect(content).toContain(`DISPATCH_TIMEOUT_MINUTES = ${DISPATCH_TIMEOUT_MINUTES}`);
            expect(content).toContain(`PHASE_IDLE_TIMEOUT_MINUTES = ${PHASE_IDLE_TIMEOUT_MINUTES}`);
            expect(content).toContain(`REVIEW_PENDING_TIMEOUT_MINUTES = ${REVIEW_PENDING_TIMEOUT_MINUTES}`);
        });
    });
});

// ─── Agent Routing ───

describe('createHooksForAgent', () => {
    it('should route claude-code to createClaudeCodeHooks', () => {
        const hookSet = createHooksForAgent('claude-code', TEST_PARAMS);
        expect(hookSet.agent).toBe('claude-code');
    });

    it('should route codex to createClaudeCodeHooks (same as claude-code)', () => {
        const hookSet = createHooksForAgent('codex', TEST_PARAMS);
        // codex shares claude-code hooks, so agent is claude-code
        expect(hookSet.agent).toBe('claude-code');
    });

    it('should route opencode to createOpenCodeHooks', () => {
        const hookSet = createHooksForAgent('opencode', TEST_PARAMS);
        expect(hookSet.agent).toBe('opencode');
    });

    it('should route openclaw to createOpenClawHooks', () => {
        const hookSet = createHooksForAgent('openclaw', TEST_PARAMS);
        expect(hookSet.agent).toBe('openclaw');
    });

    it('should throw for unknown agent type', () => {
        expect(() => createHooksForAgent('unknown' as any, TEST_PARAMS)).toThrow();
    });

    it('should pass params through to generated content', () => {
        const customParams: HookParams = {
            dataDir: '/custom/data/dir',
            projectName: 'custom-project',
            projectDir: '/custom/project/dir',
        };

        // Check each agent type embeds the custom params
        for (const agent of ['claude-code', 'opencode', 'openclaw'] as const) {
            const hookSet = createHooksForAgent(agent, customParams);
            const allContent = hookSet.definitions.map((d) => d.content).join('\n');
            expect(allContent).toContain(customParams.projectDir);
            expect(allContent).toContain(customParams.dataDir);
            expect(allContent).toContain(customParams.projectName);
        }
    });
});
