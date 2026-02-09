import { getDb } from './connection.js';
import type {
  WebSearchHistoryInput,
  WebSearchHistoryRecord,
  WebSearchHistoryFilter,
  WebSearchHistorySummary,
} from '../storage/types.js';

/**
 * Record a web search to the history table.
 */
export function recordWebSearch(record: WebSearchHistoryInput): number {
  const database = getDb();
  const result = database
    .prepare(
      `INSERT INTO web_search_history (tool_name, model, query, prompt_tokens, completion_tokens, estimated_cost_usd, citations_count, has_reasoning, response_length_chars)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.tool_name,
      record.model,
      record.query,
      record.prompt_tokens,
      record.completion_tokens,
      record.estimated_cost_usd,
      record.citations_count,
      record.has_reasoning ? 1 : 0,
      record.response_length_chars
    );
  return result.lastInsertRowid as number;
}

/**
 * Get web search history with optional filters.
 */
export function getWebSearchHistory(filter: WebSearchHistoryFilter): WebSearchHistoryRecord[] {
  const database = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.tool_name) {
    conditions.push('tool_name = ?');
    params.push(filter.tool_name);
  }
  if (filter.model) {
    conditions.push('model = ?');
    params.push(filter.model);
  }
  if (filter.query_text) {
    conditions.push('query LIKE ?');
    params.push(`%${filter.query_text}%`);
  }
  if (filter.date_from) {
    conditions.push('created_at >= ?');
    params.push(filter.date_from);
  }
  if (filter.date_to) {
    conditions.push('created_at <= ?');
    params.push(filter.date_to + ' 23:59:59');
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filter.limit ?? 20;

  const rows = database
    .prepare(`SELECT * FROM web_search_history ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as Array<Omit<WebSearchHistoryRecord, 'has_reasoning'> & { has_reasoning: number }>;

  return rows.map((row) => ({
    ...row,
    has_reasoning: !!row.has_reasoning,
  }));
}

/**
 * Get aggregated web search summary.
 */
export function getWebSearchSummary(): WebSearchHistorySummary {
  const database = getDb();

  const totals = database
    .prepare(
      `SELECT
        COUNT(*) as total_searches,
        COALESCE(SUM(estimated_cost_usd), 0) as total_cost_usd
       FROM web_search_history`
    )
    .get() as { total_searches: number; total_cost_usd: number };

  const byTool = database
    .prepare(
      `SELECT
        tool_name,
        COUNT(*) as count,
        COALESCE(SUM(estimated_cost_usd), 0) as cost
       FROM web_search_history
       GROUP BY tool_name`
    )
    .all() as Array<{ tool_name: string; count: number; cost: number }>;

  const today = database
    .prepare(
      `SELECT
        COUNT(*) as today_searches,
        COALESCE(SUM(estimated_cost_usd), 0) as today_cost_usd
       FROM web_search_history
       WHERE date(created_at) = date('now')`
    )
    .get() as { today_searches: number; today_cost_usd: number };

  const by_tool: Record<string, { count: number; cost: number }> = {};
  for (const row of byTool) {
    by_tool[row.tool_name] = { count: row.count, cost: row.cost };
  }

  return {
    total_searches: totals.total_searches,
    total_cost_usd: totals.total_cost_usd,
    by_tool,
    today_searches: today.today_searches,
    today_cost_usd: today.today_cost_usd,
  };
}

/**
 * Get today's total web search spend.
 */
export function getTodayWebSearchSpend(): number {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0) as total
       FROM web_search_history
       WHERE date(created_at) = date('now')`
    )
    .get() as { total: number };
  return row.total;
}

/**
 * Clear all web search history.
 */
export function clearWebSearchHistory(): void {
  const database = getDb();
  database.prepare('DELETE FROM web_search_history').run();
}
