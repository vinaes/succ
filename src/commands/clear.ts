import {
  closeDb,
  clearDocuments,
  clearCodeDocuments,
  deleteMemoriesOlderThan,
} from '../lib/storage/index.js';

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

  if (!memoriesOnly) {
    if (codeOnly) {
      // Only clear code: prefixed documents
      const clearedDocs = await clearCodeDocuments();
      console.log(`Cleared ${clearedDocs} code chunks`);
    } else {
      // Clear all documents (also clears embedding_model metadata)
      const clearedDocs = await clearDocuments();
      console.log(`Cleared ${clearedDocs} document chunks`);
    }
  }

  if (!indexOnly && !codeOnly) {
    const clearedMemories = await deleteMemoriesOlderThan(new Date('2100-01-01'));
    console.log(`Cleared ${clearedMemories} memories`);
  }

  closeDb();

  console.log('Done.');
}
