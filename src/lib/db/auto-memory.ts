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
 * Collect IDs of old unused auto-extracted memories eligible for pruning.
 *
 * Returns IDs only — callers are responsible for deletion so that the storage
 * dispatcher (including Qdrant vector deletion) is invoked correctly.
 */
export function collectPruneableAutoMemoryIds(maxUnusedDays: number): number[] {
  try {
    const rows = cachedPrepare(
      `SELECT id FROM memories
       WHERE source_type = 'auto_extracted'
       AND access_count = 0
       AND created_at < datetime('now', '-' || ? || ' days')`
    ).all(maxUnusedDays) as Array<{ id: number }>;

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
