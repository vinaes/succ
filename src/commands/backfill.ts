/**
 * Backfill Command
 *
 * Sync existing SQL data (memories, documents) into Qdrant vector store.
 * Use after Qdrant schema migration, when collections are empty,
 * or when switching to Qdrant for the first time.
 *
 * Usage:
 *   succ backfill              - Backfill all (memories + global + documents)
 *   succ backfill --memories   - Only project memories
 *   succ backfill --global     - Only global memories
 *   succ backfill --documents  - Only documents
 *   succ backfill --dry-run    - Show counts without writing
 */

import { getStorageDispatcher } from '../lib/storage/index.js';
import { logError } from '../lib/fault-logger.js';

export interface BackfillOptions {
  memories?: boolean;
  global?: boolean;
  documents?: boolean;
  dryRun?: boolean;
}

export async function backfill(options: BackfillOptions = {}): Promise<void> {
  const { memories, global: globalMem, documents, dryRun } = options;

  // If no specific target, do all
  const doAll = !memories && !globalMem && !documents;

  const dispatcher = await getStorageDispatcher();
  const info = dispatcher.getBackendInfo();

  if (info.vector !== 'qdrant') {
    console.error('Qdrant is not configured. Set storage.vector = "qdrant" in your config.');
    logError('backfill', `Current vector backend: ${info.vectorName}`);

    console.error(`Current vector backend: ${info.vectorName}`);
    process.exit(1);
  }

  console.log(`Backend: ${info.backend} + ${info.vectorName}`);
  if (dryRun) console.log('Mode: dry-run (no writes)\n');
  else console.log('Mode: backfill\n');

  const target = doAll ? 'all'
    : memories ? 'memories'
    : globalMem ? 'global_memories'
    : 'documents';

  // If multiple specific flags, run each
  const targets: Array<'memories' | 'global_memories' | 'documents'> = [];
  if (doAll) {
    targets.push('memories', 'global_memories', 'documents');
  } else {
    if (memories) targets.push('memories');
    if (globalMem) targets.push('global_memories');
    if (documents) targets.push('documents');
  }

  let totalSynced = 0;

  for (const t of targets) {
    const stats = await dispatcher.backfillQdrant(t, {
      onProgress: (msg) => console.log(`  ${msg}`),
      dryRun,
    });

    const count = t === 'memories' ? stats.memories
      : t === 'global_memories' ? stats.globalMemories
      : stats.documents;
    totalSynced += count;
  }

  console.log(`\nTotal: ${totalSynced} records ${dryRun ? 'would be' : ''} synced to Qdrant`);
}
