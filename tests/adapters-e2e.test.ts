/**
 * E2E smoke tests for agent adapters.
 *
 * These tests spawn real agent CLI processes and verify end-to-end behavior.
 * They are skipped by default because they require the actual CLI tools to be
 * installed and available on the system.
 *
 * To run these tests locally:
 *   HARMONIA_E2E=1 npx vitest run tests/adapters-e2e.test.ts
 */

import { describe, it } from 'vitest';

const describeE2E = process.env.HARMONIA_E2E ? describe : describe.skip;

describeE2E('Adapter E2E smoke tests', () => {
    describeE2E('OpenCode adapter', () => {
        it.skip('should dispatch a simple task via `opencode run`', () => {
            // Spawn real opencode CLI and verify JSON output is parsed correctly.
            // Requires: `opencode` binary on PATH.
        });
    });

    describeE2E('OpenClaw adapter', () => {
        it.skip('should dispatch a task via `openclaw agent --message`', () => {
            // Spawn real openclaw CLI and verify task result.
            // Requires: `openclaw` binary on PATH.
        });

        it.skip('should push a message via `openclaw agent --deliver`', () => {
            // Test pushMessage() with real CLI call.
            // Requires: `openclaw` binary on PATH + a running agent session.
        });
    });

    describeE2E('Claude Code adapter', () => {
        it.skip('should dispatch a task via `claude -p`', () => {
            // Spawn real claude CLI and verify JSON output parsing.
            // Requires: `claude` binary on PATH.
        });
    });

    describeE2E('Codex adapter', () => {
        it.skip('should dispatch a task via `codex exec`', () => {
            // Spawn real codex CLI and verify JSON output parsing.
            // Requires: `codex` binary on PATH.
        });
    });

    describeE2E('Full round-trip', () => {
        it.skip('should dispatch task through Orchestrator → Adapter → CLI → result', () => {
            // Integration test: create Orchestrator with real adapter registry,
            // dispatch a task to a real CLI agent, and verify the full lifecycle
            // including checkStatus() and result parsing.
        });
    });
});
