import { getDb } from './connection.js';

export function updateTokenFrequencies(tokens: string[]): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO token_frequencies (token, frequency, updated_at)
    VALUES (?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(token) DO UPDATE SET
      frequency = frequency + 1,
      updated_at = CURRENT_TIMESTAMP
  `);

  const updateMany = database.transaction((tokens: string[]) => {
    for (const token of tokens) {
      if (token.length >= 2) {
        stmt.run(token);
      }
    }
  });

  updateMany(tokens);
}

/**
 * Get token frequency from the database.
 * Returns 0 if token not found.
 */
export function getTokenFrequency(token: string): number {
  const database = getDb();
  const row = database
    .prepare('SELECT frequency FROM token_frequencies WHERE token = ?')
    .get(token) as { frequency: number } | undefined;
  return row?.frequency ?? 0;
}

/**
 * Get multiple token frequencies at once (more efficient for DP).
 */
export function getTokenFrequencies(tokens: string[]): Map<string, number> {
  const database = getDb();
  const result = new Map<string, number>();

  if (tokens.length === 0) return result;

  // Batch query for efficiency
  const placeholders = tokens.map(() => '?').join(',');
  const rows = database
    .prepare(`SELECT token, frequency FROM token_frequencies WHERE token IN (${placeholders})`)
    .all(...tokens) as Array<{ token: string; frequency: number }>;

  for (const row of rows) {
    result.set(row.token, row.frequency);
  }

  return result;
}

/**
 * Get total token count for probability calculation.
 */
export function getTotalTokenCount(): number {
  const database = getDb();
  const row = database
    .prepare('SELECT SUM(frequency) as total FROM token_frequencies')
    .get() as { total: number | null };
  return row?.total ?? 0;
}

/**
 * Get top N most frequent tokens (for debugging/stats).
 */
export function getTopTokens(limit: number = 100): Array<{ token: string; frequency: number }> {
  const database = getDb();
  return database
    .prepare('SELECT token, frequency FROM token_frequencies ORDER BY frequency DESC LIMIT ?')
    .all(limit) as Array<{ token: string; frequency: number }>;
}

/**
 * Clear all token frequencies (for reindexing).
 */
export function clearTokenFrequencies(): void {
  const database = getDb();
  database.prepare('DELETE FROM token_frequencies').run();
}

/**
 * Get token frequency stats.
 */
export function getTokenFrequencyStats(): {
  unique_tokens: number;
  total_occurrences: number;
  avg_frequency: number;
} {
  const database = getDb();
  const row = database
    .prepare(`
      SELECT
        COUNT(*) as unique_tokens,
        COALESCE(SUM(frequency), 0) as total_occurrences
      FROM token_frequencies
    `)
    .get() as { unique_tokens: number; total_occurrences: number };

  return {
    unique_tokens: row.unique_tokens,
    total_occurrences: row.total_occurrences,
    avg_frequency: row.unique_tokens > 0 ? row.total_occurrences / row.unique_tokens : 0,
  };
}
