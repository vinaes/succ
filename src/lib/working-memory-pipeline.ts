/**
 * Working Memory Pipeline
 *
 * Filters and scores memories for session startup context loading.
 * Implements two-phase fetch: pinned memories first, then scored recent.
 *
 * 1. Validity filtering (via isValidAt from temporal.ts)
 * 2. Pinned memories always included (correction_count >= 2 OR is_invariant)
 * 3. Remaining slots filled by effectiveScore ranking
 * 4. Fallback to recency if scoring data is missing
 * 5. Telemetry for anomalies
 */

import { isValidAt } from './temporal.js';
import { calculateEffectiveScore } from './retention.js';
import type { MemoryForRetention } from './storage/types.js';
import { logWarn, logInfo } from './fault-logger.js';

const COMPONENT = 'working-memory';

/** Pinning threshold: memories with correction_count >= this are Tier 1 pins */
export const PIN_THRESHOLD = 2;

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
  correction_count: number;
  is_invariant: boolean;
}

/**
 * Detect if memory content contains invariant language (rules, constraints).
 * Used to auto-set is_invariant on new memories.
 *
 * Matches imperative patterns: "always X", "never X", "must X", "MUST NOT",
 * "do not X", "required", "mandatory", "forbidden", "prohibited".
 */
export function detectInvariant(content: string): boolean {
  // Normalize: lowercase, collapse whitespace
  const text = content.toLowerCase().replace(/\s+/g, ' ');

  // Patterns indicating invariant rules/constraints
  const patterns = [
    /\b(?:always|never|must|shall)\s+\w/,           // "always use", "never commit", "must validate"
    /\b(?:must not|shall not|do not|don't)\s+\w/,    // "must not push", "don't use"
    /\b(?:required|mandatory|forbidden|prohibited)\b/, // standalone keywords
    /\b(?:critical|important)\s*:/,                    // "CRITICAL:" prefix patterns
    /\bnever\b.*\bwithout\b/,                          // "never X without Y"
    /\balways\b.*\bbefore\b/,                           // "always X before Y"
  ];

  return patterns.some((p) => p.test(text));
}

/**
 * Check if a memory is pinned (Tier 1 working memory).
 */
export function isPinned(memory: WorkingMemoryCandidate): boolean {
  return memory.is_invariant || memory.correction_count >= PIN_THRESHOLD;
}

/**
 * Apply the working memory pipeline with two-phase fetch:
 * Phase 1: Include all pinned memories (correction_count >= 2 OR is_invariant)
 * Phase 2: Fill remaining slots with scored recent memories
 *
 * @param memories - Raw memories from backend (pre-sorted by created_at DESC)
 * @param pinned - Pinned memories from getPinnedMemories() — may overlap with memories
 * @param limit - Max total memories to return
 * @param now - Current time (injectable for testing)
 * @returns Pinned + scored memories, up to `limit`
 */
export function applyWorkingMemoryPipeline<T extends WorkingMemoryCandidate>(
  memories: T[],
  limit: number,
  now: Date = new Date(),
  pinned?: T[]
): T[] {
  const totalBefore = memories.length + (pinned?.length ?? 0);

  // Step 1: Collect and deduplicate pinned memories
  const pinnedIds = new Set<number>();
  const pinnedValid: T[] = [];

  if (pinned && pinned.length > 0) {
    for (const m of pinned) {
      if (isValidAt(m.valid_from, m.valid_until, now) && !pinnedIds.has(m.id)) {
        pinnedIds.add(m.id);
        pinnedValid.push(m);
      }
    }
  }

  // Also check memories array for any that are pinned (in case no separate fetch)
  for (const m of memories) {
    if (isPinned(m) && isValidAt(m.valid_from, m.valid_until, now) && !pinnedIds.has(m.id)) {
      pinnedIds.add(m.id);
      pinnedValid.push(m);
    }
  }

  if (pinnedValid.length > 0) {
    logInfo(COMPONENT, `${pinnedValid.length} pinned memories included (Tier 1)`, {
      pinned: pinnedValid.length,
      invariant: pinnedValid.filter((m) => m.is_invariant).length,
      corrected: pinnedValid.filter((m) => m.correction_count >= PIN_THRESHOLD).length,
    });
  }

  // If pinned already fills limit, just return them
  if (pinnedValid.length >= limit) {
    return pinnedValid.slice(0, limit);
  }

  // Step 2: Filter remaining memories by validity, excluding already-pinned
  const remainingSlots = limit - pinnedValid.length;
  const candidates = memories.filter(
    (m) => !pinnedIds.has(m.id) && isValidAt(m.valid_from, m.valid_until, now)
  );

  const pinnedFromMemories = memories.filter((m) => pinnedIds.has(m.id)).length;
  const filteredOut = memories.length - candidates.length - pinnedFromMemories;
  const filteredPercent =
    memories.length > 0 ? (filteredOut / memories.length) * 100 : 0;

  if (filteredPercent > 10) {
    logInfo(
      COMPONENT,
      `Validity filter removed ${filteredOut}/${memories.length} candidates (${filteredPercent.toFixed(1)}%)`,
      { total: memories.length, filtered: filteredOut }
    );
  }

  if (candidates.length === 0) {
    if (pinnedValid.length > 0) return pinnedValid;
    if (totalBefore > 0) {
      logWarn(COMPONENT, 'Pipeline returned 0 memories from non-empty input', {
        totalBefore,
        afterValidity: 0,
      });
    }
    return [];
  }

  // Step 3: Score and rank remaining candidates
  const hasAnyQuality = candidates.some((m) => m.quality_score !== null);

  if (!hasAnyQuality) {
    logWarn(COMPONENT, 'All candidates lack quality_score — falling back to recency order', {
      count: candidates.length,
    });
    return [...pinnedValid, ...candidates.slice(0, remainingSlots)];
  }

  const scored = candidates.map((m) => {
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
      return { memory: m, score: 0 };
    }
  });

  scored.sort((a, b) => b.score - a.score);

  return [...pinnedValid, ...scored.slice(0, remainingSlots).map((s) => s.memory)];
}
