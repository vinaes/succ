/**
 * Working Memory Pipeline
 *
 * Filters and scores memories for session startup context loading.
 * Takes raw memories (ordered by created_at DESC from backend) and applies:
 * 1. Validity filtering (via isValidAt from temporal.ts)
 * 2. Effective score ranking (via calculateEffectiveScore from retention.ts)
 * 3. Fallback to recency if scoring data is missing
 * 4. Telemetry for anomalies
 */

import { isValidAt } from './temporal.js';
import { calculateEffectiveScore } from './retention.js';
import type { MemoryForRetention } from './storage/types.js';
import { logWarn, logInfo } from './fault-logger.js';

const COMPONENT = 'working-memory';

/** Minimum fields needed from a raw memory row */
export interface WorkingMemoryCandidate {
  id: number;
  content: string;
  quality_score: number | null;
  access_count: number;
  created_at: string;
  last_accessed: string | null;
  valid_from: string | null;
  valid_until: string | null;
}

/**
 * Apply the working memory pipeline: validity filter → score → rank → trim.
 *
 * @param memories - Raw memories from backend (pre-sorted by created_at DESC)
 * @param limit - Max memories to return
 * @param now - Current time (injectable for testing)
 * @returns Scored and filtered memories, up to `limit`
 */
export function applyWorkingMemoryPipeline<T extends WorkingMemoryCandidate>(
  memories: T[],
  limit: number,
  now: Date = new Date()
): T[] {
  const totalBefore = memories.length;

  // Step 1: Filter by temporal validity
  const valid = memories.filter((m) =>
    isValidAt(m.valid_from, m.valid_until, now)
  );

  const filteredOut = totalBefore - valid.length;
  const filteredPercent = totalBefore > 0 ? (filteredOut / totalBefore) * 100 : 0;

  if (filteredPercent > 10) {
    logInfo(COMPONENT, `Validity filter removed ${filteredOut}/${totalBefore} candidates (${filteredPercent.toFixed(1)}%)`, {
      total: totalBefore,
      filtered: filteredOut,
    });
  }

  // Early exit: nothing survived validity filter
  if (valid.length === 0) {
    if (totalBefore > 0) {
      logWarn(COMPONENT, 'Pipeline returned 0 memories from non-empty input', {
        totalBefore,
        afterValidity: 0,
      });
    }
    return [];
  }

  // Step 2: Score and rank
  const hasAnyQuality = valid.some((m) => m.quality_score !== null);

  if (!hasAnyQuality) {
    // Fallback: no quality data at all — keep recency order from backend
    logWarn(COMPONENT, 'All candidates lack quality_score — falling back to recency order', {
      count: valid.length,
    });
    return valid.slice(0, limit);
  }

  // Score each memory using retention formula
  const scored = valid.map((m) => {
    const retentionInput: MemoryForRetention = {
      id: m.id,
      content: m.content,
      quality_score: m.quality_score,
      access_count: m.access_count,
      created_at: m.created_at,
      last_accessed: m.last_accessed,
    };

    try {
      const result = calculateEffectiveScore(retentionInput);
      return { memory: m, score: result.effectiveScore };
    } catch {
      // Individual scoring failure — use 0 so it sorts to bottom
      return { memory: m, score: 0 };
    }
  });

  // Sort by score descending (stable sort preserves recency for equal scores)
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((s) => s.memory);
}
