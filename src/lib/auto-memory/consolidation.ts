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
  collectPruneableAutoMemoryIds,
  collectExpiredMemoryIds,
  setForgetAfter,
  getAutoMemoryStatsRow,
  bufferToFloatArray,
} from '../db/index.js';
import { findSimilarPairs, groupByUnionFind } from '../similarity-utils.js';
import { logInfo, logWarn } from '../fault-logger.js';

// ============================================================================
// Types
// ============================================================================

export interface ConsolidationResult {
  merged: number;
  promoted: number;
  pruned: number;
  forgotten: number;
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
  const mergeThreshold = Math.max(0.5, Math.min(1.0, options?.mergeThreshold ?? 0.92));
  const promotionAccesses = Math.max(1, options?.promotionAccesses ?? 5);
  const maxUnusedDays = Math.max(1, options?.maxUnusedDays ?? 90);

  const result: ConsolidationResult = {
    merged: 0,
    promoted: 0,
    pruned: 0,
    forgotten: 0,
    scanned: 0,
  };

  try {
    // Get all auto-extracted memories
    const autoMemories = getAutoExtractedMemories();

    result.scanned = autoMemories.length;

    if (autoMemories.length === 0) {
      return result;
    }

    // Step 1: Find and merge near-duplicates (two-pass to avoid incorrect deletions).
    //
    // Pass 1: Identify all duplicate pairs and elect a winner for each group.
    //   Using a Union-Find (disjoint-set) structure ensures that if A≈B and A≈C,
    //   all three end up in the same group and only the member with the highest
    //   access_count is kept — regardless of the order pairs are discovered.
    //
    // Pass 2: Commit deletions only after all comparisons are finished.

    // Build embedding vectors, filtering out dimension mismatches.
    // Dimension mismatch can happen after embedding model change — skip those items.
    const embeds = new Map<number, number[]>();
    for (const mem of autoMemories) {
      embeds.set(mem.id, bufferToFloatArray(mem.embedding));
    }

    // Only include items whose embedding dimension matches the majority.
    // Count dimensions to find the most common one (handles model switches).
    const dimCounts = new Map<number, number>();
    for (const vec of embeds.values()) {
      if (vec.length > 0) {
        dimCounts.set(vec.length, (dimCounts.get(vec.length) ?? 0) + 1);
      }
    }
    let expectedDim: number | null = null;
    let maxCount = 0;
    for (const [dim, count] of dimCounts) {
      if (count > maxCount) {
        maxCount = count;
        expectedDim = dim;
      }
    }

    const compatibleItems = autoMemories
      .filter((m) => expectedDim === null || embeds.get(m.id)!.length === expectedDim)
      .map((m) => ({ id: m.id, embedding: embeds.get(m.id)! }));

    // Free embedding map — no longer needed after building compatibleItems
    embeds.clear();

    // Pass 1: find similar pairs then group transitively
    const similarPairs = findSimilarPairs(compatibleItems, mergeThreshold);
    const unionGroups = groupByUnionFind(similarPairs);

    // Pass 2: within each group elect the survivor (highest access_count, then lowest id),
    // then collect the rest for deletion.
    const memById = new Map(autoMemories.map((m) => [m.id, m]));
    const groups = new Map<number, typeof autoMemories>();
    for (const [root, memberIds] of unionGroups) {
      const members = memberIds.map((id) => memById.get(id)).filter(Boolean) as typeof autoMemories;
      groups.set(root, members);
    }

    const toDelete: number[] = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue; // singleton — nothing to merge
      // Elect the member with the highest access_count (ties: keep lowest id)
      const survivor = group.reduce((best, cur) => {
        if (cur.access_count > best.access_count) return cur;
        if (cur.access_count === best.access_count && cur.id < best.id) return cur;
        return best;
      });
      for (const mem of group) {
        if (mem.id !== survivor.id) {
          toDelete.push(mem.id);
        }
      }
    }

    if (toDelete.length > 0) {
      // deleteMemoriesByIds returns actual count (may differ from toDelete.length
      // if pinned memories are filtered out by the storage dispatcher)
      result.merged = await deleteMemoriesByIds(toDelete);
    }

    // Step 2: Promote high-usage memories.
    // Don't use toDelete as exclusion — pinned memories may survive deletion
    // and should still be eligible for promotion. promoteMemoryConfidence
    // returns false for missing IDs, so deleted memories are naturally skipped.
    const toPromote = autoMemories.filter(
      (m) => m.access_count >= promotionAccesses && (m.confidence === null || m.confidence < 0.7)
    );

    for (const mem of toPromote) {
      if (promoteMemoryConfidence(mem.id)) {
        // Promoted memories become permanent — clear forget_after
        if (setForgetAfter(mem.id, null)) {
          result.promoted++;
        } else {
          logWarn('consolidation', `Failed to clear forget_after for promoted memory #${mem.id}`);
        }
      }
    }

    // Step 3: Prune old unused auto-extracted memories.
    // Collect IDs via SQL, then delete through the storage dispatcher so that
    // Qdrant vector deletion is also triggered (avoids orphaned vectors).
    if (maxUnusedDays > 0) {
      const pruneIds = collectPruneableAutoMemoryIds(maxUnusedDays);
      if (pruneIds.length > 0) {
        result.pruned = await deleteMemoriesByIds(pruneIds);
      }
    }

    // Step 4: Delete memories past their forget_after date.
    const expiredIds = collectExpiredMemoryIds();
    if (expiredIds.length > 0) {
      result.forgotten = await deleteMemoriesByIds(expiredIds);
    }

    logInfo(
      'consolidation',
      `Auto-memory consolidation: ${result.merged} merged, ${result.promoted} promoted, ${result.pruned} pruned, ${result.forgotten} forgotten (${result.scanned} scanned)`
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
