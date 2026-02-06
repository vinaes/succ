import { getDb } from './connection.js';
import { sqliteVecAvailable, MemoryType } from './schema.js';
import { bufferToFloatArray, floatArrayToBuffer } from './helpers.js';
import { cosineSimilarity } from '../embeddings.js';
import { triggerAutoExport } from '../graph-scheduler.js';

export interface Memory {
  id: number;
  content: string;
  tags: string[];
  source: string | null;
  quality_score: number | null;
  quality_factors: Record<string, number> | null;
  access_count: number;
  last_accessed: string | null;
  // Temporal validity
  valid_from: string | null;  // When fact became valid (null = always valid)
  valid_until: string | null; // When fact expires (null = never expires)
  created_at: string;
}

export interface MemorySearchResult {
  id: number;
  content: string;
  tags: string[];
  source: string | null;
  quality_score: number | null;
  quality_factors: Record<string, number> | null;
  access_count: number;
  last_accessed: string | null;
  valid_from: string | null;
  valid_until: string | null;
  created_at: string;
  similarity: number;
}

export interface SaveMemoryResult {
  id: number;
  isDuplicate: boolean;
  similarity?: number;
}

export interface QualityScoreData {
  score: number;
  factors: Record<string, number>;
}

/**
 * Check if a similar memory already exists (semantic deduplication)
 * Returns the existing memory ID if found, null otherwise
 */
export function findSimilarMemory(
  embedding: number[],
  threshold: number = 0.92 // High threshold for near-duplicates
): { id: number; content: string; similarity: number } | null {
  const database = getDb();

  const rows = database.prepare('SELECT id, content, embedding FROM memories').all() as Array<{
    id: number;
    content: string;
    embedding: Buffer;
  }>;

  for (const row of rows) {
    const existingEmbedding = bufferToFloatArray(row.embedding);
    const similarity = cosineSimilarity(embedding, existingEmbedding);

    if (similarity >= threshold) {
      return { id: row.id, content: row.content, similarity };
    }
  }

  return null;
}

/**
 * Save a new memory with optional deduplication, type, quality score, auto-linking, and validity period
 * Returns { id, isDuplicate, similarity?, linksCreated? }
 */
