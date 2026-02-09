import path from 'path';
import { getProjectRoot } from '../lib/config.js';
import { getStaleFiles, deleteDocumentsByPath, deleteFileHash, closeDb } from '../lib/storage/index.js';
import { indexDocFile } from './index.js';
import { indexCodeFile } from './index-code.js';

export async function reindex(): Promise<void> {
  const projectRoot = getProjectRoot();

  console.log('Checking index freshness...\n');

  const { stale, deleted, total } = await getStaleFiles(projectRoot);

  if (stale.length === 0 && deleted.length === 0) {
    console.log(`All ${total} indexed files are up to date.`);
    closeDb();
    return;
  }

  console.log(`Found: ${stale.length} stale, ${deleted.length} deleted (of ${total} indexed)\n`);

  // Clean up deleted entries
  if (deleted.length > 0) {
    for (const filePath of deleted) {
      await deleteDocumentsByPath(filePath);
      await deleteFileHash(filePath);
      console.log(`  Removed: ${filePath}`);
    }
    console.log();
  }

  // Re-index stale files
  if (stale.length > 0) {
    let reindexed = 0;
    let errors = 0;

    for (const dbPath of stale) {
      const isCode = dbPath.startsWith('code:');
      const relativePath = isCode ? dbPath.slice(5) : dbPath;

      // Normalize to OS path and resolve absolute
      const normalized = relativePath.split(/[\\/]/).join(path.sep);
      const absolutePath = path.resolve(projectRoot, normalized);

      try {
        if (isCode) {
          const result = await indexCodeFile(absolutePath, { force: true });
          if (result.success && !result.skipped) {
            console.log(`  Reindexed (code): ${relativePath}`);
            reindexed++;
          } else if (result.error) {
            console.log(`  Error: ${relativePath} — ${result.error}`);
            errors++;
          }
        } else {
          const result = await indexDocFile(absolutePath, { force: true });
          if (result.success && !result.skipped) {
            console.log(`  Reindexed (doc): ${relativePath}`);
            reindexed++;
          } else if (result.error) {
            console.log(`  Error: ${relativePath} — ${result.error}`);
            errors++;
          }
        }
      } catch (err: any) {
        console.log(`  Error: ${relativePath} — ${err.message}`);
        errors++;
      }
    }

    console.log();
    console.log(`Reindexed: ${reindexed}, Errors: ${errors}`);
  }

  console.log(`Cleaned: ${deleted.length} deleted entries`);
  closeDb();
}
