/**
 * Auto Memory Consolidation (Phase 2)
 *
 * Periodic consolidation of auto-extracted memories:
 * - Merge near-duplicate auto-extracted memories
 * - Promote high-usage memories (confidence 0.3 → 0.7)
 * - Prune unused auto-extracted memories after configurable days
 * - Update existing memories rather than creating duplicates
 */

import { deleteMemoriesByIds } from '../storage/index.js';
import {
  getAutoExtractedMemories,
  promoteMemoryConfidence,
  pruneUnusedAutoMemories,
  getAutoMemoryStatsRow,
} from '../db/auto-memory.js';
import { cosineSimilarity } from '../embeddings.js';
import { bufferToFloatArray } from '../db/helpers.js';
import { logInfo, logWarn } from '../fault-logger.js';

// ============================================================================
// Types
// ============================================================================

export interface ConsolidationResult {
  merged: number;
  promoted: number;
  pruned: number;
  scanned: number;
}

// ============================================================================
// Consolidation
// ============================================================================

/**
 * Run consolidation on auto-extracted memories.
 *
 * 1. Find near-duplicate auto-extracted memories → merge/delete
 * 2. Promote high-usage memories (many accesses → increase confidence)
 * 3. Prune old unused auto-extracted memories
 */
export async function consolidateAutoMemories(options?: {
  /** Similarity threshold for merging (default: 0.92) */
  mergeThreshold?: number;
  /** Min accesses to promote confidence (default: 5) */
  promotionAccesses?: number;
  /** Max unused days before pruning (default: 90) */
  maxUnusedDays?: number;
}): Promise<ConsolidationResult> {
  const mergeThreshold = options?.mergeThreshold ?? 0.92;
  const promotionAccesses = options?.promotionAccesses ?? 5;
  const maxUnusedDays = options?.maxUnusedDays ?? 90;

  const result: ConsolidationResult = {
    merged: 0,
    promoted: 0,
    pruned: 0,
    scanned: 0,
  };

  try {
    // Get all auto-extracted memories
    const autoMemories = getAutoExtractedMemories();

    result.scanned = autoMemories.length;

    if (autoMemories.length === 0) {
      return result;
    }

    // Step 1: Find and merge near-duplicates
    const toDelete: number[] = [];
    const seen = new Set<number>();

    for (let i = 0; i < autoMemories.length; i++) {
      if (seen.has(autoMemories[i].id)) continue;

      const iEmbed = bufferToFloatArray(autoMemories[i].embedding);

      for (let j = i + 1; j < autoMemories.length; j++) {
        if (seen.has(autoMemories[j].id)) continue;

        const jEmbed = bufferToFloatArray(autoMemories[j].embedding);
        const similarity = cosineSimilarity(iEmbed, jEmbed);

        if (similarity >= mergeThreshold) {
          // Keep the one with higher access_count, delete the other
          if (autoMemories[i].access_count >= autoMemories[j].access_count) {
            toDelete.push(autoMemories[j].id);
            seen.add(autoMemories[j].id);
          } else {
            toDelete.push(autoMemories[i].id);
            seen.add(autoMemories[i].id);
            break; // i is deleted, no need to check further
          }
          result.merged++;
        }
      }
    }

    if (toDelete.length > 0) {
      await deleteMemoriesByIds(toDelete);
    }

    // Step 2: Promote high-usage memories
    const toPromote = autoMemories.filter(
      (m) =>
        !seen.has(m.id) &&
        m.access_count >= promotionAccesses &&
        (m.confidence === null || m.confidence < 0.7)
    );

    for (const mem of toPromote) {
      promoteMemoryConfidence(mem.id);
      result.promoted++;
    }

    // Step 3: Prune old unused auto-extracted memories
    if (maxUnusedDays > 0) {
      result.pruned = pruneUnusedAutoMemories(maxUnusedDays);
    }

    logInfo(
      'consolidation',
      `Auto-memory consolidation: ${result.merged} merged, ${result.promoted} promoted, ${result.pruned} pruned (${result.scanned} scanned)`
    );
  } catch (error) {
    logWarn('consolidation', 'Consolidation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return result;
}

/**
 * Get stats about auto-extracted memories for display.
 */
export function getAutoMemoryStats(): {
  total: number;
  lowConfidence: number;
  highConfidence: number;
  neverAccessed: number;
  avgAccessCount: number;
} {
  const row = getAutoMemoryStatsRow();

  return {
    total: row.total,
    lowConfidence: row.low_confidence,
    highConfidence: row.high_confidence,
    neverAccessed: row.never_accessed,
    avgAccessCount: row.avg_access,
  };
}
