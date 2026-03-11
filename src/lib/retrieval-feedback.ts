/**
 * Retrieval Feedback Loops — track whether recalled memories were useful.
 *
 * Records recall events and uses historical usefulness to boost/decay
 * memory retrieval scores. Self-improving retrieval over time.
 *
 * Inspired by Cognee's ~90% accuracy from feedback loops.
 */
// NOTE: Use-rate boost from recall events. See also temporal.ts calculateAccessBoost() for count-based access boost. These are complementary.

import {
  insertRecallEvent,
  insertRecallEventsBatch,
  getRecallStatsRow,
  getRecallSummaryRow,
  getNeverUsedCount,
  getTopPerformers,
  getWorstPerformers,
  getBoostDataForMemory,
  getBoostDataForMemories,
  getNeverUsedMemoryRows,
  deleteOldRecallEvents,
} from './db/index.js';

// ============================================================================
// Types
// ============================================================================

export interface RecallEvent {
  id: number;
  memory_id: number;
  query: string;
  was_used: boolean;
  rank_position: number | null;
  similarity_score: number | null;
  created_at: string;
}

export interface RecallStats {
  memoryId: number;
  totalRecalls: number;
  timesUsed: number;
  timesIgnored: number;
  useRate: number;
  avgRankWhenUsed: number | null;
  avgRankWhenIgnored: number | null;
  lastRecalled: string | null;
  /** Boost factor: >1 means boost, <1 means decay */
  boostFactor: number;
}

export interface RecallSummary {
  totalEvents: number;
  uniqueMemories: number;
  overallUseRate: number;
  neverUsedMemories: number;
  topPerformers: Array<{ memoryId: number; useRate: number; totalRecalls: number }>;
  worstPerformers: Array<{ memoryId: number; useRate: number; totalRecalls: number }>;
}

// ============================================================================
// Recording
// ============================================================================

/**
 * Record a recall event — whether a memory was used after being retrieved.
 *
 * @param memoryId - The memory that was recalled
 * @param query - The query that triggered the recall
 * @param wasUsed - Whether the agent/user used this memory
 * @param rankPosition - Position in the result list (1-based)
 * @param similarityScore - The similarity score from retrieval
 */
export function recordRecallEvent(
  memoryId: number,
  query: string,
  wasUsed: boolean,
  rankPosition?: number,
  similarityScore?: number
): number {
  return insertRecallEvent(memoryId, query, wasUsed, rankPosition ?? null, similarityScore ?? null);
}

/**
 * Record recall events for a batch of retrieved memories.
 * Mark top-K as "used" and remaining as "ignored".
 *
 * @param retrievedIds - All memory IDs returned by recall, in rank order
 * @param usedIds - Memory IDs that were actually used/referenced
 * @param query - The search query
 */
export function recordRecallBatch(
  retrievedIds: number[],
  usedIds: Set<number>,
  query: string,
  similarityScores?: Map<number, number>
): void {
  const events = retrievedIds.map((memId, i) => ({
    memoryId: memId,
    query,
    wasUsed: usedIds.has(memId),
    rankPosition: i + 1,
    similarityScore: similarityScores?.get(memId) ?? null,
  }));

  insertRecallEventsBatch(events);
}

// ============================================================================
// Statistics
// ============================================================================

/**
 * Get recall statistics for a specific memory.
 */
export function getRecallStats(memoryId: number): RecallStats {
  const row = getRecallStatsRow(memoryId);

  const totalRecalls = row.total_recalls;
  const timesUsed = row.times_used;
  const timesIgnored = totalRecalls - timesUsed;
  const useRate = totalRecalls > 0 ? timesUsed / totalRecalls : 0;

  return {
    memoryId,
    totalRecalls,
    timesUsed,
    timesIgnored,
    useRate,
    avgRankWhenUsed: row.avg_rank_used,
    avgRankWhenIgnored: row.avg_rank_ignored,
    lastRecalled: row.last_recalled,
    boostFactor: computeBoostFactor(totalRecalls, useRate),
  };
}

/**
 * Get recall summary across all memories.
 */
export function getRecallSummary(): RecallSummary {
  const totalRow = getRecallSummaryRow();
  const total = totalRow.total;
  const uniqueMemories = totalRow.unique_mems;
  const overallUseRate = total > 0 ? totalRow.total_used / total : 0;
  const neverUsedMemories = getNeverUsedCount();
  const topPerformers = getTopPerformers();
  const worstPerformers = getWorstPerformers();

  return {
    totalEvents: total,
    uniqueMemories,
    overallUseRate,
    neverUsedMemories,
    topPerformers,
    worstPerformers,
  };
}

/**
 * Get the boost factor for a memory based on its recall history.
 * Used to adjust retrieval scores.
 *
 * @returns boost factor: 1.0 = neutral, >1.0 = boost, <1.0 = decay
 */
export function getBoostFactor(memoryId: number): number {
  const row = getBoostDataForMemory(memoryId);
  const useRate = row.total > 0 ? row.used / row.total : 0;
  return computeBoostFactor(row.total, useRate);
}

/**
 * Get boost factors for multiple memories at once.
 */
export function getBoostFactors(memoryIds: number[]): Map<number, number> {
  if (memoryIds.length === 0) return new Map();

  const rows = getBoostDataForMemories(memoryIds);

  const result = new Map<number, number>();
  for (const row of rows) {
    const useRate = row.total > 0 ? row.used / row.total : 0;
    result.set(row.memory_id, computeBoostFactor(row.total, useRate));
  }

  // Memories with no recall history get neutral boost
  for (const id of memoryIds) {
    if (!result.has(id)) {
      result.set(id, 1.0);
    }
  }

  return result;
}

/**
 * Get memory IDs that are never used (recalled but never marked as used).
 * Useful for cleanup suggestions.
 */
export function getNeverUsedMemories(
  minRecalls: number = 3,
  limit: number = 50
): Array<{ memoryId: number; totalRecalls: number; lastRecalled: string }> {
  return getNeverUsedMemoryRows(minRecalls, limit);
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Delete old recall events to prevent unbounded growth.
 *
 * @param olderThanDays - Delete events older than this many days
 * @returns Number of events deleted
 */
export function cleanupRecallEvents(olderThanDays: number = 90): number {
  return deleteOldRecallEvents(olderThanDays);
}

// ============================================================================
// Internal
// ============================================================================

/**
 * Compute boost factor from total recalls and use rate.
 *
 * Formula:
 * - 0 recalls → 1.0 (neutral)
 * - 1-2 recalls → minor adjustment (not enough data)
 * - 3+ recalls → significant adjustment based on use rate
 *
 * Use rate mapping:
 * - 80-100% → 1.3 (strong boost)
 * - 60-80%  → 1.15 (moderate boost)
 * - 40-60%  → 1.0 (neutral)
 * - 20-40%  → 0.85 (moderate decay)
 * - 0-20%   → 0.7 (strong decay)
 */
function computeBoostFactor(totalRecalls: number, useRate: number): number {
  if (totalRecalls < 3) {
    // Not enough data — minor adjustment
    if (totalRecalls === 0) return 1.0;
    return 0.95 + useRate * 0.1; // 0.95-1.05 range
  }

  // Significant data — apply full boost/decay
  if (useRate >= 0.8) return 1.3;
  if (useRate >= 0.6) return 1.15;
  if (useRate >= 0.4) return 1.0;
  if (useRate >= 0.2) return 0.85;
  return 0.7;
}
