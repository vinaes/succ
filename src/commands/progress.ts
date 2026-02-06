/**
 * Progress Command
 *
 * View the session progress log.
 *
 * Usage:
 *   succ progress              - Show last 20 entries
 *   succ progress --limit 50  - Show last 50 entries
 *   succ progress --since 7d  - Show entries from last 7 days
 */

import { readProgressLog } from '../lib/progress-log.js';
import { closeDb } from '../lib/db/index.js';

export interface ProgressOptions {
  limit?: number;
  since?: string;
}

export async function progress(options: ProgressOptions = {}): Promise<void> {
  try {
    const limit = options.limit || 20;
    const entries = readProgressLog({ limit, since: options.since });

    if (entries.length === 0) {
      console.log('No progress log entries yet.');
      console.log('Entries are created automatically by session summaries and succ_remember.');
      return;
    }

    console.log('## Progress Log\n');

    for (const entry of entries) {
      console.log(`  ${entry}`);
    }

    console.log(`\n  Showing ${entries.length} entries (most recent first)`);
  } catch (error: any) {
    console.error(`Error reading progress log: ${error.message}`);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}
