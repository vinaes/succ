/**
 * Memory Consolidation Command
 *
 * Find and merge/delete duplicate or similar memories.
 * Uses soft-invalidation instead of hard delete — originals are preserved
 * and can be restored with --undo.
 */

import {
  consolidateMemories,
  getConsolidationStats,
  undoConsolidation,
} from '../lib/consolidate.js';
import { getConsolidationHistory } from '../lib/storage/index.js';
import { getConfig } from '../lib/config.js';
import { logError } from '../lib/fault-logger.js';

interface ConsolidateOptions {
  dryRun?: boolean;
  threshold?: string;
  limit?: string;
  verbose?: boolean;
  stats?: boolean;
  llm?: boolean;
  noLlm?: boolean;
  undo?: string;
  history?: boolean;
}

export async function consolidate(options: ConsolidateOptions = {}): Promise<void> {
  // Undo mode
  if (options.undo) {
    const mergedId = parseInt(options.undo, 10);
    if (isNaN(mergedId)) {
      logError('consolidate', '--undo requires a valid memory ID');
      console.error('Error: --undo requires a valid memory ID');
      return;
    }

    console.log(`Undoing consolidation for memory #${mergedId}...\n`);
    const result = await undoConsolidation(mergedId);

    if (result.restored.length > 0) {
      console.log(
        `  Restored ${result.restored.length} original memories: ${result.restored.join(', ')}`
      );
    }
    if (result.deletedMerge) {
      console.log(`  Deleted synthetic merged memory #${mergedId}`);
    }
    if (result.errors.length > 0) {
      for (const err of result.errors) {
        console.log(`  Warning: ${err}`);
      }
    }
    if (result.restored.length === 0 && !result.deletedMerge) {
      console.log('  Nothing to undo — no supersedes links found for this memory.');
    }
    return;
  }

  // History mode
  if (options.history) {
    const history = await getConsolidationHistory(20);

    if (history.length === 0) {
      console.log('No consolidation history found.');
      return;
    }

    console.log('Recent consolidation operations:\n');
    for (const entry of history) {
      const preview = entry.mergedContent.substring(0, 80).replace(/\n/g, ' ');
      console.log(`  #${entry.mergedMemoryId} (${entry.mergedAt})`);
      console.log(`    Supersedes: ${entry.originalIds.join(', ')}`);
      console.log(`    Content: ${preview}...`);
      console.log();
    }
    console.log(`Use --undo <id> to restore originals and remove a merge.`);
    return;
  }

  const threshold = options.threshold ? parseFloat(options.threshold) : undefined;
  const limit = options.limit ? parseInt(options.limit, 10) : undefined;

  // Determine LLM usage: explicit flags override config default
  const config = getConfig();
  const configDefault = config.consolidation_llm_default !== false; // default true
  const useLLM = options.noLlm ? false : (options.llm ?? configDefault);

  // Stats only mode
  if (options.stats) {
    console.log('Analyzing memories for consolidation...\n');

    const stats = await getConsolidationStats(threshold);

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

  // LLM merge mode
  if (useLLM) {
    console.log('LLM merge enabled - will use AI to intelligently merge similar memories\n');
  }

  // Run consolidation
  const result = await consolidateMemories({
    dryRun: options.dryRun,
    threshold,
    maxCandidates: limit,
    verbose: options.verbose ?? true,
    useLLM,
  });

  // Summary
  if (!options.verbose) {
    console.log('\nConsolidation Results:');
    console.log(`  Candidates found: ${result.candidatesFound}`);
    console.log(`  Merged: ${result.merged}`);
    console.log(`  Invalidated duplicates: ${result.deleted}`);
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
