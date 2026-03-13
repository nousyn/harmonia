/**
 * Document management — read/write files under ~/.harmonia/<project_name>/docs/
 */

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectDataDir } from './registry.js';

function docsDir(projectName: string): string {
    return join(getProjectDataDir(projectName), 'docs');
}

/**
 * Write a document to ~/.harmonia/<project_name>/docs/<docId>.md
 */
export async function writeDoc(projectName: string, docId: string, content: string): Promise<string> {
    const dir = docsDir(projectName);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${docId}.md`);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
}

/**
 * Read a document from ~/.harmonia/<project_name>/docs/<docId>.md
 */
export async function readDoc(projectName: string, docId: string): Promise<string> {
    const filePath = join(docsDir(projectName), `${docId}.md`);
    return readFile(filePath, 'utf-8');
}

/**
 * List all documents in ~/.harmonia/<project_name>/docs/
 */
export async function listDocs(projectName: string): Promise<string[]> {
    const dir = docsDir(projectName);
    try {
        const files = await readdir(dir);
        return files.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
    } catch {
        return [];
    }
}
