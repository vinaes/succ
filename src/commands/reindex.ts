import path from 'path';
import { getProjectRoot } from '../lib/config.js';
import {
  getStaleFiles,
  deleteDocumentsByPath,
  deleteFileHash,
  closeDb,
} from '../lib/storage/index.js';
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
  let cleaned = 0;
  let errors = 0;

  // Clean up deleted entries — bounded concurrency to avoid SQLITE_BUSY
  const CONCURRENCY = 5;
  for (let i = 0; i < deleted.length; i += CONCURRENCY) {
    const chunk = deleted.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(async (filePath) => {
        await deleteDocumentsByPath(filePath);
        await deleteFileHash(filePath);
        return filePath;
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        details.push(`Removed: ${r.value}`);
        cleaned++;
      } else {
        details.push(
          `Delete error: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`
        );
        errors++;
      }
    }
  }

  // Re-index stale files — bounded concurrency (5 at a time), allSettled so one failure doesn't abort batch
  for (let i = 0; i < stale.length; i += CONCURRENCY) {
    const chunk = stale.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(async (dbPath) => {
        const isCode = dbPath.startsWith('code:');
        const relativePath = isCode ? dbPath.slice(5) : dbPath;
        const normalized = relativePath.split(/[\\/]/).join(path.sep);
        const absolutePath = path.resolve(projectRoot, normalized);

        if (isCode) {
          const result = await indexCodeFile(absolutePath, { force: true });
          if (result.success && !result.skipped) {
            return { status: 'reindexed' as const, type: 'code' as const, relativePath };
          } else if (result.error) {
            return { status: 'error' as const, relativePath, error: result.error };
          }
        } else {
          const result = await indexDocFile(absolutePath, { force: true });
          if (result.success && !result.skipped) {
            return { status: 'reindexed' as const, type: 'doc' as const, relativePath };
          } else if (result.error) {
            return { status: 'error' as const, relativePath, error: result.error };
          }
        }
        return { status: 'skipped' as const, relativePath };
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.status === 'reindexed') {
        details.push(`Reindexed (${r.value.type}): ${r.value.relativePath}`);
        reindexed++;
      } else if (r.status === 'fulfilled' && r.value.status === 'error') {
        details.push(`Error: ${r.value.relativePath} — ${r.value.error}`);
        errors++;
      } else if (r.status === 'rejected') {
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        details.push(`Error (unknown file): ${reason}`);
        errors++;
      }
    }
  }

  return { reindexed, cleaned, errors, total, details };
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