export function saveMemory(
  content: string,
  embedding: number[],
  tags: string[] = [],
  source?: string,
  options: {
    deduplicate?: boolean;
    type?: MemoryType;
    autoLink?: boolean;
    linkThreshold?: number;
    qualityScore?: QualityScoreData;
    // Temporal validity
    validFrom?: string | Date;
    validUntil?: string | Date;
  } = {}
): SaveMemoryResult & { linksCreated?: number } {
  const { deduplicate = true, type = 'observation', autoLink = true, linkThreshold = 0.7, qualityScore, validFrom, validUntil } = options;

  // Check for duplicates if enabled
  if (deduplicate) {
    const existing = findSimilarMemory(embedding);
    if (existing) {
      return { id: existing.id, isDuplicate: true, similarity: existing.similarity };
    }
  }

  const database = getDb();
  const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
  const tagsJson = tags.length > 0 ? JSON.stringify(tags) : null;
  const qualityFactorsJson = qualityScore?.factors ? JSON.stringify(qualityScore.factors) : null;

  // Convert Date objects to ISO strings
  const validFromStr = validFrom ? (validFrom instanceof Date ? validFrom.toISOString() : validFrom) : null;
  const validUntilStr = validUntil ? (validUntil instanceof Date ? validUntil.toISOString() : validUntil) : null;

  const result = database
    .prepare(`
      INSERT INTO memories (content, tags, source, type, quality_score, quality_factors, valid_from, valid_until, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      content,
      tagsJson,
      source ?? null,
      type,
      qualityScore?.score ?? null,
      qualityFactorsJson,
      validFromStr,
      validUntilStr,
      embeddingBlob
    );

  const newId = result.lastInsertRowid as number;

  // Also insert into vec_memories for fast KNN search
  if (sqliteVecAvailable) {
    try {
      const vecResult = database.prepare('INSERT INTO vec_memories(embedding) VALUES (?)').run(embeddingBlob);
      database.prepare('INSERT INTO vec_memories_map(vec_rowid, memory_id) VALUES (?, ?)').run(vecResult.lastInsertRowid, newId);
    } catch {
      // Ignore vec table errors
    }
  }
  let linksCreated = 0;

  // Auto-link to similar existing memories
  if (autoLink) {
    linksCreated = autoLinkNewMemory(newId, embedding, linkThreshold);
  }

  // Schedule auto-export if enabled (async, non-blocking)
  if (linksCreated > 0) {
    triggerAutoExport().catch(() => {});
  }

  return { id: newId, isDuplicate: false, linksCreated };
}

/**
 * Auto-link a new memory to existing similar memories
 */
function autoLinkNewMemory(memoryId: number, embedding: number[], threshold: number = 0.7): number {
  const database = getDb();

  // Get all existing memories (excluding the new one)
  const memories = database
    .prepare('SELECT id, embedding FROM memories WHERE id != ?')
    .all(memoryId) as Array<{ id: number; embedding: Buffer }>;

  const similarities: Array<{ id: number; similarity: number }> = [];

  for (const mem of memories) {
    const memEmbedding = bufferToFloatArray(mem.embedding);
    const similarity = cosineSimilarity(embedding, memEmbedding);

    if (similarity >= threshold) {
      similarities.push({ id: mem.id, similarity });
    }
  }

  // Sort and take top 3
  similarities.sort((a, b) => b.similarity - a.similarity);
  const topSimilar = similarities.slice(0, 3);

  let created = 0;
  for (const { id: targetId, similarity } of topSimilar) {
    try {
      // Import createMemoryLink from graph.ts when it's created
      // For now, we'll need to update this after Phase 9
      const { createMemoryLink } = require('./graph.js');
      const result = createMemoryLink(memoryId, targetId, 'similar_to', similarity);
      if (result.created) created++;
    } catch {
      // Ignore link creation errors
    }
  }

  return created;
}

/**
 * Search memories by semantic similarity with temporal awareness.
 * Uses sqlite-vec for fast KNN search when available, falls back to brute-force.
 */
export function searchMemories(
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.3,
  tags?: string[],
  since?: Date,
  options?: {
    includeExpired?: boolean;  // Include expired memories (default: false)
    asOfDate?: Date;  // Point-in-time query (default: now)
  }
): MemorySearchResult[] {
  const database = getDb();
  const now = options?.asOfDate?.getTime() ?? Date.now();
  const includeExpired = options?.includeExpired ?? false;

  // Try sqlite-vec fast path first
  if (sqliteVecAvailable) {
    try {
      // KNN search via sqlite-vec with mapping table
      const candidateLimit = Math.max(limit * 5, 50); // Get extra for filtering
      const queryBuffer = floatArrayToBuffer(queryEmbedding);

      const vecResults = database.prepare(`
        SELECT m.memory_id, v.distance
        FROM vec_memories v
        JOIN vec_memories_map m ON m.vec_rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND k = ?
        ORDER BY v.distance
      `).all(queryBuffer, candidateLimit) as Array<{ memory_id: number; distance: number }>;

      if (vecResults.length > 0) {
        // Get memory IDs
        const memoryIds = vecResults.map(r => r.memory_id);
        const distanceMap = new Map(vecResults.map(r => [r.memory_id, r.distance]));

        // Fetch full memory data for candidates
        const placeholders = memoryIds.map(() => '?').join(',');
        let query = `SELECT * FROM memories WHERE id IN (${placeholders})`;
        const params: any[] = [...memoryIds];

        if (since) {
          query += ' AND created_at >= ?';
          params.push(since.toISOString());
        }

        const rows = database.prepare(query).all(...params) as Array<{
          id: number;
          content: string;
          tags: string | null;
          source: string | null;
          quality_score: number | null;
          quality_factors: string | null;
          access_count: number | null;
          last_accessed: string | null;
          valid_from: string | null;
          valid_until: string | null;
          created_at: string;
        }>;

        const results: MemorySearchResult[] = [];

        for (const row of rows) {
          // Check validity period
          if (!includeExpired) {
            if (row.valid_from) {
              const validFrom = new Date(row.valid_from).getTime();
              if (now < validFrom) continue;
            }
            if (row.valid_until) {
              const validUntil = new Date(row.valid_until).getTime();
              if (now > validUntil) continue;
            }
          }

          const rowTags: string[] = row.tags ? JSON.parse(row.tags) : [];

          // Filter by tags if specified
          if (tags && tags.length > 0) {
            const hasMatchingTag = tags.some((t) =>
              rowTags.some((rt) => rt.toLowerCase().includes(t.toLowerCase()))
            );
            if (!hasMatchingTag) continue;
          }

          // Convert distance to similarity (cosine distance = 1 - similarity)
          const distance = distanceMap.get(row.id) ?? 1;
          const similarity = 1 - distance;

          if (similarity >= threshold) {
            results.push({
              id: row.id,
              content: row.content,
              tags: rowTags,
              source: row.source,
              quality_score: row.quality_score,
              quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
              access_count: row.access_count ?? 0,
              last_accessed: row.last_accessed,
              valid_from: row.valid_from,
              valid_until: row.valid_until,
              created_at: row.created_at,
              similarity,
            });
          }
        }

        // Sort by similarity (already mostly sorted but need to re-sort after filtering)
        results.sort((a, b) => b.similarity - a.similarity);
        return results.slice(0, limit);
      }
    } catch {
      // Fall through to brute-force
    }
  }

  // Brute-force fallback
  let query = 'SELECT * FROM memories WHERE 1=1';
  const params: any[] = [];

  if (since) {
    query += ' AND created_at >= ?';
    params.push(since.toISOString());
  }

  const rows = database.prepare(query).all(...params) as Array<{
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    quality_score: number | null;
    quality_factors: string | null;
    access_count: number | null;
    last_accessed: string | null;
    valid_from: string | null;
    valid_until: string | null;
    embedding: Buffer;
    created_at: string;
  }>;

  const results: MemorySearchResult[] = [];

  for (const row of rows) {
    if (!includeExpired) {
      if (row.valid_from) {
        const validFrom = new Date(row.valid_from).getTime();
        if (now < validFrom) continue;
      }
      if (row.valid_until) {
        const validUntil = new Date(row.valid_until).getTime();
        if (now > validUntil) continue;
      }
    }

    const rowTags: string[] = row.tags ? JSON.parse(row.tags) : [];

    if (tags && tags.length > 0) {
      const hasMatchingTag = tags.some((t) =>
        rowTags.some((rt) => rt.toLowerCase().includes(t.toLowerCase()))
      );
      if (!hasMatchingTag) continue;
    }

    const embedding = bufferToFloatArray(row.embedding);
    const similarity = cosineSimilarity(queryEmbedding, embedding);

    if (similarity >= threshold) {
      results.push({
        id: row.id,
        content: row.content,
        tags: rowTags,
        source: row.source,
        quality_score: row.quality_score,
        quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
        access_count: row.access_count ?? 0,
        last_accessed: row.last_accessed,
        valid_from: row.valid_from,
        valid_until: row.valid_until,
        created_at: row.created_at,
        similarity,
      });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, limit);
}

/**
 * Get recent memories
 */
export function getRecentMemories(limit: number = 10): Memory[] {
  const database = getDb();
  const rows = database
    .prepare(`
      SELECT id, content, tags, source, quality_score, quality_factors, access_count, last_accessed, valid_from, valid_until, created_at
      FROM memories
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
      id: number;
      content: string;
      tags: string | null;
      source: string | null;
      quality_score: number | null;
      quality_factors: string | null;
      access_count: number | null;
      last_accessed: string | null;
      valid_from: string | null;
      valid_until: string | null;
      created_at: string;
    }>;

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    tags: row.tags ? JSON.parse(row.tags) : [],
    source: row.source,
    quality_score: row.quality_score,
    quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
    access_count: row.access_count ?? 0,
    last_accessed: row.last_accessed,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    created_at: row.created_at,
  }));
}

