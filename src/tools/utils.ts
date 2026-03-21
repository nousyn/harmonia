/**
 * Shared utility for tool handlers — resolves the active context (iteration or patch)
 * for a project. All tools that operate on iteration/patch-level data should use this
 * instead of directly reading entry.currentIteration.
 */

import { getProject, resolveContextDir } from '../core/registry.js';
import type { ProjectEntry } from '../core/registry.js';
import type { CapabilityOverride, OverrideConfig } from '../core/types.js';

export interface ResolvedContext {
    entry: ProjectEntry;
    /** The iteration or patch number */
    number: number;
    /** "iteration" or "patch" */
    type: 'iteration' | 'patch';
    /** Absolute path to the context directory (iter-N/ or patch-N/) */
    dir: string;
    /** The raw activeContext string, e.g. "iter-1" or "patch-2" */
    activeContext: string;
}

type ToolResult = {
    content: { type: 'text'; text: string }[];
    isError?: boolean;
};

/**
 * Resolve the active context for a project. Returns either a ResolvedContext
 * or a ToolResult error (to be returned directly from the tool handler).
 */
export async function resolveActive(projectName: string): Promise<ResolvedContext | ToolResult> {
    const entry = await getProject(projectName);

    if (!entry) {
        return {
            content: [
                {
                    type: 'text' as const,
                    text: `项目 "${projectName}" 未注册。请先调用 project_init 注册项目。`,
                },
            ],
            isError: true,
        };
    }

    if (!entry.activeContext) {
        return {
            content: [
                {
                    type: 'text' as const,
                    text: `项目 "${projectName}" 尚未开始迭代或补丁。请先调用 iteration_start 或 patch_start。`,
                },
            ],
            isError: true,
        };
    }

    const resolved = resolveContextDir(projectName, entry.activeContext);
    if (!resolved) {
        return {
            content: [
                {
                    type: 'text' as const,
                    text: `项目 "${projectName}" 的 activeContext "${entry.activeContext}" 无法解析。数据可能已损坏。`,
                },
            ],
            isError: true,
        };
    }

    return {
        entry,
        number: resolved.number,
        type: resolved.type,
        dir: resolved.dir,
        activeContext: entry.activeContext,
    };
}

/**
 * Type guard: check if the result is an error (ToolResult) or a resolved context.
 */
export function isError(result: ResolvedContext | ToolResult): result is ToolResult {
    return 'content' in result && !('entry' in result);
}

/**
 * Build override instructions to inject into a role prompt.
 * Shared by role-dispatch and get-role-prompt.
 */
export function buildOverrideSection(roleId: string, overrides: OverrideConfig): string {
    const roleOverrides = overrides.roles?.[roleId]?.capabilities;
    if (!roleOverrides || Object.keys(roleOverrides).length === 0) {
        return '';
    }

    const lines: string[] = [
        '',
        '## Enhanced Capabilities',
        '',
        'The following capabilities have been configured to use external tools.',
        'Use the specified tool instead of built-in behavior for these actions.',
        '',
    ];

    for (const [capId, override] of Object.entries(roleOverrides)) {
        const o = override as CapabilityOverride;
        const toolRef =
            o.type === 'mcp' && o.server
                ? `\`${o.server}\` MCP server's \`${o.tool}\` tool`
                : `\`${o.tool}\` skill tool`;

        let instruction = `- **${capId}**: Use ${toolRef}`;

        if (o.params && Object.keys(o.params).length > 0) {
            const paramStr = Object.entries(o.params)
                .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                .join(', ');
            instruction += ` with fixed parameters: ${paramStr}`;
        }

        if (o.notes) {
            instruction += `. Note: ${o.notes}`;
        }

        lines.push(instruction);
    }

    return lines.join('\n');
}
