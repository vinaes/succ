/**
 * Memory Consolidation Command
 *
 * Find and merge/delete duplicate or similar memories.
 */

import {
  consolidateMemories,
  findConsolidationCandidates,
  getConsolidationStats,
} from '../lib/consolidate.js';

interface ConsolidateOptions {
  dryRun?: boolean;
  threshold?: string;
  limit?: string;
  verbose?: boolean;
  stats?: boolean;
}

export async function consolidate(options: ConsolidateOptions = {}): Promise<void> {
  const threshold = options.threshold ? parseFloat(options.threshold) : undefined;
  const limit = options.limit ? parseInt(options.limit, 10) : undefined;

  // Stats only mode
  if (options.stats) {
    console.log('Analyzing memories for consolidation...\n');

    const stats = getConsolidationStats(threshold);

    console.log('Consolidation Statistics:');
    console.log(`  Total memories: ${stats.totalMemories}`);
    console.log(`  Duplicate pairs: ${stats.duplicatePairs}`);
    console.log(`  Merge candidates: ${stats.mergeCandidates}`);
    console.log(`  Potential reduction: ${stats.potentialReduction} memories`);

    if (stats.potentialReduction > 0) {
      const pct = ((stats.potentialReduction / stats.totalMemories) * 100).toFixed(1);
      console.log(`\n  → Could reduce memory count by ~${pct}%`);
      console.log('\nRun without --stats to perform consolidation.');
      console.log('Use --dry-run to preview changes without applying them.');
    } else {
      console.log('\n  ✓ No consolidation needed - memories are clean.');
    }

    return;
  }

  // Preview mode
  if (options.dryRun) {
    console.log('DRY RUN - No changes will be made\n');
  }

  // Run consolidation
  const result = await consolidateMemories({
    dryRun: options.dryRun,
    threshold,
    maxCandidates: limit,
    verbose: options.verbose ?? true,
  });

  // Summary
  if (!options.verbose) {
    console.log('\nConsolidation Results:');
    console.log(`  Candidates found: ${result.candidatesFound}`);
    console.log(`  Merged: ${result.merged}`);
    console.log(`  Deleted duplicates: ${result.deleted}`);
    console.log(`  Kept & linked: ${result.kept}`);

    if (result.errors.length > 0) {
      console.log(`  Errors: ${result.errors.length}`);
      for (const err of result.errors.slice(0, 3)) {
        console.log(`    - ${err}`);
      }
    }
  }

  if (options.dryRun && result.candidatesFound > 0) {
    console.log('\nRun without --dry-run to apply these changes.');
  }
}