/**
 * Delete a memory by ID
 */
export function deleteMemory(id: number): boolean {
  const database = getDb();

  // Also delete from vec_memories using mapping table
  if (sqliteVecAvailable) {
    try {
      const mapping = database.prepare('SELECT vec_rowid FROM vec_memories_map WHERE memory_id = ?').get(id) as { vec_rowid: number } | undefined;
      if (mapping) {
        database.prepare('DELETE FROM vec_memories WHERE rowid = ?').run(mapping.vec_rowid);
        database.prepare('DELETE FROM vec_memories_map WHERE memory_id = ?').run(id);
      }
    } catch {
      // Ignore vec table errors
    }
  }

  const result = database.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Get memory stats including type breakdown
 */
export function getMemoryStats(): {
  total_memories: number;
  oldest_memory: string | null;
  newest_memory: string | null;
  by_type: Record<string, number>;
  stale_count: number; // Memories older than 30 days
} {
  const database = getDb();

  const total = database.prepare('SELECT COUNT(*) as count FROM memories').get() as {
    count: number;
  };
  const oldest = database
    .prepare('SELECT MIN(created_at) as oldest FROM memories')
    .get() as { oldest: string | null };
  const newest = database
    .prepare('SELECT MAX(created_at) as newest FROM memories')
    .get() as { newest: string | null };

  // Count by type
  const typeCounts = database
    .prepare('SELECT COALESCE(type, ?) as type, COUNT(*) as count FROM memories GROUP BY type')
    .all('observation') as Array<{ type: string; count: number }>;
  const by_type: Record<string, number> = {};
  for (const row of typeCounts) {
    by_type[row.type] = row.count;
  }

  // Count stale memories (older than 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const stale = database
    .prepare('SELECT COUNT(*) as count FROM memories WHERE created_at < ?')
    .get(thirtyDaysAgo) as { count: number };

  return {
    total_memories: total.count,
    oldest_memory: oldest.oldest,
    newest_memory: newest.newest,
    by_type,
    stale_count: stale.count,
  };
}

/**
 * Delete memories older than a given date
 */
export function deleteMemoriesOlderThan(date: Date): number {
  const database = getDb();
  const result = database
    .prepare('DELETE FROM memories WHERE created_at < ?')
    .run(date.toISOString());
  return result.changes;
}

/**
 * Delete memories by tag
 */
export function deleteMemoriesByTag(tag: string): number {
  const database = getDb();

  // Get all memories with tags
  const memories = database
    .prepare('SELECT id, tags FROM memories WHERE tags IS NOT NULL')
    .all() as Array<{ id: number; tags: string }>;

  const toDelete: number[] = [];

  for (const memory of memories) {
    try {
      const tags: string[] = JSON.parse(memory.tags);
      if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
        toDelete.push(memory.id);
      }
    } catch {
      // Skip invalid JSON
    }
  }

  if (toDelete.length === 0) return 0;

  const placeholders = toDelete.map(() => '?').join(',');
  const result = database.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...toDelete);

  return result.changes;
}

