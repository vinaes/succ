/**
 * Recall events DB operations — raw SQL for the recall_events table.
 *
 * Used by retrieval-feedback.ts for tracking memory recall usefulness.
 */

import { getDb, cachedPrepare } from './connection.js';
import { logInfo, logWarn } from '../fault-logger.js';

// ============================================================================
// Insert
// ============================================================================

export function insertRecallEvent(
  memoryId: number,
  query: string,
  wasUsed: boolean,
  rankPosition: number | null,
  similarityScore: number | null
): number {
  try {
    const result = cachedPrepare(
      `INSERT INTO recall_events (memory_id, query, was_used, rank_position, similarity_score)
       VALUES (?, ?, ?, ?, ?)`
    ).run(memoryId, query, wasUsed ? 1 : 0, rankPosition, similarityScore);

    return result.lastInsertRowid as number;
  } catch (error) {
    logWarn('recall-events', 'Failed to insert recall event', {
      error: error instanceof Error ? error.message : String(error),
      memoryId,
    });
    return 0;
  }
}

export function insertRecallEventsBatch(
  events: Array<{
    memoryId: number;
    query: string;
    wasUsed: boolean;
    rankPosition: number;
    similarityScore: number | null;
  }>
): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO recall_events (memory_id, query, was_used, rank_position, similarity_score)
     VALUES (?, ?, ?, ?, ?)`
  );

  const transaction = db.transaction(() => {
    for (const event of events) {
      stmt.run(
        event.memoryId,
        event.query,
        event.wasUsed ? 1 : 0,
        event.rankPosition,
        event.similarityScore
      );
    }
  });

  try {
    transaction();
  } catch (error) {
    logWarn('recall-events', 'Failed to insert recall events batch', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ============================================================================
// Query
// ============================================================================

export interface RecallStatsRow {
  total_recalls: number;
  times_used: number;
  avg_rank_used: number | null;
  avg_rank_ignored: number | null;
  last_recalled: string | null;
}

export function getRecallStatsRow(memoryId: number): RecallStatsRow {
  const row = cachedPrepare(
    `SELECT
       COUNT(*) as total_recalls,
       SUM(was_used) as times_used,
       AVG(CASE WHEN was_used = 1 THEN rank_position END) as avg_rank_used,
       AVG(CASE WHEN was_used = 0 THEN rank_position END) as avg_rank_ignored,
       MAX(created_at) as last_recalled
     FROM recall_events
     WHERE memory_id = ?`
  ).get(memoryId) as any;

  return {
    total_recalls: row?.total_recalls ?? 0,
    times_used: row?.times_used ?? 0,
    avg_rank_used: row?.avg_rank_used ?? null,
    avg_rank_ignored: row?.avg_rank_ignored ?? null,
    last_recalled: row?.last_recalled ?? null,
  };
}

export interface RecallSummaryRow {
  total: number;
  unique_mems: number;
  total_used: number;
}

export function getRecallSummaryRow(): RecallSummaryRow {
  const row = cachedPrepare(
    `SELECT COUNT(*) as total, COUNT(DISTINCT memory_id) as unique_mems,
            SUM(was_used) as total_used
     FROM recall_events`
  ).get() as any;

  return {
    total: row?.total ?? 0,
    unique_mems: row?.unique_mems ?? 0,
    total_used: row?.total_used ?? 0,
  };
}

export function getNeverUsedCount(): number {
  const row = cachedPrepare(
    `SELECT COUNT(DISTINCT memory_id) as count
     FROM recall_events
     WHERE memory_id NOT IN (
       SELECT DISTINCT memory_id FROM recall_events WHERE was_used = 1
     )`
  ).get() as any;

  return row?.count ?? 0;
}

export interface RecallPerformerRow {
  memoryId: number;
  useRate: number;
  totalRecalls: number;
}

export function getTopPerformers(minRecalls: number = 3, limit: number = 10): RecallPerformerRow[] {
  return cachedPrepare(
    `SELECT memory_id as memoryId,
            CAST(SUM(was_used) AS REAL) / COUNT(*) as useRate,
            COUNT(*) as totalRecalls
     FROM recall_events
     GROUP BY memory_id
     HAVING COUNT(*) >= ?
     ORDER BY useRate DESC
     LIMIT ?`
  ).all(minRecalls, limit) as RecallPerformerRow[];
}

export function getWorstPerformers(
  minRecalls: number = 3,
  limit: number = 10
): RecallPerformerRow[] {
  return cachedPrepare(
    `SELECT memory_id as memoryId,
            CAST(SUM(was_used) AS REAL) / COUNT(*) as useRate,
            COUNT(*) as totalRecalls
     FROM recall_events
     GROUP BY memory_id
     HAVING COUNT(*) >= ?
     ORDER BY useRate ASC
     LIMIT ?`
  ).all(minRecalls, limit) as RecallPerformerRow[];
}

export interface BoostRow {
  memory_id: number;
  total: number;
  used: number;
}

export function getBoostDataForMemory(memoryId: number): BoostRow {
  const row = cachedPrepare(
    `SELECT COUNT(*) as total, SUM(was_used) as used
     FROM recall_events
     WHERE memory_id = ?`
  ).get(memoryId) as any;

  return {
    memory_id: memoryId,
    total: row?.total ?? 0,
    used: row?.used ?? 0,
  };
}

export function getBoostDataForMemories(memoryIds: number[]): BoostRow[] {
  if (memoryIds.length === 0) return [];

  // Batch into fixed-size chunks — use db.prepare() (uncached) because
  // the last batch may have fewer placeholders, creating a unique SQL string.
  // cachedPrepare would leak one entry per unique batch size.
  const BATCH_SIZE = 50;
  const db = getDb();
  const results: BoostRow[] = [];

  for (let i = 0; i < memoryIds.length; i += BATCH_SIZE) {
    const batch = memoryIds.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT memory_id, COUNT(*) as total, SUM(was_used) as used
       FROM recall_events
       WHERE memory_id IN (${placeholders})
       GROUP BY memory_id`
      )
      .all(...batch) as BoostRow[];
    results.push(...rows);
  }

  return results;
}

export function getNeverUsedMemoryRows(
  minRecalls: number = 3,
  limit: number = 50
): Array<{ memoryId: number; totalRecalls: number; lastRecalled: string }> {
  return cachedPrepare(
    `SELECT memory_id as memoryId,
            COUNT(*) as totalRecalls,
            MAX(created_at) as lastRecalled
     FROM recall_events
     GROUP BY memory_id
     HAVING SUM(was_used) = 0 AND COUNT(*) >= ?
     ORDER BY totalRecalls DESC
     LIMIT ?`
  ).all(minRecalls, limit) as Array<{
    memoryId: number;
    totalRecalls: number;
    lastRecalled: string;
  }>;
}

// ============================================================================
// Cleanup
// ============================================================================

export function deleteOldRecallEvents(olderThanDays: number = 90): number {
  try {
    const result = cachedPrepare(
      `DELETE FROM recall_events
       WHERE created_at < datetime('now', '-' || ? || ' days')`
    ).run(olderThanDays);

    const deleted = result.changes;
    if (deleted > 0) {
      logInfo(
        'recall-events',
        `Cleaned up ${deleted} recall events older than ${olderThanDays} days`
      );
    }
    return deleted;
  } catch (error) {
    logWarn('recall-events', 'Failed to cleanup recall events', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
