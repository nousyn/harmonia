/**
 * Hook content generation — shared configuration and rule definitions.
 *
 * Hook scripts run on the agent side (shell scripts for Claude Code,
 * TS plugins for OpenCode, handlers for OpenClaw). They need to know:
 *   - HARMONIA_DATA_DIR: where to read dispatches.json, state.json, etc.
 *   - PROJECT_NAME: which project's data to read
 *   - PROJECT_DIR: project source directory (for boundary checks)
 *
 * These values are baked into hook content at install time.
 */

/**
 * Parameters needed to generate hook content.
 * Passed at install time and embedded into the generated scripts.
 */
export interface HookParams {
    /** Harmonia data directory (absolute path) */
    dataDir: string;
    /** Project name */
    projectName: string;
    /** Project source directory (absolute path) */
    projectDir: string;
}

// ─── Boundary Rules ───

/**
 * Tool names that PM should not call directly (code modification tools).
 * These are the standard agent tool names across different platforms.
 */
export const BLOCKED_TOOLS = [
    // File writing tools
    'Write',
    'Edit',
    'MultiEdit',
    'write',
    'edit',
    // Bash/shell tools
    'Bash',
    'bash',
    'Terminal',
    'terminal',
] as const;

/**
 * Shell commands that indicate development work (PM should not run these).
 */
export const BLOCKED_COMMANDS = [
    'npm run',
    'npm test',
    'npm start',
    'npm run build',
    'npx ',
    'yarn ',
    'pnpm ',
    'bun ',
    'node ',
    'deno ',
    'python ',
    'cargo ',
    'go run',
    'go test',
    'make ',
    'gcc ',
    'g++ ',
    'javac ',
    'mvn ',
    'gradle ',
] as const;

/**
 * File extensions that indicate source code (PM should not modify these).
 */
export const CODE_EXTENSIONS = [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '.rs',
    '.go',
    '.java',
    '.c',
    '.cpp',
    '.h',
    '.hpp',
    '.cs',
    '.rb',
    '.php',
    '.swift',
    '.kt',
    '.vue',
    '.svelte',
] as const;

/**
 * Harmonia MCP tool names — these are always allowed since PM uses them
 * through Harmonia's own tool system.
 */
export const HARMONIA_TOOLS = [
    'project_init',
    'project_setup',
    'project_status',
    'phase_update',
    'role_dispatch',
    'dispatch_report',
    'doc_write',
    'doc_read',
    'doc_list',
    'doc_approve',
    'reject_doc',
    'guard_set',
    'guard_get',
    'review_set_rule',
    'review_list',
] as const;

// ─── Timeout thresholds (minutes) ───

/** Dispatch running timeout — warn after this many minutes */
export const DISPATCH_TIMEOUT_MINUTES = 30;

/** Phase idle timeout — warn after this many minutes with no tool calls */
export const PHASE_IDLE_TIMEOUT_MINUTES = 15;

/** Review pending timeout — warn after this many minutes */
export const REVIEW_PENDING_TIMEOUT_MINUTES = 10;
