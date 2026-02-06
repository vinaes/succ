/**
 * Retention Command
 *
 * Manage memory retention with decay-based cleanup.
 *
 * Usage:
 *   succ retention              - Show retention stats
 *   succ retention --dry-run    - Preview what would be deleted
 *   succ retention --apply      - Actually delete low-score memories
 *   succ retention --verbose    - Show detailed analysis
 */

import {
  getAllMemoriesForRetention,
  deleteMemoriesByIds,
  invalidateMemory,
  invalidateMemoriesBm25Index,
} from '../lib/db/index.js';
import { getRetentionConfig } from '../lib/config.js';
import {
  analyzeRetention,
  formatRetentionAnalysis,
  type RetentionConfig,
} from '../lib/retention.js';

export interface RetentionOptions {
  dryRun?: boolean;
  apply?: boolean;
  autoCleanup?: boolean;
  verbose?: boolean;
}

export async function retention(options: RetentionOptions = {}): Promise<void> {
  const configFromFile = getRetentionConfig();

  // Convert config to RetentionConfig format
  const retentionConfig: RetentionConfig = {
    decay_rate: configFromFile.decay_rate,
    access_weight: configFromFile.access_weight,
    max_access_boost: configFromFile.max_access_boost,
    keep_threshold: configFromFile.keep_threshold,
    delete_threshold: configFromFile.delete_threshold,
    default_quality_score: configFromFile.default_quality_score,
    use_temporal_decay: configFromFile.use_temporal_decay ?? true,
  };

  // Get all memories
  const memories = getAllMemoriesForRetention();

  if (memories.length === 0) {
    console.log('No memories found. Nothing to analyze.');
    return;
  }

  // Analyze retention
  const analysis = analyzeRetention(memories, retentionConfig);

  if (options.apply) {
    // Actually delete memories
    if (analysis.delete.length === 0) {
      console.log('No memories to delete. All memories are above the threshold.');
      return;
    }

    const idsToDelete = analysis.delete.map((m) => m.memoryId);
    const deleted = deleteMemoriesByIds(idsToDelete);

    console.log(`Deleted ${deleted} memories below threshold (effective_score < ${retentionConfig.delete_threshold ?? 0.15})`);
    console.log('');

    // Show what was deleted
    if (options.verbose) {
      console.log('Deleted memories:');
      for (const m of analysis.delete) {
        const preview = m.content.slice(0, 60).replace(/\n/g, ' ');
        console.log(`  [${m.memoryId}] score=${m.effectiveScore} "${preview}..."`);
      }
    } else {
      // Just show summary
      for (const m of analysis.delete.slice(0, 5)) {
        const preview = m.content.slice(0, 50).replace(/\n/g, ' ');
        console.log(`  [${m.memoryId}] score=${m.effectiveScore} "${preview}..."`);
      }
      if (analysis.delete.length > 5) {
        console.log(`  ... and ${analysis.delete.length - 5} more`);
      }
    }

    return;
  }

  // Auto-cleanup: soft-invalidate instead of hard-delete
  if (options.autoCleanup) {
    if (analysis.delete.length === 0) {
      console.log('No memories to clean up. All memories are above the threshold.');
      return;
    }

    if (options.dryRun) {
      console.log('DRY RUN — Auto-cleanup preview (soft-invalidation):\n');
      console.log(formatRetentionAnalysis(analysis, options.verbose));
      console.log(`\nWould soft-invalidate ${analysis.delete.length} memories.`);
      console.log(`Run without --dry-run to apply.`);
      return;
    }

    let invalidated = 0;
    for (const m of analysis.delete) {
      try {
        invalidateMemory(m.memoryId, 0); // 0 = system cleanup, no superseder
        invalidated++;
      } catch {
        // Skip if already invalidated
      }
    }

    console.log(`Soft-invalidated ${invalidated} memories below threshold (effective_score < ${retentionConfig.delete_threshold ?? 0.15})`);
    console.log('Originals preserved — can be restored with consolidation --undo.\n');

    if (options.verbose) {
      for (const m of analysis.delete) {
        const preview = m.content.slice(0, 60).replace(/\n/g, ' ');
        console.log(`  [${m.memoryId}] score=${m.effectiveScore} "${preview}..."`);
      }
    } else {
      for (const m of analysis.delete.slice(0, 5)) {
        const preview = m.content.slice(0, 50).replace(/\n/g, ' ');
        console.log(`  [${m.memoryId}] score=${m.effectiveScore} "${preview}..."`);
      }
      if (analysis.delete.length > 5) {
        console.log(`  ... and ${analysis.delete.length - 5} more`);
      }
    }
    return;
  }

  if (options.dryRun) {
    // Show what would be deleted
    console.log(formatRetentionAnalysis(analysis, options.verbose));

    if (analysis.delete.length > 0) {
      console.log(`\nRun 'succ retention --apply' to delete ${analysis.delete.length} memories.`);
    }
    return;
  }

  // Default: show stats only
  showStats(analysis, retentionConfig);
}

function showStats(
  analysis: ReturnType<typeof analyzeRetention>,
  config: RetentionConfig
): void {
  const { stats } = analysis;

  console.log('## Memory Retention Stats\n');

  console.log('### Configuration');
  console.log(`  Decay rate:         ${config.decay_rate ?? 0.01}`);
  console.log(`  Access weight:      ${config.access_weight ?? 0.1}`);
  console.log(`  Max access boost:   ${config.max_access_boost ?? 2.0}`);
  console.log(`  Keep threshold:     ${config.keep_threshold ?? 0.3}`);
  console.log(`  Delete threshold:   ${config.delete_threshold ?? 0.15}`);
  console.log('');

  console.log('### Summary');
  console.log(`  Total memories:     ${stats.totalMemories}`);
  console.log(`  Keep:               ${stats.keepCount} (${percent(stats.keepCount, stats.totalMemories)})`);
  console.log(`  Warning:            ${stats.warnCount} (${percent(stats.warnCount, stats.totalMemories)})`);
  console.log(`  Delete candidates:  ${stats.deleteCount} (${percent(stats.deleteCount, stats.totalMemories)})`);
  console.log('');

  console.log('### Averages');
  console.log(`  Effective score:    ${stats.avgEffectiveScore}`);
  console.log(`  Quality score:      ${stats.avgQualityScore}`);
  console.log(`  Age (days):         ${stats.avgAgeDays}`);
  console.log(`  Access count:       ${stats.avgAccessCount}`);
  console.log('');

  console.log('### Score Distribution');
  console.log(`  High (≥0.6):        ${stats.scoreDistribution.high}`);
  console.log(`  Medium (0.3-0.6):   ${stats.scoreDistribution.medium}`);
  console.log(`  Low (0.15-0.3):     ${stats.scoreDistribution.low}`);
  console.log(`  Critical (<0.15):   ${stats.scoreDistribution.critical}`);
  console.log('');

  if (stats.deleteCount > 0) {
    console.log(`Run 'succ retention --dry-run' to see delete candidates.`);
    console.log(`Run 'succ retention --apply' to clean up ${stats.deleteCount} memories.`);
  } else {
    console.log('All memories are healthy. No cleanup needed.');
  }
}

function percent(part: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}
