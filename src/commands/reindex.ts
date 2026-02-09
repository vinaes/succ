import path from 'path';
import { getProjectRoot } from '../lib/config.js';
import { getStaleFiles, deleteDocumentsByPath, deleteFileHash, closeDb } from '../lib/storage/index.js';
import { indexDocFile } from './index.js';
import { indexCodeFile } from './index-code.js';

export interface ReindexResult {
  reindexed: number;
  cleaned: number;
  errors: number;
  total: number;
  details: string[];
}

/**
 * Core reindex logic — detects stale/deleted files, re-indexes and cleans up.
 * Returns structured result (no console output).
 */
export async function reindexFiles(projectRoot: string): Promise<ReindexResult> {
  const { stale, deleted, total } = await getStaleFiles(projectRoot);
  const details: string[] = [];
  let reindexed = 0;
  let errors = 0;

  // Clean up deleted entries
  for (const filePath of deleted) {
    await deleteDocumentsByPath(filePath);
    await deleteFileHash(filePath);
    details.push(`Removed: ${filePath}`);
  }

  // Re-index stale files
  for (const dbPath of stale) {
    const isCode = dbPath.startsWith('code:');
    const relativePath = isCode ? dbPath.slice(5) : dbPath;
    const normalized = relativePath.split(/[\\/]/).join(path.sep);
    const absolutePath = path.resolve(projectRoot, normalized);

    try {
      if (isCode) {
        const result = await indexCodeFile(absolutePath, { force: true });
        if (result.success && !result.skipped) {
          details.push(`Reindexed (code): ${relativePath}`);
          reindexed++;
        } else if (result.error) {
          details.push(`Error: ${relativePath} — ${result.error}`);
          errors++;
        }
      } else {
        const result = await indexDocFile(absolutePath, { force: true });
        if (result.success && !result.skipped) {
          details.push(`Reindexed (doc): ${relativePath}`);
          reindexed++;
        } else if (result.error) {
          details.push(`Error: ${relativePath} — ${result.error}`);
          errors++;
        }
      }
    } catch (err: any) {
      details.push(`Error: ${relativePath} — ${err.message}`);
      errors++;
    }
  }

  return { reindexed, cleaned: deleted.length, errors, total, details };
}

/**
 * CLI entry point — prints output to console.
 */
export async function reindex(): Promise<void> {
  const projectRoot = getProjectRoot();

  console.log('Checking index freshness...\n');

  const result = await reindexFiles(projectRoot);

  if (result.reindexed === 0 && result.cleaned === 0 && result.errors === 0) {
    console.log(`All ${result.total} indexed files are up to date.`);
    closeDb();
    return;
  }

  for (const line of result.details) {
    console.log(`  ${line}`);
  }

  console.log();
  if (result.reindexed > 0) {
    console.log(`Reindexed: ${result.reindexed}`);
  }
  if (result.errors > 0) {
    console.log(`Errors: ${result.errors}`);
  }
  console.log(`Cleaned: ${result.cleaned} deleted entries`);
  closeDb();
}
