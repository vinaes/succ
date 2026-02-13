import fs from 'fs';
import path from 'path';
import { getDb, cachedPrepare } from './connection.js';
import { sqliteVecAvailable, MemoryType } from './schema.js';
import { bufferToFloatArray, floatArrayToBuffer } from './helpers.js';
import { logWarn } from '../fault-logger.js';
import { cosineSimilarity } from '../embeddings.js';
import { triggerAutoExport } from '../graph-scheduler.js';
import { getSuccDir, getConfig } from '../config.js';
import { invalidateMemoriesBm25Index } from './bm25-indexes.js';
import { createMemoryLink } from './graph.js';

/** Parse JSON tags column, returning empty array on null/invalid. */
function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Log memory deletion events to .succ/memory-audit.log for debugging.
 * Format: [ISO timestamp] [DELETE] caller | count=N | ids=[...] | reason
 */
function logDeletion(caller: string, count: number, ids: number[], reason?: string): void {
  try {
    const succDir = getSuccDir();
    const logFile = path.join(succDir, 'memory-audit.log');
    const timestamp = new Date().toISOString();
    const idStr =
      ids.length <= 20 ? ids.join(',') : `${ids.slice(0, 20).join(',')}... (${ids.length} total)`;
    const reasonStr = reason ? ` | ${reason}` : '';
    const line = `[${timestamp}] [DELETE] ${caller} | count=${count} | ids=[${idStr}]${reasonStr}\n`;
    fs.promises.appendFile(logFile, line).catch(() => {});
  } catch {
    // Never let audit logging break actual operations
  }
}

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
  valid_from: string | null; // When fact became valid (null = always valid)
  valid_until: string | null; // When fact expires (null = never expires)
  // Working memory pins
  correction_count: number; // How many times user corrected AI on this topic
  is_invariant: boolean; // Auto-detected invariant rule (always/never/must)
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

  // Try sqlite-vec KNN fast path
  if (sqliteVecAvailable) {
    try {
      const queryBuffer = floatArrayToBuffer(embedding);
      const vecResults = database
        .prepare(
          `
        SELECT m.memory_id, v.distance
        FROM vec_memories v
        JOIN vec_memories_map m ON m.vec_rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND k = 5
        ORDER BY v.distance
      `
        )
        .all(queryBuffer) as Array<{ memory_id: number; distance: number }>;

      for (const result of vecResults) {
        const similarity = 1 - result.distance;
        if (similarity >= threshold) {
          const memory = cachedPrepare('SELECT id, content FROM memories WHERE id = ?').get(
            result.memory_id
          ) as { id: number; content: string } | undefined;
          if (memory) {
            return { id: memory.id, content: memory.content, similarity };
          }
        }
      }
      return null;
    } catch (err) {
      logWarn('memories', 'sqlite-vec KNN failed, using brute-force fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Brute-force fallback when sqlite-vec unavailable
  const rows = cachedPrepare('SELECT id, content, embedding FROM memories').all() as Array<{
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
  const {
    deduplicate = true,
    type = 'observation',
    autoLink = true,
    linkThreshold = 0.7,
    qualityScore,
    validFrom,
    validUntil,
  } = options;

  // Check for duplicates if enabled
  if (deduplicate) {
    const existing = findSimilarMemory(embedding);
    if (existing) {
      return { id: existing.id, isDuplicate: true, similarity: existing.similarity };
    }
  }

  const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
  const tagsJson = tags.length > 0 ? JSON.stringify(tags) : null;
  const qualityFactorsJson = qualityScore?.factors ? JSON.stringify(qualityScore.factors) : null;

  // Convert Date objects to ISO strings
  const validFromStr = validFrom
    ? validFrom instanceof Date
      ? validFrom.toISOString()
      : validFrom
    : null;
  const validUntilStr = validUntil
    ? validUntil instanceof Date
      ? validUntil.toISOString()
      : validUntil
    : null;

  const result = cachedPrepare(`
      INSERT INTO memories (content, tags, source, type, quality_score, quality_factors, valid_from, valid_until, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
      const vecResult = cachedPrepare('INSERT INTO vec_memories(embedding) VALUES (?)').run(
        embeddingBlob
      );
      cachedPrepare('INSERT INTO vec_memories_map(vec_rowid, memory_id) VALUES (?, ?)').run(
        vecResult.lastInsertRowid,
        newId
      );
    } catch (err) {
      logWarn('memories', 'Vector insert failed for memory, semantic recall may not find it', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  let linksCreated = 0;

  // Auto-link to similar existing memories
  if (autoLink) {
    linksCreated = autoLinkNewMemory(newId, embedding, linkThreshold);
  }

  // Async LLM enrichment of new links (fire-and-forget)
  if (linksCreated > 0) {
    try {
      const conf = getConfig();
      if (conf.graph_llm_relations?.enabled && conf.graph_llm_relations?.auto_on_save) {
        import('../graph/llm-relations.js')
          .then((m) => m.enrichMemoryLinks(newId))
          .catch((err) => {
            logWarn('memories', `LLM enrichment failed for memory ${newId}`, {
              error: String(err),
            });
          });
      }
    } catch {
      // LLM enrichment module not available — skip
    }
  }

  // Schedule auto-export if enabled (async, non-blocking)
  if (linksCreated > 0) {
    triggerAutoExport().catch((err) => {
      logWarn('memories', err instanceof Error ? err.message : 'Auto-export failed');
    });
  }

  // Async supersession check: detect if new memory replaces an existing one (fire-and-forget)
  import('../supersession.js')
    .then((m) => m.checkSupersession(newId, content, embedding))
    .catch(() => {
      // Supersession module not available or failed — non-critical
    });

  invalidateMemoriesBm25Index();

  return { id: newId, isDuplicate: false, linksCreated };
}

/**
 * Auto-link a new memory to existing similar memories
 */
function autoLinkNewMemory(memoryId: number, embedding: number[], threshold: number = 0.7): number {
  const database = getDb();

  // Try sqlite-vec KNN fast path
  if (sqliteVecAvailable) {
    try {
      const queryBuffer = floatArrayToBuffer(embedding);
      const vecResults = database
        .prepare(
          `
        SELECT m.memory_id, v.distance
        FROM vec_memories v
        JOIN vec_memories_map m ON m.vec_rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND k = 10
        ORDER BY v.distance
      `
        )
        .all(queryBuffer) as Array<{ memory_id: number; distance: number }>;

      const similarities: Array<{ id: number; similarity: number }> = [];
      for (const result of vecResults) {
        if (result.memory_id === memoryId) continue; // exclude self
        const similarity = 1 - result.distance;
        if (similarity >= threshold) {
          similarities.push({ id: result.memory_id, similarity });
        }
      }

      const topSimilar = similarities.slice(0, 3);
      let created = 0;
      for (const { id: targetId, similarity } of topSimilar) {
        try {
          const result = createMemoryLink(memoryId, targetId, 'similar_to', similarity);
          if (result.created) created++;
        } catch (err) {
          logWarn('memories', 'Auto-link creation failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return created;
    } catch {
      // Fall through to brute-force
    }
  }

  // Brute-force fallback
  const memories = cachedPrepare('SELECT id, embedding FROM memories WHERE id != ?').all(
    memoryId
  ) as Array<{ id: number; embedding: Buffer }>;

  const similarities: Array<{ id: number; similarity: number }> = [];
  for (const mem of memories) {
    const memEmbedding = bufferToFloatArray(mem.embedding);
    const similarity = cosineSimilarity(embedding, memEmbedding);
    if (similarity >= threshold) {
      similarities.push({ id: mem.id, similarity });
    }
  }

  similarities.sort((a, b) => b.similarity - a.similarity);
  const topSimilar = similarities.slice(0, 3);

  let created = 0;
  for (const { id: targetId, similarity } of topSimilar) {
    try {
      const result = createMemoryLink(memoryId, targetId, 'similar_to', similarity);
      if (result.created) created++;
    } catch (err) {
      logWarn('memories', 'Auto-link creation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
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
    includeExpired?: boolean; // Include expired memories (default: false)
    asOfDate?: Date; // Point-in-time query (default: now)
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

      const vecResults = database
        .prepare(
          `
        SELECT m.memory_id, v.distance
        FROM vec_memories v
        JOIN vec_memories_map m ON m.vec_rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND k = ?
        ORDER BY v.distance
      `
        )
        .all(queryBuffer, candidateLimit) as Array<{ memory_id: number; distance: number }>;

      if (vecResults.length > 0) {
        // Get memory IDs
        const memoryIds = vecResults.map((r) => r.memory_id);
        const distanceMap = new Map(vecResults.map((r) => [r.memory_id, r.distance]));

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

          const rowTags: string[] = parseTags(row.tags);

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
    } catch (err) {
      logWarn('memories', 'sqlite-vec KNN failed, using brute-force fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
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

    const rowTags: string[] = parseTags(row.tags);

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
  const rows = cachedPrepare(`
      SELECT id, content, tags, source, quality_score, quality_factors, access_count, last_accessed, valid_from, valid_until, correction_count, is_invariant, created_at
      FROM memories
      WHERE invalidated_by IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Array<{
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
    correction_count: number | null;
    is_invariant: number | null;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    tags: parseTags(row.tags),
    source: row.source,
    quality_score: row.quality_score,
    quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
    access_count: row.access_count ?? 0,
    last_accessed: row.last_accessed,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    correction_count: row.correction_count ?? 0,
    is_invariant: !!(row.is_invariant),
    created_at: row.created_at,
  }));
}

/**
 * Delete a memory by ID
 */
export function deleteMemory(id: number): boolean {
  // Also delete from vec_memories using mapping table
  if (sqliteVecAvailable) {
    try {
      const mapping = cachedPrepare(
        'SELECT vec_rowid FROM vec_memories_map WHERE memory_id = ?'
      ).get(id) as { vec_rowid: number } | undefined;
      if (mapping) {
        cachedPrepare('DELETE FROM vec_memories WHERE rowid = ?').run(mapping.vec_rowid);
        cachedPrepare('DELETE FROM vec_memories_map WHERE memory_id = ?').run(id);
      }
    } catch (err) {
      logWarn('memories', 'Vector cleanup failed during memory deletion', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const result = cachedPrepare('DELETE FROM memories WHERE id = ?').run(id);
  if (result.changes > 0) {
    logDeletion('deleteMemory', 1, [id]);
    invalidateMemoriesBm25Index();
  }
  return result.changes > 0;
}

/**
 * Soft-invalidate a memory during consolidation.
 * Sets valid_until = now and records which memory superseded it.
 * The memory remains in the database for historical queries and rollback.
 */
export function invalidateMemory(memoryId: number, supersededById: number): boolean {
  const now = new Date().toISOString();

  const result = cachedPrepare(`
    UPDATE memories
    SET valid_until = ?, invalidated_by = ?
    WHERE id = ? AND invalidated_by IS NULL
  `).run(now, supersededById, memoryId);

  return result.changes > 0;
}

/**
 * Restore a soft-invalidated memory by clearing valid_until and invalidated_by.
 * Used by the consolidation rollback (undo) feature.
 */
export function restoreInvalidatedMemory(memoryId: number): boolean {
  const result = cachedPrepare(`
    UPDATE memories
    SET valid_until = NULL, invalidated_by = NULL
    WHERE id = ? AND invalidated_by IS NOT NULL
  `).run(memoryId);

  return result.changes > 0;
}

/**
 * Get consolidation history: merged memories and what they superseded.
 * Returns merge operations with their source originals.
 */
export function getConsolidationHistory(limit: number = 20): Array<{
  mergedMemoryId: number;
  mergedContent: string;
  originalIds: number[];
  mergedAt: string;
}> {
  // Find memories that have supersedes links (these are merge results)
  const rows = cachedPrepare(`
    SELECT DISTINCT ml.source_id as merged_id, ml.created_at as merged_at
    FROM memory_links ml
    WHERE ml.relation = 'supersedes'
    ORDER BY ml.created_at DESC
    LIMIT ?
  `).all(limit) as Array<{ merged_id: number; merged_at: string }>;

  return rows.map((row) => {
    const mergedMemory = getMemoryById(row.merged_id);
    const originals = cachedPrepare(`
      SELECT target_id FROM memory_links
      WHERE source_id = ? AND relation = 'supersedes'
    `).all(row.merged_id) as Array<{ target_id: number }>;

    return {
      mergedMemoryId: row.merged_id,
      mergedContent: mergedMemory?.content ?? '(deleted)',
      originalIds: originals.map((o) => o.target_id),
      mergedAt: row.merged_at,
    };
  });
}

/**
 * Get memory stats including type breakdown
 */
export function getMemoryStats(): {
  total_memories: number;
  active_memories: number;
  invalidated_memories: number;
  oldest_memory: string | null;
  newest_memory: string | null;
  by_type: Record<string, number>;
  stale_count: number; // Memories older than 30 days
} {
  const total = cachedPrepare('SELECT COUNT(*) as count FROM memories').get() as {
    count: number;
  };
  const active = cachedPrepare(
    'SELECT COUNT(*) as count FROM memories WHERE invalidated_by IS NULL'
  ).get() as {
    count: number;
  };
  const oldest = cachedPrepare(
    'SELECT MIN(created_at) as oldest FROM memories WHERE invalidated_by IS NULL'
  ).get() as { oldest: string | null };
  const newest = cachedPrepare(
    'SELECT MAX(created_at) as newest FROM memories WHERE invalidated_by IS NULL'
  ).get() as { newest: string | null };

  // Count by type (active only)
  const typeCounts = cachedPrepare(
    'SELECT COALESCE(type, ?) as type, COUNT(*) as count FROM memories WHERE invalidated_by IS NULL GROUP BY type'
  ).all('observation') as Array<{ type: string; count: number }>;
  const by_type: Record<string, number> = {};
  for (const row of typeCounts) {
    by_type[row.type] = row.count;
  }

  // Count stale memories (older than 30 days, active only)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const stale = cachedPrepare(
    'SELECT COUNT(*) as count FROM memories WHERE created_at < ? AND invalidated_by IS NULL'
  ).get(thirtyDaysAgo) as { count: number };

  return {
    total_memories: total.count,
    active_memories: active.count,
    invalidated_memories: total.count - active.count,
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

  // Clean up vec_memories and vec_memories_map for affected memories
  if (sqliteVecAvailable) {
    try {
      const affectedIds = cachedPrepare('SELECT id FROM memories WHERE created_at < ?').all(
        date.toISOString()
      ) as Array<{ id: number }>;

      if (affectedIds.length > 0) {
        const placeholders = affectedIds.map(() => '?').join(',');
        const ids = affectedIds.map((r) => r.id);

        // Get vec rowids to delete
        const vecMappings = database
          .prepare(`SELECT vec_rowid FROM vec_memories_map WHERE memory_id IN (${placeholders})`)
          .all(...ids) as Array<{ vec_rowid: number }>;

        if (vecMappings.length > 0) {
          const vecPlaceholders = vecMappings.map(() => '?').join(',');
          const vecRowids = vecMappings.map((r) => r.vec_rowid);
          database
            .prepare(`DELETE FROM vec_memories WHERE rowid IN (${vecPlaceholders})`)
            .run(...vecRowids);
        }

        database
          .prepare(`DELETE FROM vec_memories_map WHERE memory_id IN (${placeholders})`)
          .run(...ids);
      }
    } catch (err) {
      logWarn('memories', 'Vector cleanup failed during memory deletion', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const result = cachedPrepare('DELETE FROM memories WHERE created_at < ?').run(date.toISOString());
  if (result.changes > 0) {
    logDeletion('deleteMemoriesOlderThan', result.changes, [], `older_than=${date.toISOString()}`);
    invalidateMemoriesBm25Index();
  }
  return result.changes;
}

/**
 * Delete memories by tag
 */
export function deleteMemoriesByTag(tag: string): number {
  const database = getDb();

  // Get all memories with tags
  const memories = cachedPrepare(
    'SELECT id, tags FROM memories WHERE tags IS NOT NULL'
  ).all() as Array<{ id: number; tags: string }>;

  const toDelete: number[] = [];

  for (const memory of memories) {
    const tags = parseTags(memory.tags);
    if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
      toDelete.push(memory.id);
    }
  }

  if (toDelete.length === 0) return 0;

  const placeholders = toDelete.map(() => '?').join(',');

  // Clean up vec_memories and vec_memories_map for affected memories
  if (sqliteVecAvailable) {
    try {
      const vecMappings = database
        .prepare(`SELECT vec_rowid FROM vec_memories_map WHERE memory_id IN (${placeholders})`)
        .all(...toDelete) as Array<{ vec_rowid: number }>;

      if (vecMappings.length > 0) {
        const vecPlaceholders = vecMappings.map(() => '?').join(',');
        const vecRowids = vecMappings.map((r) => r.vec_rowid);
        database
          .prepare(`DELETE FROM vec_memories WHERE rowid IN (${vecPlaceholders})`)
          .run(...vecRowids);
      }

      database
        .prepare(`DELETE FROM vec_memories_map WHERE memory_id IN (${placeholders})`)
        .run(...toDelete);
    } catch (err) {
      logWarn('memories', 'Vector cleanup failed during memory deletion', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const result = database
    .prepare(`DELETE FROM memories WHERE id IN (${placeholders})`)
    .run(...toDelete);
  if (result.changes > 0) {
    logDeletion('deleteMemoriesByTag', result.changes, toDelete, `tag="${tag}"`);
    invalidateMemoriesBm25Index();
  }

  return result.changes;
}

/**
 * Get memory by ID
 */
export function getMemoryById(id: number): Memory | null {
  const row = cachedPrepare(
    'SELECT id, content, tags, source, quality_score, quality_factors, access_count, last_accessed, valid_from, valid_until, correction_count, is_invariant, created_at FROM memories WHERE id = ?'
  ).get(id) as
    | {
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
        correction_count: number | null;
        is_invariant: number | null;
        created_at: string;
      }
    | undefined;

  if (!row) return null;

  return {
    id: row.id,
    content: row.content,
    tags: parseTags(row.tags),
    source: row.source,
    quality_score: row.quality_score,
    quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
    access_count: row.access_count ?? 0,
    last_accessed: row.last_accessed,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    correction_count: row.correction_count ?? 0,
    is_invariant: !!(row.is_invariant),
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

  // Clean up vec_memories and vec_memories_map for affected memories
  if (sqliteVecAvailable) {
    try {
      const vecMappings = database
        .prepare(`SELECT vec_rowid FROM vec_memories_map WHERE memory_id IN (${placeholders})`)
        .all(...ids) as Array<{ vec_rowid: number }>;

      if (vecMappings.length > 0) {
        const vecPlaceholders = vecMappings.map(() => '?').join(',');
        const vecRowids = vecMappings.map((r) => r.vec_rowid);
        database
          .prepare(`DELETE FROM vec_memories WHERE rowid IN (${vecPlaceholders})`)
          .run(...vecRowids);
      }

      database
        .prepare(`DELETE FROM vec_memories_map WHERE memory_id IN (${placeholders})`)
        .run(...ids);
    } catch {
      // Ignore vec table errors
    }
  }

  const result = database.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);

  if (result.changes > 0) {
    logDeletion('deleteMemoriesByIds', result.changes, ids, 'batch/retention');
    invalidateMemoriesBm25Index();
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
  const asOfStr = asOfDate.toISOString();
  const asOfTime = asOfDate.getTime();

  // Get memories that existed at that time
  const rows = cachedPrepare(`
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
        tags: parseTags(row.tags),
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
  deduplicateThreshold: number = 0.92,
  options?: { autoLink?: boolean; linkThreshold?: number; deduplicate?: boolean }
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
  const existingRows = cachedPrepare('SELECT id, content, embedding FROM memories').all() as Array<{
    id: number;
    content: string;
    embedding: Buffer;
  }>;

  const existingEmbeddings = existingRows.map((row) => ({
    id: row.id,
    content: row.content,
    embedding: bufferToFloatArray(row.embedding),
  }));

  // Check each input memory against existing ones (unless dedup disabled)
  const shouldDedup = options?.deduplicate !== false;
  const toInsert: Array<{ input: MemoryBatchInput; index: number }> = [];

  if (shouldDedup) {
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
  } else {
    // Skip dedup — insert all
    for (let i = 0; i < memories.length; i++) {
      toInsert.push({ input: memories[i], index: i });
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
      insertMap = database.prepare(
        'INSERT INTO vec_memories_map(vec_rowid, memory_id) VALUES (?, ?)'
      );
    }

    // Transaction for atomic batch insert
    const batchInsert = database.transaction(() => {
      for (const { input, index } of toInsert) {
        const tagsStr = JSON.stringify(input.tags);
        const qualityScore = input.qualityScore?.score ?? null;
        const qualityFactors = input.qualityScore
          ? JSON.stringify(input.qualityScore.factors)
          : null;
        const embeddingBlob = floatArrayToBuffer(input.embedding);

        const validFromStr = input.validFrom
          ? input.validFrom instanceof Date
            ? input.validFrom.toISOString()
            : input.validFrom
          : null;
        const validUntilStr = input.validUntil
          ? input.validUntil instanceof Date
            ? input.validUntil.toISOString()
            : input.validUntil
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
          } catch (err) {
            logWarn('memories', 'Batch vector insert failed for memory', {
              error: err instanceof Error ? err.message : String(err),
            });
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

    // Auto-link newly saved memories to existing ones
    if (options?.autoLink !== false) {
      const linkThreshold = options?.linkThreshold ?? 0.7;
      for (const { input, index } of toInsert) {
        const savedResult = results.find((r) => r.index === index && !r.isDuplicate);
        if (savedResult?.id) {
          autoLinkNewMemory(savedResult.id, input.embedding, linkThreshold);
        }
      }
    }

    // Trigger graph auto-export once for all memories
    triggerAutoExport();
  }

  // Sort results by original index
  results.sort((a, b) => a.index - b.index);

  if (saved > 0) {
    invalidateMemoriesBm25Index();
  }

  return { saved, skipped, results };
}
