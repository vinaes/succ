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

    // Step 1: Find and merge near-duplicates (two-pass to avoid incorrect deletions).
    //
    // Pass 1: Identify all duplicate pairs and elect a winner for each group.
    //   We track which id "survives" for every memory involved in at least one
    //   duplicate pair.  Using a Union-Find (disjoint-set) structure ensures that
    //   if A≈B and A≈C, all three end up in the same group and only the member
    //   with the highest access_count is kept — regardless of the order pairs are
    //   discovered.
    //
    // Pass 2: Commit deletions only after all comparisons are finished.

    // Union-Find helpers (path-compressed)
    const parent = new Map<number, number>();
    const rankMap = new Map<number, number>();

    function find(x: number): number {
      if (!parent.has(x)) {
        parent.set(x, x);
        rankMap.set(x, 0);
      }
      if (parent.get(x) !== x) {
        parent.set(x, find(parent.get(x)!));
      }
      return parent.get(x)!;
    }

    function union(a: number, b: number): void {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return;
      // Union by rank: attach lower-rank tree under higher-rank root
      const rankA = rankMap.get(ra) ?? 0;
      const rankB = rankMap.get(rb) ?? 0;
      if (rankA < rankB) {
        parent.set(ra, rb);
      } else if (rankA > rankB) {
        parent.set(rb, ra);
      } else {
        parent.set(rb, ra);
        rankMap.set(ra, rankA + 1);
      }
    }

    // Pass 1: build duplicate groups
    const embedCache = new Map<number, number[]>();

    for (let i = 0; i < autoMemories.length; i++) {
      const memI = autoMemories[i];
      if (!embedCache.has(memI.id)) {
        embedCache.set(memI.id, bufferToFloatArray(memI.embedding));
      }
      const iEmbed = embedCache.get(memI.id)!;

      for (let j = i + 1; j < autoMemories.length; j++) {
        const memJ = autoMemories[j];
        if (!embedCache.has(memJ.id)) {
          embedCache.set(memJ.id, bufferToFloatArray(memJ.embedding));
        }
        const jEmbed = embedCache.get(memJ.id)!;

        const similarity = cosineSimilarity(iEmbed, jEmbed);
        if (similarity >= mergeThreshold) {
          union(memI.id, memJ.id);
        }
      }
    }

    // Free embedding vectors — no longer needed after similarity comparisons
    embedCache.clear();

    // Pass 2: within each group elect the survivor (highest access_count, then lowest id),
    // then collect the rest for deletion.
    const groups = new Map<number, typeof autoMemories>();
    for (const mem of autoMemories) {
      const root = find(mem.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(mem);
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

    // Step 2: Promote high-usage memories (skip any that were just deleted)
    const deletedSet = new Set(toDelete);
    const toPromote = autoMemories.filter(
      (m) =>
        !deletedSet.has(m.id) &&
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
