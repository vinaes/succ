import { getGlobalDb } from './connection.js';
import { cosineSimilarity } from '../embeddings.js';
import { bufferToFloatArray } from './helpers.js';
import { MemoryType } from './schema.js';
import { SaveMemoryResult } from './memories.js';
import { updateGlobalMemoriesBm25Index } from './bm25-indexes.js';

// ============================================================================
// Global Memory Types
// ============================================================================

export interface GlobalMemory {
  id: number;
  content: string;
  tags: string[];
  source: string | null;
  project: string | null;
  quality_score: number | null;
  quality_factors: Record<string, number> | null;
  created_at: string;
  isGlobal: true;
}

export interface GlobalMemorySearchResult {
  id: number;
  content: string;
  tags: string[];
  source: string | null;
  project: string | null;
  quality_score: number | null;
  quality_factors: Record<string, number> | null;
  created_at: string;
  similarity: number;
  isGlobal: true;
}

// ============================================================================
// Global Memory Functions
// ============================================================================

/**
 * Check if a similar global memory already exists
 */
export function findSimilarGlobalMemory(
  embedding: number[],
  threshold: number = 0.92
): { id: number; content: string; similarity: number } | null {
  const database = getGlobalDb();

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
 * Save a memory to global database with deduplication and type
 */
export function saveGlobalMemory(
  content: string,
  embedding: number[],
  tags: string[] = [],
  source?: string,
  project?: string,
  options: { deduplicate?: boolean; type?: MemoryType } = {}
): SaveMemoryResult {
  const { deduplicate = true, type = 'observation' } = options;

  // Check for duplicates if enabled
  if (deduplicate) {
    const existing = findSimilarGlobalMemory(embedding);
    if (existing) {
      return { id: existing.id, isDuplicate: true, similarity: existing.similarity };
    }
  }

  const database = getGlobalDb();
  const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
  const tagsJson = tags.length > 0 ? JSON.stringify(tags) : null;

  const result = database
    .prepare(`
      INSERT INTO memories (content, tags, source, project, type, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(content, tagsJson, source ?? null, project ?? null, type, embeddingBlob);

  const memoryId = result.lastInsertRowid as number;

  // Update BM25 index
  updateGlobalMemoriesBm25Index(memoryId, content);

  return { id: memoryId, isDuplicate: false };
}

/**
 * Search global memories by semantic similarity
 */
export function searchGlobalMemories(
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.3,
  tags?: string[],
  since?: Date
): GlobalMemorySearchResult[] {
  const database = getGlobalDb();

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
    project: string | null;
    quality_score: number | null;
    quality_factors: string | null;
    embedding: Buffer;
    created_at: string;
  }>;

  const results: GlobalMemorySearchResult[] = [];

  for (const row of rows) {
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
        project: row.project,
        quality_score: row.quality_score,
        quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
        created_at: row.created_at,
        similarity,
        isGlobal: true,
      });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, limit);
}

/**
 * Get recent global memories
 */
export function getRecentGlobalMemories(limit: number = 10): GlobalMemory[] {
  const database = getGlobalDb();
  const rows = database
    .prepare(`
      SELECT id, content, tags, source, project, quality_score, quality_factors, created_at
      FROM memories
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
      id: number;
      content: string;
      tags: string | null;
      source: string | null;
      project: string | null;
      quality_score: number | null;
      quality_factors: string | null;
      created_at: string;
    }>;

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    tags: row.tags ? JSON.parse(row.tags) : [],
    source: row.source,
    project: row.project,
    quality_score: row.quality_score,
    quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
    created_at: row.created_at,
    isGlobal: true as const,
  }));
}

/**
 * Delete global memory by ID
 */
export function deleteGlobalMemory(id: number): boolean {
  const database = getGlobalDb();
  const result = database.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Get global memory stats
 */
export function getGlobalMemoryStats(): {
  total_memories: number;
  oldest_memory: string | null;
  newest_memory: string | null;
  projects: string[];
} {
  const database = getGlobalDb();

  const total = database.prepare('SELECT COUNT(*) as count FROM memories').get() as {
    count: number;
  };
  const oldest = database
    .prepare('SELECT MIN(created_at) as oldest FROM memories')
    .get() as { oldest: string | null };
  const newest = database
    .prepare('SELECT MAX(created_at) as newest FROM memories')
    .get() as { newest: string | null };
  const projects = database
    .prepare('SELECT DISTINCT project FROM memories WHERE project IS NOT NULL')
    .all() as Array<{ project: string }>;

  return {
    total_memories: total.count,
    oldest_memory: oldest.oldest,
    newest_memory: newest.newest,
    projects: projects.map((p) => p.project),
  };
}