/**
 * Get memory by ID
 */
export function getMemoryById(id: number): Memory | null {
  const database = getDb();
  const row = database
    .prepare('SELECT id, content, tags, source, quality_score, quality_factors, access_count, last_accessed, valid_from, valid_until, created_at FROM memories WHERE id = ?')
    .get(id) as {
      id: number;
      content: string;
      tags: string | null;
      source: string | null;
      quality_score: number | null;
      quality_factors: string | null;
      access_count: number | null;
      last_accessed: string | null;
      valid_from: string | null;
      valid_until: string | null;
      created_at: string;
    } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    content: row.content,
    tags: row.tags ? JSON.parse(row.tags) : [],
    source: row.source,
    quality_score: row.quality_score,
    quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
    access_count: row.access_count ?? 0,
    last_accessed: row.last_accessed,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    created_at: row.created_at,
  };
}

/**
 * Delete memories by IDs (batch operation for retention cleanup).
 */
export function deleteMemoriesByIds(ids: number[]): number {
  if (ids.length === 0) return 0;

  const database = getDb();
  const placeholders = ids.map(() => '?').join(',');
  const result = database
    .prepare(`DELETE FROM memories WHERE id IN (${placeholders})`)
    .run(...ids);

  // Invalidate BM25 index since memories changed (will be handled in bm25-indexes module)
  try {
    const { invalidateMemoriesBm25Index } = require('./bm25-indexes.js');
    invalidateMemoriesBm25Index();
  } catch {
    // Module not loaded yet
  }

  return result.changes;
}

