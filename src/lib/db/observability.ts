/**
 * Observability DB operations — raw SQL for dashboard metrics.
 */

import { cachedPrepare } from './connection.js';
import { logWarn } from '../fault-logger.js';

export interface MemoryHealthRow {
  total: number;
  never_accessed: number;
  stale: number;
  avg_age_days: number;
  avg_access: number;
}

export function getMemoryHealthRow(): MemoryHealthRow | null {
  try {
    return cachedPrepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN access_count = 0 THEN 1 ELSE 0 END) as never_accessed,
         SUM(CASE WHEN julianday('now') - julianday(created_at) > 90
               AND access_count = 0 THEN 1 ELSE 0 END) as stale,
         AVG(julianday('now') - julianday(created_at)) as avg_age_days,
         AVG(access_count) as avg_access
       FROM memories`
    ).get() as MemoryHealthRow | null;
  } catch (error) {
    logWarn('observability-db', 'Failed to get memory health', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export interface IndexFreshnessRow {
  doc_count: number;
  last_updated: string | null;
  code_count: number;
}

export function getIndexFreshnessRows(): IndexFreshnessRow {
  try {
    const docRow = cachedPrepare(
      `SELECT COUNT(*) as count, MAX(updated_at) as last_updated
       FROM documents`
    ).get() as any;

    const codeRow = cachedPrepare(
      `SELECT COUNT(*) as count FROM documents WHERE file_path LIKE '%.ts'
       OR file_path LIKE '%.js' OR file_path LIKE '%.py'
       OR file_path LIKE '%.go' OR file_path LIKE '%.rs'`
    ).get() as any;

    return {
      doc_count: docRow?.count ?? 0,
      last_updated: docRow?.last_updated ?? null,
      code_count: codeRow?.count ?? 0,
    };
  } catch (error) {
    logWarn('observability-db', 'Failed to get index freshness', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { doc_count: 0, last_updated: null, code_count: 0 };
  }
}

export interface TokenSavingsRow {
  total_saved: number;
  total_full: number;
}

export function getTokenSavingsRow(): TokenSavingsRow {
  try {
    const row = cachedPrepare(
      `SELECT
         SUM(savings_tokens) as total_saved,
         SUM(full_source_tokens) as total_full
       FROM token_stats`
    ).get() as any;

    return {
      total_saved: row?.total_saved ?? 0,
      total_full: row?.total_full ?? 0,
    };
  } catch (error) {
    logWarn('observability-db', 'Failed to get token savings', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { total_saved: 0, total_full: 0 };
  }
}
