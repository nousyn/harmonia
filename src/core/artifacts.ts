/**
 * Artifact management — read/write files under <context_dir>/artifacts/
 *
 * context_dir is typically iter-<n>/ or patch-<n>/ under the project data dir.
 * All public functions accept an optional contextDir parameter. When omitted,
 * falls back to getIterationDir(projectName, iteration) for backward compat.
 *
 * Supports both .md and .html files based on artifact format configuration.
 * Also supports step artifact files for sequential mode (e.g. prd.requirements.json).
 */

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getIterationDir } from './registry.js';
import type { ArtifactDefinition } from './types.js';

function artifactsDir(projectName: string, iteration: number, contextDir?: string): string {
    const base = contextDir ?? getIterationDir(projectName, iteration);
    return join(base, 'artifacts');
}

/**
 * Get file extension for an artifact based on its definition.
 */
function getArtifactExtension(artifactDef?: ArtifactDefinition): string {
    return artifactDef?.format === 'html' ? '.html' : '.md';
}

/**
 * Write an artifact to <context_dir>/artifacts/<artifactId>.<ext>
 */
export async function writeArtifact(
    projectName: string,
    iteration: number,
    artifactId: string,
    content: string,
    artifactDef?: ArtifactDefinition,
    contextDir?: string,
): Promise<string> {
    const dir = artifactsDir(projectName, iteration, contextDir);
    await mkdir(dir, { recursive: true });
    const ext = getArtifactExtension(artifactDef);
    const filePath = join(dir, `${artifactId}${ext}`);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
}

/**
 * Read an artifact from <context_dir>/artifacts/<artifactId>.<ext>
 * Tries .md, .html, and .json extensions.
 */
export async function readArtifact(
    projectName: string,
    iteration: number,
    artifactId: string,
    contextDir?: string,
): Promise<string> {
    const dir = artifactsDir(projectName, iteration, contextDir);

    // Try .md first, then .html, then .json
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
 * List all artifacts in <context_dir>/artifacts/
 */
export async function listArtifacts(projectName: string, iteration: number, contextDir?: string): Promise<string[]> {
    const dir = artifactsDir(projectName, iteration, contextDir);
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
 * Write a step artifact to <context_dir>/artifacts/<artifactId>.<stepId>.<ext>
 *
 * @param format - "json" or "md" (determines file extension)
 * @returns The file path written
 */
export async function writeStepArtifact(
    projectName: string,
    iteration: number,
    artifactId: string,
    stepId: string,
    content: string,
    format: 'json' | 'md',
    contextDir?: string,
): Promise<string> {
    const dir = artifactsDir(projectName, iteration, contextDir);
    await mkdir(dir, { recursive: true });
    const ext = format === 'json' ? '.json' : '.md';
    const filePath = join(dir, `${artifactId}.${stepId}${ext}`);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
}

/**
 * Read a step artifact from <context_dir>/artifacts/<artifactId>.<stepId>.<ext>
 * Tries .json first, then .md.
 */
export async function readStepArtifact(
    projectName: string,
    iteration: number,
    artifactId: string,
    stepId: string,
    contextDir?: string,
): Promise<string> {
    const dir = artifactsDir(projectName, iteration, contextDir);

    for (const ext of ['.json', '.md']) {
        try {
            return await readFile(join(dir, `${artifactId}.${stepId}${ext}`), 'utf-8');
        } catch {
            // try next extension
        }
    }

    throw new Error(`Step artifact "${artifactId}.${stepId}" not found`);
}
