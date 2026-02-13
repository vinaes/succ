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
 * Increment correction count for a memory (user corrected AI on this topic).
 * Memories with correction_count >= 2 become Tier 1 pins.
 */
export function incrementCorrectionCount(memoryId: number): void {
  const database = getDb();
  database
    .prepare(
      `
      UPDATE memories
      SET correction_count = COALESCE(correction_count, 0) + 1
      WHERE id = ?
    `
    )
    .run(memoryId);
}

/**
 * Set the is_invariant flag on a memory (auto-detected rule/constraint).
 */
export function setMemoryInvariant(memoryId: number, isInvariant: boolean): void {
  const database = getDb();
  database
    .prepare(`UPDATE memories SET is_invariant = ? WHERE id = ?`)
    .run(isInvariant ? 1 : 0, memoryId);
}

/**
 * Get all pinned memories (correction_count >= threshold OR is_invariant).
 * Used for Tier 1 working memory — always loaded regardless of age.
 */
export function getPinnedMemories(threshold: number = 2): Array<{
  id: number;
  content: string;
  tags: string | null;
  source: string | null;
  quality_score: number | null;
  quality_factors: string | null;
  access_count: number;
  last_accessed: string | null;
  valid_from: string | null;
  valid_until: string | null;
  correction_count: number;
  is_invariant: boolean;
  created_at: string;
}> {
  const database = getDb();
  const rows = database
    .prepare(
      `
      SELECT id, content, tags, source, quality_score, quality_factors,
             access_count, last_accessed, valid_from, valid_until,
             correction_count, is_invariant, created_at
      FROM memories
      WHERE invalidated_by IS NULL
        AND (correction_count >= ? OR is_invariant = 1)
      ORDER BY is_invariant DESC, correction_count DESC, quality_score DESC
    `
    )
    .all(threshold) as any[];
  return rows.map((row: any) => ({
    ...row,
    access_count: row.access_count ?? 0,
    correction_count: row.correction_count ?? 0,
    is_invariant: !!(row.is_invariant),
  }));
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
