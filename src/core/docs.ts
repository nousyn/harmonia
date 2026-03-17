/**
 * Document management — read/write files under <data_dir>/<project_name>/iter-<n>/docs/
 *
 * Supports both .md and .html files based on doc format configuration.
 * Also supports step artifact files for sequential mode (e.g. prd.requirements.json).
 */

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getIterationDir } from './registry.js';
import type { DocDefinition } from './types.js';

function docsDir(projectName: string, iteration: number): string {
    return join(getIterationDir(projectName, iteration), 'docs');
}

/**
 * Get file extension for a doc based on its definition.
 */
function getDocExtension(docDef?: DocDefinition): string {
    return docDef?.format === 'html' ? '.html' : '.md';
}

/**
 * Write a document to <data_dir>/<project_name>/iter-<n>/docs/<docId>.<ext>
 */
export async function writeDoc(
    projectName: string,
    iteration: number,
    docId: string,
    content: string,
    docDef?: DocDefinition,
): Promise<string> {
    const dir = docsDir(projectName, iteration);
    await mkdir(dir, { recursive: true });
    const ext = getDocExtension(docDef);
    const filePath = join(dir, `${docId}${ext}`);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
}

/**
 * Read a document from <data_dir>/<project_name>/iter-<n>/docs/<docId>.<ext>
 * Tries both .md and .html extensions.
 */
export async function readDoc(projectName: string, iteration: number, docId: string): Promise<string> {
    const dir = docsDir(projectName, iteration);

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
 * List all documents in <data_dir>/<project_name>/iter-<n>/docs/
 */
export async function listDocs(projectName: string, iteration: number): Promise<string[]> {
    const dir = docsDir(projectName, iteration);
    try {
        const files = await readdir(dir);
        return files.filter((f) => f.endsWith('.md') || f.endsWith('.html')).map((f) => f.replace(/\.(md|html)$/, ''));
    } catch {
        return [];
    }
}

// ─── Step Artifact I/O ───

/**
 * Write a step artifact to <data_dir>/<project_name>/iter-<n>/docs/<docId>.<stepId>.<ext>
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
): Promise<string> {
    const dir = docsDir(projectName, iteration);
    await mkdir(dir, { recursive: true });
    const ext = format === 'json' ? '.json' : '.md';
    const filePath = join(dir, `${docId}.${stepId}${ext}`);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
}

/**
 * Read a step artifact from <data_dir>/<project_name>/iter-<n>/docs/<docId>.<stepId>.<ext>
 * Tries .json first, then .md.
 */
export async function readStepArtifact(
    projectName: string,
    iteration: number,
    docId: string,
    stepId: string,
): Promise<string> {
    const dir = docsDir(projectName, iteration);

    for (const ext of ['.json', '.md']) {
        try {
            return await readFile(join(dir, `${docId}.${stepId}${ext}`), 'utf-8');
        } catch {
            // try next extension
        }
    }

    throw new Error(`Step artifact "${docId}.${stepId}" not found`);
}
