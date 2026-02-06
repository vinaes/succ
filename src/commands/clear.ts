import { getDb, closeDb } from '../lib/db/index.js';

interface ClearOptions {
  indexOnly?: boolean;
  memoriesOnly?: boolean;
  codeOnly?: boolean;
  force?: boolean;
}

export async function clear(options: ClearOptions = {}): Promise<void> {
  const { indexOnly, memoriesOnly, codeOnly, force } = options;

  // Require explicit confirmation unless --force
  if (!force) {
    console.log('This will permanently delete data. Use --force to confirm.');
    console.log('  --index-only     Clear only document index');
    console.log('  --memories-only  Clear only memories');
    console.log('  --code-only      Clear only code index (keeps brain docs)');
    return;
  }

  const db = getDb();
  let clearedDocs = 0;
  let clearedMemories = 0;

  if (!memoriesOnly) {
    if (codeOnly) {
      // Only clear code: prefixed documents
      const result = db.prepare("DELETE FROM documents WHERE file_path LIKE 'code:%'").run();
      const hashResult = db.prepare("DELETE FROM file_hashes WHERE file_path LIKE 'code:%'").run();
      clearedDocs = result.changes;
      console.log(`Cleared ${clearedDocs} code chunks`);
    } else {
      // Clear all documents
      const result = db.prepare('DELETE FROM documents').run();
      db.prepare('DELETE FROM file_hashes').run();
      clearedDocs = result.changes;
      console.log(`Cleared ${clearedDocs} document chunks`);
    }
  }

  if (!indexOnly && !codeOnly) {
    const result = db.prepare('DELETE FROM memories').run();
    clearedMemories = result.changes;
    console.log(`Cleared ${clearedMemories} memories`);
  }

  // Reset model metadata if clearing all
  if (!memoriesOnly && !codeOnly) {
    db.prepare("DELETE FROM metadata WHERE key = 'embedding_model'").run();
  }

  closeDb();

  console.log('Done.');
}
