import { getDb } from './connection.js';

/**
 * Increment access count for a memory.
 * @param memoryId - The memory ID
 * @param weight - Weight of the access (1.0 for exact match, 0.5 for similarity hit)
 */
export function incrementMemoryAccess(memoryId: number, weight: number = 1.0): void {
  const database = getDb();
  database
    .prepare(
      `
      UPDATE memories
      SET access_count = COALESCE(access_count, 0) + ?,
          last_accessed = CURRENT_TIMESTAMP
      WHERE id = ?
    `
    )
    .run(weight, memoryId);
}

/**
 * Batch increment access counts for multiple memories.
 * @param accesses - Array of { memoryId, weight } objects
 */
export function incrementMemoryAccessBatch(
  accesses: Array<{ memoryId: number; weight: number }>
): void {
  if (accesses.length === 0) return;

  const database = getDb();
  const stmt = database.prepare(`
    UPDATE memories
    SET access_count = COALESCE(access_count, 0) + ?,
        last_accessed = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  const transaction = database.transaction((items: Array<{ memoryId: number; weight: number }>) => {
    for (const { memoryId, weight } of items) {
      stmt.run(weight, memoryId);
    }
  });

  transaction(accesses);
}

/**
 * Memory data for retention calculations
 */
export interface MemoryForRetention {
  id: number;
  content: string;
  quality_score: number | null;
  access_count: number;
  created_at: string;
  last_accessed: string | null;
}

/**
 * Get all memories with retention-relevant fields.
 */
export function getAllMemoriesForRetention(): MemoryForRetention[] {
  const database = getDb();
  const rows = database
    .prepare(
      `
      SELECT id, content, quality_score, access_count, created_at, last_accessed
      FROM memories
      ORDER BY created_at ASC
    `
    )
    .all() as Array<{
    id: number;
    content: string;
    quality_score: number | null;
    access_count: number | null;
    created_at: string;
    last_accessed: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    quality_score: row.quality_score,
    access_count: row.access_count ?? 0,
    created_at: row.created_at,
    last_accessed: row.last_accessed,
  }));
}
