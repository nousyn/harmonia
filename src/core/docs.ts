/**
 * Document management — read/write files under <context_dir>/docs/
 *
 * context_dir is typically iter-<n>/ or patch-<n>/ under the project data dir.
 * All public functions accept an optional contextDir parameter. When omitted,
 * falls back to getIterationDir(projectName, iteration) for backward compat.
 *
 * Supports both .md and .html files based on doc format configuration.
 * Also supports step artifact files for sequential mode (e.g. prd.requirements.json).
 */

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getIterationDir } from './registry.js';
import type { DocDefinition } from './types.js';

function docsDir(projectName: string, iteration: number, contextDir?: string): string {
    const base = contextDir ?? getIterationDir(projectName, iteration);
    return join(base, 'docs');
}

/**
 * Get file extension for a doc based on its definition.
 */
function getDocExtension(docDef?: DocDefinition): string {
    return docDef?.format === 'html' ? '.html' : '.md';
}

/**
 * Write a document to <context_dir>/docs/<docId>.<ext>
 */
export async function writeDoc(
    projectName: string,
    iteration: number,
    docId: string,
    content: string,
    docDef?: DocDefinition,
    contextDir?: string,
): Promise<string> {
    const dir = docsDir(projectName, iteration, contextDir);
    await mkdir(dir, { recursive: true });
    const ext = getDocExtension(docDef);
    const filePath = join(dir, `${docId}${ext}`);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
}

/**
 * Read a document from <context_dir>/docs/<docId>.<ext>
 * Tries both .md and .html extensions.
 */
export async function readDoc(
    projectName: string,
    iteration: number,
    docId: string,
    contextDir?: string,
): Promise<string> {
    const dir = docsDir(projectName, iteration, contextDir);

    // Try .md first, then .html
    for (const ext of ['.md', '.html']) {
        try {
            return await readFile(join(dir, `${docId}${ext}`), 'utf-8');
        } catch {
            // try next extension
        }
    }

    throw new Error(`Document "${docId}" not found`);
}

/**
 * List all documents in <context_dir>/docs/
 */
export async function listDocs(projectName: string, iteration: number, contextDir?: string): Promise<string[]> {
    const dir = docsDir(projectName, iteration, contextDir);
    try {
        const files = await readdir(dir);
        return files.filter((f) => f.endsWith('.md') || f.endsWith('.html')).map((f) => f.replace(/\.(md|html)$/, ''));
    } catch {
        return [];
    }
}

// ─── Step Artifact I/O ───

/**
 * Write a step artifact to <context_dir>/docs/<docId>.<stepId>.<ext>
 *
 * @param format - "json" or "md" (determines file extension)
 * @returns The file path written
 */
export async function writeStepArtifact(
    projectName: string,
    iteration: number,
    docId: string,
    stepId: string,
    content: string,
    format: 'json' | 'md',
    contextDir?: string,
): Promise<string> {
    const dir = docsDir(projectName, iteration, contextDir);
    await mkdir(dir, { recursive: true });
    const ext = format === 'json' ? '.json' : '.md';
    const filePath = join(dir, `${docId}.${stepId}${ext}`);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
}

/**
 * Read a step artifact from <context_dir>/docs/<docId>.<stepId>.<ext>
 * Tries .json first, then .md.
 */
export async function readStepArtifact(
    projectName: string,
    iteration: number,
    docId: string,
    stepId: string,
    contextDir?: string,
): Promise<string> {
    const dir = docsDir(projectName, iteration, contextDir);

    for (const ext of ['.json', '.md']) {
        try {
            return await readFile(join(dir, `${docId}.${stepId}${ext}`), 'utf-8');
        } catch {
            // try next extension
        }
    }

    throw new Error(`Step artifact "${docId}.${stepId}" not found`);
}
