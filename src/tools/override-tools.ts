/**
 * MCP Tools: set_override / get_overrides
 * Manage capability overrides and review settings.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
    setCapabilityOverride,
    setReviewOverride,
    getMergedOverrides,
    readGlobalOverrides,
    readProjectOverrides,
} from '../core/overrides.js';
import type { CapabilityOverride } from '../core/types.js';

export function registerOverrideTools(server: McpServer): void {
    server.tool(
        'set_capability_override',
        'Configure a role capability to use an external skill or MCP tool instead of the built-in behavior. Settings are saved to the override config file.',
        {
            scope: z.enum(['global', 'project']).describe('Override scope: global (all projects) or project-specific'),
            project_name: z.string().optional().describe("Project name (required when scope is 'project')"),
            role_id: z.string().describe('Role ID (e.g. pm, architect, developer, tester)'),
            capability_id: z.string().describe('Capability ID (e.g. write-prd, write-tech-design)'),
            type: z.enum(['skill', 'mcp']).describe('Tool source type'),
            tool: z.string().describe('Tool name'),
            server_name: z.string().optional().describe("MCP server name (required when type is 'mcp')"),
            params: z
                .record(z.string(), z.unknown())
                .optional()
                .describe('Static parameters to always pass when calling the tool'),
            notes: z.string().optional().describe('Additional notes for prompt generation (rarely needed)'),
        },
        async ({ scope, project_name, role_id, capability_id, type, tool, server_name, params, notes }) => {
            if (scope === 'project' && !project_name) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: "Error: project_name is required when scope is 'project'.",
                        },
                    ],
                    isError: true,
                };
            }

            const override: CapabilityOverride = { type, tool };
            if (server_name) override.server = server_name;
            if (params) override.params = params;
            if (notes) override.notes = notes;

            await setCapabilityOverride(scope, project_name ?? null, role_id, capability_id, override);

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Override set: ${role_id}.${capability_id} → ${type === 'mcp' ? `${server_name}/${tool}` : tool} (${scope})`,
                    },
                ],
            };
        },
    );

    server.tool(
        'set_review_override',
        'Enable or disable review requirement for a specific document type.',
        {
            scope: z.enum(['global', 'project']).describe('Override scope: global or project-specific'),
            project_name: z.string().optional().describe("Project name (required when scope is 'project')"),
            doc_id: z.string().describe('Document ID (e.g. prd, prototype)'),
            enabled: z.boolean().describe('true = require review, false = skip review'),
        },
        async ({ scope, project_name, doc_id, enabled }) => {
            if (scope === 'project' && !project_name) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: "Error: project_name is required when scope is 'project'.",
                        },
                    ],
                    isError: true,
                };
            }

            await setReviewOverride(scope, project_name ?? null, doc_id, enabled);

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Review override set: ${doc_id} → ${enabled ? 'required' : 'skipped'} (${scope})`,
                    },
                ],
            };
        },
    );

    server.tool(
        'get_overrides',
        'Get the current override configuration. Shows the merged result (project + global) or a specific scope.',
        {
            project_name: z
                .string()
                .optional()
                .describe('Project name — if provided, shows merged config for this project'),
            scope: z
                .enum(['merged', 'global', 'project'])
                .default('merged')
                .describe('Which config to show: merged (default), global only, or project only'),
        },
        async ({ project_name, scope }) => {
            let config;
            let label: string;

            if (scope === 'global') {
                config = await readGlobalOverrides();
                label = 'Global overrides';
            } else if (scope === 'project') {
                if (!project_name) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: "Error: project_name is required when scope is 'project'.",
                            },
                        ],
                        isError: true,
                    };
                }
                config = await readProjectOverrides(project_name);
                label = `Project overrides for "${project_name}"`;
            } else {
                if (!project_name) {
                    config = await readGlobalOverrides();
                    label = 'Global overrides (no project specified)';
                } else {
                    config = await getMergedOverrides(project_name);
                    label = `Merged overrides for "${project_name}"`;
                }
            }

            const isEmpty = !config.review && (!config.roles || Object.keys(config.roles).length === 0);

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: isEmpty ? `${label}: (none configured)` : `${label}:\n${JSON.stringify(config, null, 2)}`,
                    },
                ],
            };
        },
    );
}
