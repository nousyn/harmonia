/**
 * Document management — read/write files under <data_dir>/<project_name>/docs/
 *
 * Supports both .md and .html files based on doc format configuration.
 */

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectDataDir } from './registry.js';
import type { DocDefinition } from './types.js';

function docsDir(projectName: string): string {
    return join(getProjectDataDir(projectName), 'docs');
}

/**
 * Get file extension for a doc based on its definition.
 */
function getDocExtension(docDef?: DocDefinition): string {
    return docDef?.format === 'html' ? '.html' : '.md';
}

/**
 * Write a document to <data_dir>/<project_name>/docs/<docId>.<ext>
 */
export async function writeDoc(
    projectName: string,
    docId: string,
    content: string,
    docDef?: DocDefinition,
): Promise<string> {
    const dir = docsDir(projectName);
    await mkdir(dir, { recursive: true });
    const ext = getDocExtension(docDef);
    const filePath = join(dir, `${docId}${ext}`);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
}

/**
 * Read a document from <data_dir>/<project_name>/docs/<docId>.<ext>
 * Tries both .md and .html extensions.
 */
export async function readDoc(projectName: string, docId: string): Promise<string> {
    const dir = docsDir(projectName);

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
 * List all documents in <data_dir>/<project_name>/docs/
 */
export async function listDocs(projectName: string): Promise<string[]> {
    const dir = docsDir(projectName);
    try {
        const files = await readdir(dir);
        return files.filter((f) => f.endsWith('.md') || f.endsWith('.html')).map((f) => f.replace(/\.(md|html)$/, ''));
    } catch {
        return [];
    }
}
