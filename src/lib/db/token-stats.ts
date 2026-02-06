import { getDb } from './connection.js';

export type TokenEventType = 'recall' | 'search' | 'search_code' | 'session_summary';

export interface TokenStatRecord {
  event_type: TokenEventType;
  query?: string;
  returned_tokens: number;
  full_source_tokens: number;
  savings_tokens: number;
  files_count?: number;
  chunks_count?: number;
  model?: string;
  estimated_cost?: number;
}

/**
 * Record a token saving event.
 */
export function recordTokenStat(record: TokenStatRecord): void {
  const database = getDb();
  database
    .prepare(
      `
    INSERT INTO token_stats (event_type, query, returned_tokens, full_source_tokens, savings_tokens, files_count, chunks_count, model, estimated_cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      record.event_type,
      record.query ?? null,
      record.returned_tokens,
      record.full_source_tokens,
      record.savings_tokens,
      record.files_count ?? null,
      record.chunks_count ?? null,
      record.model ?? null,
      record.estimated_cost ?? 0
    );
}

export interface TokenStatsAggregated {
  event_type: TokenEventType;
  query_count: number;
  total_returned_tokens: number;
  total_full_source_tokens: number;
  total_savings_tokens: number;
  total_estimated_cost: number;
}

/**
 * Get aggregated token stats by event type.
 */
export function getTokenStatsAggregated(): TokenStatsAggregated[] {
  const database = getDb();
  return database
    .prepare(
      `
    SELECT
      event_type,
      COUNT(*) as query_count,
      SUM(returned_tokens) as total_returned_tokens,
      SUM(full_source_tokens) as total_full_source_tokens,
      SUM(savings_tokens) as total_savings_tokens,
      COALESCE(SUM(estimated_cost), 0) as total_estimated_cost
    FROM token_stats
    GROUP BY event_type
    ORDER BY event_type
  `
    )
    .all() as TokenStatsAggregated[];
}

/**
 * Get total token savings summary.
 */
export function getTokenStatsSummary(): {
  total_queries: number;
  total_returned_tokens: number;
  total_full_source_tokens: number;
  total_savings_tokens: number;
  total_estimated_cost: number;
} {
  const database = getDb();
  const row = database
    .prepare(
      `
    SELECT
      COUNT(*) as total_queries,
      COALESCE(SUM(returned_tokens), 0) as total_returned_tokens,
      COALESCE(SUM(full_source_tokens), 0) as total_full_source_tokens,
      COALESCE(SUM(savings_tokens), 0) as total_savings_tokens,
      COALESCE(SUM(estimated_cost), 0) as total_estimated_cost
    FROM token_stats
  `
    )
    .get() as {
    total_queries: number;
    total_returned_tokens: number;
    total_full_source_tokens: number;
    total_savings_tokens: number;
    total_estimated_cost: number;
  };

  return row;
}

/**
 * Clear all token stats.
 */
export function clearTokenStats(): void {
  const database = getDb();
  database.prepare('DELETE FROM token_stats').run();
}
