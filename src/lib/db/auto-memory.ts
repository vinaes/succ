/**
 * Auto-memory DB operations — raw SQL for auto-extracted memory consolidation.
 */

import { cachedPrepare } from './connection.js';
import { logWarn } from '../fault-logger.js';

export interface AutoMemoryRow {
  id: number;
  content: string;
  embedding: Buffer;
  access_count: number;
  confidence: number | null;
  created_at: string;
}

/**
 * Get all auto-extracted memories ordered by creation date.
 */
export function getAutoExtractedMemories(): AutoMemoryRow[] {
  return cachedPrepare(
    `SELECT id, content, embedding, access_count, confidence, created_at
     FROM memories
     WHERE source_type = 'auto_extracted'
     ORDER BY created_at DESC`
  ).all() as AutoMemoryRow[];
}

/**
 * Promote a memory's confidence to 0.7.
 * Only updates the confidence value — source_type is intentionally left unchanged
 * so that non-auto memories are not relabelled.
 */
export function promoteMemoryConfidence(memoryId: number): boolean {
  try {
    const result = cachedPrepare(
      `UPDATE memories SET confidence = 0.7
       WHERE id = ? AND (confidence IS NULL OR confidence < 0.7)`
    ).run(memoryId);
    return result.changes > 0;
  } catch (error) {
    logWarn('auto-memory-db', `Failed to promote memory #${memoryId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Degrade a memory's confidence by a given amount (min 0.05).
 * Used when a memory is recalled but not used.
 */
export function degradeMemoryConfidence(memoryId: number, amount: number = 0.05): boolean {
  const delta = Math.max(0, amount);
  try {
    const result = cachedPrepare(
      `UPDATE memories SET confidence = MAX(0.05, COALESCE(confidence, 0.5) - ?)
       WHERE id = ? AND source_type = 'auto_extracted' AND COALESCE(confidence, 0.5) > 0.05`
    ).run(delta, memoryId);
    return result.changes > 0;
  } catch (error) {
    logWarn('auto-memory-db', `Failed to degrade confidence for memory #${memoryId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Boost a memory's confidence by a given amount (cap at 0.95).
 * Used when a memory is recalled and actively used.
 */
export function boostMemoryConfidence(memoryId: number, amount: number = 0.02): boolean {
  const delta = Math.max(0, amount);
  try {
    const result = cachedPrepare(
      `UPDATE memories SET confidence = MIN(0.95, COALESCE(confidence, 0.5) + ?)
       WHERE id = ? AND source_type = 'auto_extracted'`
    ).run(delta, memoryId);
    return result.changes > 0;
  } catch (error) {
    logWarn('auto-memory-db', `Failed to boost confidence for memory #${memoryId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Set forget_after to DB-native now()+days, avoiding Node.js/DB clock skew.
 */
export function setForgetAfterDays(memoryId: number, days: number): boolean {
  try {
    const result = cachedPrepare(
      `UPDATE memories SET forget_after = datetime('now', '+' || ? || ' days') WHERE id = ?`
    ).run(days, memoryId);
    return result.changes > 0;
  } catch (error) {
    logWarn('auto-memory-db', `Failed to set forget_after (days) for memory #${memoryId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Set forget_after date on a memory.
 */
export function setForgetAfter(memoryId: number, forgetAfter: string | null): boolean {
  try {
    const result = cachedPrepare(`UPDATE memories SET forget_after = ? WHERE id = ?`).run(
      forgetAfter,
      memoryId
    );
    return result.changes > 0;
  } catch (error) {
    logWarn('auto-memory-db', `Failed to set forget_after for memory #${memoryId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Collect IDs of memories past their forget_after date.
 */
export function collectExpiredMemoryIds(): number[] {
  try {
    const rows = cachedPrepare(
      `SELECT id FROM memories
       WHERE forget_after IS NOT NULL
       AND datetime(forget_after) < datetime('now')
       AND invalidated_by IS NULL`
    ).all() as Array<{ id: number }>;
    return rows.map((r) => r.id);
  } catch (error) {
    logWarn('auto-memory-db', `Failed to collect expired memories`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Collect IDs of old unused auto-extracted memories eligible for pruning.
 *
 * Unified on forget_after — the single canonical retention field.
 * The maxUnusedDays parameter is kept for interface compat but the actual
 * expiration is driven by the forget_after timestamp set at insertion time.
 *
 * Returns IDs only — callers are responsible for deletion so that the storage
 * dispatcher (including Qdrant vector deletion) is invoked correctly.
 */
export function collectPruneableAutoMemoryIds(_maxUnusedDays: number): number[] {
  try {
    const rows = cachedPrepare(
      `SELECT id FROM memories
       WHERE source_type = 'auto_extracted'
       AND access_count = 0
       AND forget_after IS NOT NULL
       AND datetime(forget_after) < datetime('now')
       AND invalidated_by IS NULL`
    ).all() as Array<{ id: number }>;

    return rows.map((r) => r.id);
  } catch (error) {
    logWarn('auto-memory-db', `Failed to collect pruneable auto memories`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export interface AutoMemoryStatsRow {
  total: number;
  low_confidence: number;
  high_confidence: number;
  never_accessed: number;
  avg_access: number;
}

/**
 * Get stats about auto-extracted memories.
 */
export function getAutoMemoryStatsRow(): AutoMemoryStatsRow {
  const row = cachedPrepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN confidence IS NULL OR confidence < 0.5 THEN 1 ELSE 0 END) as low_confidence,
       SUM(CASE WHEN confidence >= 0.7 THEN 1 ELSE 0 END) as high_confidence,
       SUM(CASE WHEN access_count = 0 THEN 1 ELSE 0 END) as never_accessed,
       AVG(access_count) as avg_access
     FROM memories
     WHERE source_type = 'auto_extracted'`
  ).get() as AutoMemoryStatsRow | undefined;

  return {
    total: row?.total ?? 0,
    low_confidence: row?.low_confidence ?? 0,
    high_confidence: row?.high_confidence ?? 0,
    never_accessed: row?.never_accessed ?? 0,
    avg_access: row?.avg_access ?? 0,
  };
}