/**
 * Search memories as they existed at a specific point in time.
 * Core function for point-in-time queries.
 */
export function searchMemoriesAsOf(
  queryEmbedding: number[],
  asOfDate: Date,
  limit: number = 5,
  threshold: number = 0.3
): MemorySearchResult[] {
  const database = getDb();
  const asOfStr = asOfDate.toISOString();
  const asOfTime = asOfDate.getTime();

  // Get memories that existed at that time
  const rows = database.prepare(`
    SELECT * FROM memories
    WHERE created_at <= ?
  `).all(asOfStr) as Array<{
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    quality_score: number | null;
    quality_factors: string | null;
    access_count: number | null;
    last_accessed: string | null;
    valid_from: string | null;
    valid_until: string | null;
    embedding: Buffer;
    created_at: string;
  }>;

  const results: MemorySearchResult[] = [];

  for (const row of rows) {
    // Check validity period at asOfDate
    if (row.valid_from) {
      const validFrom = new Date(row.valid_from).getTime();
      if (asOfTime < validFrom) continue;
    }
    if (row.valid_until) {
      const validUntil = new Date(row.valid_until).getTime();
      if (asOfTime > validUntil) continue;
    }

    const embedding = bufferToFloatArray(row.embedding);
    const similarity = cosineSimilarity(queryEmbedding, embedding);

    if (similarity >= threshold) {
      results.push({
        id: row.id,
        content: row.content,
        tags: row.tags ? JSON.parse(row.tags) : [],
        source: row.source,
        quality_score: row.quality_score,
        quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
        access_count: row.access_count ?? 0,
        last_accessed: row.last_accessed,
        valid_from: row.valid_from,
        valid_until: row.valid_until,
        created_at: row.created_at,
        similarity,
      });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, limit);
}

// ============================================================================
// Batch Operations
// ============================================================================

export interface MemoryBatchInput {
  content: string;
  embedding: number[];
  tags: string[];
  type: MemoryType;
  source?: string;
  qualityScore?: QualityScoreData;
  validFrom?: string | Date;
  validUntil?: string | Date;
}

export interface MemoryBatchResult {
  saved: number;
  skipped: number;
  results: Array<{
    index: number;
    isDuplicate: boolean;
    id?: number;
    reason: 'duplicate' | 'saved';
    similarity?: number;
  }>;
}

/**
 * Save multiple memories in a single transaction with batch duplicate checking.
 * Optimized for session processing to avoid N+1 query problem.
 *
 * Performance: ~95% reduction in DB overhead vs individual saveMemory() calls
 * - Before: N*2 queries (N duplicate checks + N inserts)
 * - After: 1 duplicate check + 1 batch insert
 *
 * @param memories - Array of memories to save
 * @param deduplicateThreshold - Similarity threshold for duplicate detection (default 0.92)
 * @returns Batch save results with per-memory status
 */
export function saveMemoriesBatch(
  memories: MemoryBatchInput[],
  deduplicateThreshold: number = 0.92
): MemoryBatchResult {
  const database = getDb();
  const results: MemoryBatchResult['results'] = [];
  let saved = 0;
  let skipped = 0;

  // Early exit if empty
  if (memories.length === 0) {
    return { saved: 0, skipped: 0, results: [] };
  }

  // Batch duplicate check: load all existing memories once
  const existingRows = database.prepare('SELECT id, content, embedding FROM memories').all() as Array<{
    id: number;
    content: string;
    embedding: Buffer;
  }>;

  const existingEmbeddings = existingRows.map(row => ({
    id: row.id,
    content: row.content,
    embedding: bufferToFloatArray(row.embedding),
  }));

  // Check each input memory against existing ones
  const toInsert: Array<{ input: MemoryBatchInput; index: number }> = [];

  for (let i = 0; i < memories.length; i++) {
    const memory = memories[i];
    let isDuplicate = false;
    let duplicateId: number | undefined;
    let maxSimilarity = 0;

    // Check against all existing memories
    for (const existing of existingEmbeddings) {
      const similarity = cosineSimilarity(memory.embedding, existing.embedding);
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
      }

      if (similarity >= deduplicateThreshold) {
        isDuplicate = true;
        duplicateId = existing.id;
        break;
      }
    }

    if (isDuplicate) {
      results.push({
        index: i,
        isDuplicate: true,
        id: duplicateId,
        reason: 'duplicate',
        similarity: maxSimilarity,
      });
      skipped++;
    } else {
      toInsert.push({ input: memory, index: i });
    }
  }

  // Batch insert all non-duplicates in a transaction
  if (toInsert.length > 0) {
    const insertStmt = database.prepare(`
      INSERT INTO memories (content, tags, source, type, quality_score, quality_factors, embedding, valid_from, valid_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Prepare vec_memories statements if available
    let insertVec: any;
    let insertMap: any;
    if (sqliteVecAvailable) {
      insertVec = database.prepare('INSERT INTO vec_memories(embedding) VALUES (?)');
      insertMap = database.prepare('INSERT INTO vec_memories_map(vec_rowid, memory_id) VALUES (?, ?)');
    }

    // Transaction for atomic batch insert
    const batchInsert = database.transaction(() => {
      for (const { input, index } of toInsert) {
        const tagsStr = JSON.stringify(input.tags);
        const qualityScore = input.qualityScore?.score ?? null;
        const qualityFactors = input.qualityScore ? JSON.stringify(input.qualityScore.factors) : null;
        const embeddingBlob = floatArrayToBuffer(input.embedding);

        const validFromStr = input.validFrom
          ? (input.validFrom instanceof Date ? input.validFrom.toISOString() : input.validFrom)
          : null;
        const validUntilStr = input.validUntil
          ? (input.validUntil instanceof Date ? input.validUntil.toISOString() : input.validUntil)
          : null;

        const result = insertStmt.run(
          input.content,
          tagsStr,
          input.source ?? null,
          input.type,
          qualityScore,
          qualityFactors,
          embeddingBlob,
          validFromStr,
          validUntilStr
        );

        const memoryId = Number(result.lastInsertRowid);

        // Insert into vec_memories if available
        if (sqliteVecAvailable && insertVec && insertMap) {
          try {
            const vecResult = insertVec.run(embeddingBlob);
            insertMap.run(vecResult.lastInsertRowid, memoryId);
          } catch {
            // Ignore vec table errors
          }
        }

        results.push({
          index,
          isDuplicate: false,
          id: memoryId,
          reason: 'saved',
        });

        saved++;
      }
    });

    batchInsert();

    // Trigger graph auto-export once for all memories
    triggerAutoExport();
  }

  // Sort results by original index
  results.sort((a, b) => a.index - b.index);

  return { saved, skipped, results };
}
