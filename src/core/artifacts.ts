/**
 * Artifact management — read/write files to resolved output directories.
 *
 * All path resolution goes through `ArtifactIOContext`:
 * - Default: `<contextDir>/artifacts/`
 * - Custom: resolved via `ArtifactDefinition.output` template
 *
 * Supports .md, .html, and .json files based on artifact format configuration.
 * Also supports step artifact files for sequential mode (e.g. prd.requirements.json).
 */

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactDefinition } from './types.js';

/** Context needed for artifact I/O path resolution */
export interface ArtifactIOContext {
    /** Absolute path to the context directory (iter-N/ or patch-N/) */
    contextDir: string;
    /** Absolute path to the project source directory */
    projectDir: string;
    /** Context label string, e.g. "iter-1" or "patch-2" */
    contextLabel: string;
}

function artifactsDir(contextDir: string): string {
    return join(contextDir, 'artifacts');
}

/**
 * Resolve the output directory for an artifact based on its `output` template.
 *
 * Placeholder resolution:
 * - `{global}` → `<contextDir>/artifacts/`
 * - `{project}` → `<projectDir>/`
 * - `{context}` → contextLabel (e.g. "iter-1")
 *
 * When `output` is undefined, returns `<contextDir>/artifacts/` (default behavior).
 */
export function resolveArtifactDir(output: string | undefined, ioCtx: ArtifactIOContext): string {
    if (!output) {
        return artifactsDir(ioCtx.contextDir);
    }

    const resolved = output
        .replace(/\{global\}/g, artifactsDir(ioCtx.contextDir))
        .replace(/\{project\}/g, ioCtx.projectDir)
        .replace(/\{context\}/g, ioCtx.contextLabel);

    return resolved;
}

/**
 * Get file extension for an artifact based on its definition.
 */
function getArtifactExtension(artifactDef?: ArtifactDefinition): string {
    return artifactDef?.format === 'html' ? '.html' : '.md';
}

/**
 * Write an artifact to the resolved output directory.
 */
export async function writeArtifact(
    artifactId: string,
    content: string,
    ioCtx: ArtifactIOContext,
    artifactDef?: ArtifactDefinition,
): Promise<string> {
    const dir = resolveArtifactDir(artifactDef?.output, ioCtx);
    await mkdir(dir, { recursive: true });
    const ext = getArtifactExtension(artifactDef);
    const filePath = join(dir, `${artifactId}${ext}`);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
}

/**
 * Read an artifact from the resolved output directory.
 *
 * When `artifactDef` is provided with a known format, tries that extension first
 * before falling back to probing all extensions.
 */
export async function readArtifact(
    artifactId: string,
    ioCtx: ArtifactIOContext,
    artifactDef?: ArtifactDefinition,
): Promise<string> {
    const dir = resolveArtifactDir(artifactDef?.output, ioCtx);

    // If we know the format, try it first for a fast path
    if (artifactDef?.format) {
        const knownExt = getArtifactExtension(artifactDef);
        try {
            return await readFile(join(dir, `${artifactId}${knownExt}`), 'utf-8');
        } catch {
            // fall through to probe all extensions
        }
    }

    for (const ext of ['.md', '.html', '.json']) {
        try {
            return await readFile(join(dir, `${artifactId}${ext}`), 'utf-8');
        } catch {
            // try next extension
        }
    }

    throw new Error(`Artifact "${artifactId}" not found`);
}

/**
 * List artifacts that exist on disk.
 *
 * Groups definitions by their resolved output directory and does one `readdir`
 * per unique directory, then matches artifact IDs in memory.
 *
 * When `artifactDefinitions` is empty, falls back to scanning
 * `<ioCtx.contextDir>/artifacts/`.
 */
export async function listArtifacts(
    ioCtx: ArtifactIOContext,
    artifactDefinitions: Record<string, ArtifactDefinition>,
): Promise<string[]> {
    // Definition-based grouping
    if (Object.keys(artifactDefinitions).length > 0) {
        // Group artifact IDs by resolved directory
        const dirToIds = new Map<string, string[]>();
        for (const [id, def] of Object.entries(artifactDefinitions)) {
            const dir = resolveArtifactDir(def.output, ioCtx);
            const existing = dirToIds.get(dir);
            if (existing) {
                existing.push(id);
            } else {
                dirToIds.set(dir, [id]);
            }
        }

        const found: string[] = [];
        for (const [dir, ids] of dirToIds) {
            let files: string[];
            try {
                files = await readdir(dir);
            } catch {
                continue; // directory doesn't exist yet
            }

            // Strip extensions from filenames for matching
            const fileBaseNames = new Set(
                files
                    .filter((f) => f.endsWith('.md') || f.endsWith('.html') || f.endsWith('.json'))
                    .map((f) => f.replace(/\.(md|html|json)$/, '')),
            );

            for (const id of ids) {
                if (fileBaseNames.has(id)) {
                    found.push(id);
                }
            }
        }

        return found;
    }

    // Fallback: scan default artifacts directory
    const dir = artifactsDir(ioCtx.contextDir);
    try {
        const files = await readdir(dir);
        return files
            .filter((f) => f.endsWith('.md') || f.endsWith('.html') || f.endsWith('.json'))
            .map((f) => f.replace(/\.(md|html|json)$/, ''));
    } catch {
        return [];
    }
}

// ─── Step Artifact I/O ───

/**
 * Write a step artifact to the resolved output directory.
 *
 * Step artifacts follow the main artifact's `output` configuration.
 *
 * @param format - "json" or "md" (determines file extension)
 * @returns The file path written
 */
export async function writeStepArtifact(
    artifactId: string,
    stepId: string,
    content: string,
    format: 'json' | 'md',
    ioCtx: ArtifactIOContext,
    artifactDef?: ArtifactDefinition,
): Promise<string> {
    const dir = resolveArtifactDir(artifactDef?.output, ioCtx);
    await mkdir(dir, { recursive: true });
    const ext = format === 'json' ? '.json' : '.md';
    const filePath = join(dir, `${artifactId}.${stepId}${ext}`);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
}

/**
 * Read a step artifact from the resolved output directory.
 * Tries .json first, then .md.
 */
export async function readStepArtifact(
    artifactId: string,
    stepId: string,
    ioCtx: ArtifactIOContext,
    artifactDef?: ArtifactDefinition,
): Promise<string> {
    const dir = resolveArtifactDir(artifactDef?.output, ioCtx);

    for (const ext of ['.json', '.md']) {
        try {
            return await readFile(join(dir, `${artifactId}.${stepId}${ext}`), 'utf-8');
        } catch {
            // try next extension
        }
    }

    throw new Error(`Step artifact "${artifactId}.${stepId}" not found`);
}
