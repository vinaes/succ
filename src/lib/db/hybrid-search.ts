import { getDb, getGlobalDb, cachedPrepare, cachedPrepareGlobal } from './connection.js';
import { cosineSimilarity } from '../embeddings.js';
import * as bm25 from '../bm25.js';
import { bufferToFloatArray, floatArrayToBuffer } from './helpers.js';
import { sqliteVecAvailable } from './schema.js';
import { getTokenFrequency, getTotalTokenCount } from './token-frequency.js';
import { SearchResult } from './types.js';
import {
  getCodeBm25Index,
  getDocsBm25Index,
  getMemoriesBm25Index,
  getGlobalMemoriesBm25Index,
} from './bm25-indexes.js';

// Safety limit for brute-force vector search when sqlite-vec is unavailable.
// Beyond this, fall back to BM25-only to prevent OOM.
const BRUTE_FORCE_MAX_ROWS = 10000;

// ============================================================================
// Hybrid Search Types
// ============================================================================

export interface HybridSearchResult extends SearchResult {
  bm25Score?: number;
  vectorScore?: number;
}

export interface HybridMemoryResult {
  id: number;
  content: string;
  tags: string | null;
  source: string | null;
  type: string | null;
  created_at: string;
  similarity: number;
  bm25Score?: number;
  vectorScore?: number;
  // Temporal fields
  last_accessed?: string | null;
  access_count?: number;
  valid_from?: string | null;
  valid_until?: string | null;
  // Quality
  quality_score?: number | null;
}

export interface HybridGlobalMemoryResult {
  id: number;
  content: string;
  tags: string[];
  source: string | null;
  project: string | null;
  created_at: string;
  similarity: number;
  bm25Score?: number;
  vectorScore?: number;
  isGlobal: true;
}

// ============================================================================
// Hybrid Search Functions
// ============================================================================

export interface CodeSearchFilters {
  /** Filter results to only those matching this regex against content */
  regex?: string;
  /** Filter results to only chunks with this symbol_type (function, method, class, interface, type_alias) */
  symbolType?: string;
}

/**
 * Hybrid search combining BM25 and vector similarity.
 * Uses sqlite-vec for fast KNN vector search when available.
 *
 * @param query - Search query string
 * @param queryEmbedding - Query embedding vector
 * @param limit - Max results
 * @param threshold - Min similarity threshold
 * @param alpha - Weight: 0=pure BM25, 1=pure vector, 0.5=equal (default: 0.5)
 * @param filters - Optional regex/symbol_type filters
 */
export function hybridSearchCode(
  query: string,
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.25,
  alpha: number = 0.5,
  filters?: CodeSearchFilters
): HybridSearchResult[] {
  const database = getDb();

  // 1. BM25 search with Ronin-style segmentation for flatcase queries
  const bm25Index = getCodeBm25Index();

  // Enhance query with segmented tokens if it looks like flatcase
  let enhancedQuery = query;
  const totalTokens = getTotalTokenCount();
  if (totalTokens > 0) {
    const tokens = bm25.tokenizeCodeWithSegmentation(
      query,
      (token) => getTokenFrequency(token),
      totalTokens
    );
    if (tokens.length > query.split(/\s+/).length) {
      enhancedQuery = tokens.join(' ');
    }
  }

  const bm25Results = bm25.search(enhancedQuery, bm25Index, 'code', limit * 3);

  // 2. Vector search - try sqlite-vec first
  let vectorResults: { docId: number; score: number }[] = [];
  let rowMap: Map<number, { id: number; file_path: string; content: string; start_line: number; end_line: number }> = new Map();

  if (sqliteVecAvailable) {
    try {
      const candidateLimit = limit * 5;
      const queryBuffer = floatArrayToBuffer(queryEmbedding);

      const vecResults = cachedPrepare(`
        SELECT m.doc_id, v.distance
        FROM vec_documents v
        JOIN vec_documents_map m ON m.vec_rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND k = ?
        ORDER BY v.distance
      `).all(queryBuffer, candidateLimit) as Array<{ doc_id: number; distance: number }>;

      if (vecResults.length > 0) {
        // Filter to only code documents
        const docIds = vecResults.map(r => r.doc_id);
        const placeholders = docIds.map(() => '?').join(',');
        const rows = database.prepare(`
          SELECT id, file_path, content, start_line, end_line
          FROM documents
          WHERE id IN (${placeholders}) AND file_path LIKE 'code:%'
        `).all(...docIds) as Array<{
          id: number;
          file_path: string;
          content: string;
          start_line: number;
          end_line: number;
        }>;

        rowMap = new Map(rows.map(r => [r.id, r]));
        const distanceMap = new Map(vecResults.map(r => [r.doc_id, r.distance]));

        for (const row of rows) {
          const distance = distanceMap.get(row.id) ?? 1;
          const similarity = 1 - distance;
          if (similarity >= threshold) {
            vectorResults.push({ docId: row.id, score: similarity });
          }
        }
        vectorResults.sort((a, b) => b.score - a.score);
      }
    } catch {
      // Fall through to brute-force
      vectorResults = [];
    }
  }

  // Brute-force fallback for vector search (sqlite-vec unavailable or returned 0)
  if (vectorResults.length === 0) {
    const { count } = cachedPrepare("SELECT COUNT(*) as count FROM documents WHERE file_path LIKE 'code:%'").get() as { count: number };

    if (count > BRUTE_FORCE_MAX_ROWS) {
      // Too many docs for brute-force — return BM25-only results
      const bm25Map = new Map(bm25Results.map((r) => [r.docId, r.score]));
      const docIds = bm25Results.slice(0, limit).map(r => r.docId);
      if (docIds.length === 0) return [];
      const placeholders = docIds.map(() => '?').join(',');
      const fallbackRows = database.prepare(`
        SELECT id, file_path, content, start_line, end_line
        FROM documents WHERE id IN (${placeholders})
      `).all(...docIds) as Array<{ id: number; file_path: string; content: string; start_line: number; end_line: number }>;
      return fallbackRows.map(row => ({
        file_path: row.file_path,
        content: row.content,
        start_line: row.start_line,
        end_line: row.end_line,
        similarity: bm25Map.get(row.id) ?? 0,
        bm25Score: bm25Map.get(row.id),
      }));
    }

    const rows = cachedPrepare("SELECT id, file_path, content, start_line, end_line, embedding FROM documents WHERE file_path LIKE 'code:%' LIMIT ?").all(BRUTE_FORCE_MAX_ROWS) as Array<{
      id: number;
      file_path: string;
      content: string;
      start_line: number;
      end_line: number;
      embedding: Buffer;
    }>;

    if (rows.length === 0) return [];

    rowMap = new Map(rows.map(r => [r.id, r]));

    for (const row of rows) {
      const embedding = bufferToFloatArray(row.embedding);
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      if (similarity >= threshold) {
        vectorResults.push({ docId: row.id, score: similarity });
      }
    }
    vectorResults.sort((a, b) => b.score - a.score);
  }

  const topVectorResults = vectorResults.slice(0, limit * 3);

  // 3. Combine using RRF
  const combined = bm25.reciprocalRankFusion(bm25Results, topVectorResults, alpha, limit);

  // 4. Ensure we have all needed rows in the map (for BM25 results that might not be in vec results)
  if (combined.length > 0) {
    const missingIds = combined.filter(c => !rowMap.has(c.docId)).map(c => c.docId);
    if (missingIds.length > 0) {
      const placeholders = missingIds.map(() => '?').join(',');
      const missingRows = getDb().prepare(`
        SELECT id, file_path, content, start_line, end_line
        FROM documents WHERE id IN (${placeholders})
      `).all(...missingIds) as Array<{
        id: number;
        file_path: string;
        content: string;
        start_line: number;
        end_line: number;
      }>;
      for (const row of missingRows) {
        rowMap.set(row.id, row);
      }
    }
  }

  const bm25Map = new Map(bm25Results.map((r) => [r.docId, r.score]));
  const vectorMap = new Map(vectorResults.map((r) => [r.docId, r.score]));

  // 5. Symbol name match boost — fetch AST metadata for result set
  const resultDocIds = combined.map(c => c.docId);
  const symbolMap = new Map<number, { symbol_name: string | null; symbol_type: string | null }>();
  if (resultDocIds.length > 0) {
    const placeholders = resultDocIds.map(() => '?').join(',');
    const symbolRows = database.prepare(`
      SELECT id, symbol_name, symbol_type FROM documents WHERE id IN (${placeholders})
    `).all(...resultDocIds) as Array<{ id: number; symbol_name: string | null; symbol_type: string | null }>;
    for (const row of symbolRows) {
      symbolMap.set(row.id, { symbol_name: row.symbol_name, symbol_type: row.symbol_type });
    }
  }

  const queryTokens = query.toLowerCase().trim().split(/[\s,]+/).filter(Boolean);

  // Pre-compile regex filter if provided (limit length to prevent ReDoS)
  let regexFilter: RegExp | null = null;
  if (filters?.regex && filters.regex.length <= 500) {
    try { regexFilter = new RegExp(filters.regex, 'i'); } catch { /* invalid regex — skip */ }
  }

  const results: HybridSearchResult[] = [];
  for (const c of combined) {
    const row = rowMap.get(c.docId);
    if (!row) continue;

    // Apply symbol_type filter
    const sym = symbolMap.get(c.docId);
    if (filters?.symbolType && sym?.symbol_type !== filters.symbolType) continue;

    // Apply regex filter against content
    if (regexFilter && !regexFilter.test(row.content)) continue;

    let score = c.score;

    // Boost results where symbol_name matches query tokens
    if (sym?.symbol_name) {
      const symLower = sym.symbol_name.toLowerCase();
      for (const token of queryTokens) {
        if (symLower === token) {
          score += 0.15; // Exact symbol name match
          break;
        } else if (symLower.includes(token) || token.includes(symLower)) {
          score += 0.08; // Partial symbol name match
          break;
        }
      }
    }

    results.push({
      file_path: row.file_path,
      content: row.content,
      start_line: row.start_line,
      end_line: row.end_line,
      similarity: Math.min(score, 1.0),
      bm25Score: bm25Map.get(c.docId),
      vectorScore: vectorMap.get(c.docId),
      symbol_name: sym?.symbol_name ?? undefined,
      symbol_type: sym?.symbol_type ?? undefined,
    });
  }

  // Re-sort by boosted score
  results.sort((a, b) => b.similarity - a.similarity);
  return results;
}

/**
 * Hybrid search for docs (brain/ markdown files)
 */
export function hybridSearchDocs(
  query: string,
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.2,
  alpha: number = 0.5
): HybridSearchResult[] {
  const database = getDb();

  // 1. BM25 search with docs tokenizer (stemming)
  const bm25Index = getDocsBm25Index();
  const bm25Results = bm25.search(query, bm25Index, 'docs', limit * 3);

  // 2. Vector search — try sqlite-vec first, fall back to brute-force
  let vectorResults: { docId: number; score: number }[] = [];
  let rowMap: Map<number, { id: number; file_path: string; content: string; start_line: number; end_line: number }> = new Map();

  if (sqliteVecAvailable) {
    try {
      const candidateLimit = limit * 5;
      const queryBuffer = floatArrayToBuffer(queryEmbedding);
      const vecResults = cachedPrepare(`
        SELECT m.doc_id, v.distance
        FROM vec_documents v
        JOIN vec_documents_map m ON m.vec_rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND k = ?
        ORDER BY v.distance
      `).all(queryBuffer, candidateLimit) as Array<{ doc_id: number; distance: number }>;

      if (vecResults.length > 0) {
        const docIds = vecResults.map(r => r.doc_id);
        const placeholders = docIds.map(() => '?').join(',');
        const rows = database.prepare(`
          SELECT id, file_path, content, start_line, end_line
          FROM documents
          WHERE id IN (${placeholders}) AND file_path NOT LIKE 'code:%'
        `).all(...docIds) as Array<{ id: number; file_path: string; content: string; start_line: number; end_line: number }>;

        rowMap = new Map(rows.map(r => [r.id, r]));
        const distanceMap = new Map(vecResults.map(r => [r.doc_id, r.distance]));
        for (const row of rows) {
          const distance = distanceMap.get(row.id) ?? 1;
          const similarity = 1 - distance;
          if (similarity >= threshold) {
            vectorResults.push({ docId: row.id, score: similarity });
          }
        }
        vectorResults.sort((a, b) => b.score - a.score);
      }
    } catch {
      vectorResults = [];
    }
  }

  // Brute-force fallback with safety limit
  if (vectorResults.length === 0) {
    const rows = cachedPrepare("SELECT id, file_path, content, start_line, end_line, embedding FROM documents WHERE file_path NOT LIKE 'code:%' LIMIT ?").all(BRUTE_FORCE_MAX_ROWS) as Array<{
      id: number;
      file_path: string;
      content: string;
      start_line: number;
      end_line: number;
      embedding: Buffer;
    }>;

    if (rows.length === 0) return [];
    rowMap = new Map(rows.map(r => [r.id, r]));

    for (const row of rows) {
      const embedding = bufferToFloatArray(row.embedding);
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      if (similarity >= threshold) {
        vectorResults.push({ docId: row.id, score: similarity });
      }
    }
    vectorResults.sort((a, b) => b.score - a.score);
  }
  const topVectorResults = vectorResults.slice(0, limit * 3);

  // 3. Combine using RRF
  const combined = bm25.reciprocalRankFusion(bm25Results, topVectorResults, alpha, limit);

  // 4. Ensure we have all needed rows (BM25 results may not be in vec results)
  if (combined.length > 0) {
    const missingIds = combined.filter(c => !rowMap.has(c.docId)).map(c => c.docId);
    if (missingIds.length > 0) {
      const placeholders = missingIds.map(() => '?').join(',');
      const missingRows = database.prepare(`
        SELECT id, file_path, content, start_line, end_line
        FROM documents WHERE id IN (${placeholders})
      `).all(...missingIds) as Array<{ id: number; file_path: string; content: string; start_line: number; end_line: number }>;
      for (const row of missingRows) {
        rowMap.set(row.id, row);
      }
    }
  }

  const bm25Map = new Map(bm25Results.map((r) => [r.docId, r.score]));
  const vectorMap = new Map(vectorResults.map((r) => [r.docId, r.score]));

  const results: HybridSearchResult[] = [];
  for (const c of combined) {
    const row = rowMap.get(c.docId);
    if (!row) continue;
    results.push({
      file_path: row.file_path,
      content: row.content,
      start_line: row.start_line,
      end_line: row.end_line,
      similarity: c.score,
      bm25Score: bm25Map.get(c.docId),
      vectorScore: vectorMap.get(c.docId),
    });
  }
  return results;
}

/**
 * Hybrid search for memories
 */
export function hybridSearchMemories(
  query: string,
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.3,
  alpha: number = 0.5
): HybridMemoryResult[] {
  const database = getDb();

  // 1. BM25 search
  const bm25Index = getMemoriesBm25Index();
  const bm25Results = bm25.search(query, bm25Index, 'docs', limit * 3);

  // 2. Vector search — try sqlite-vec first
  let vectorResults: { docId: number; score: number }[] = [];
  type MemoryRow = {
    id: number; content: string; tags: string | null; source: string | null;
    type: string | null; created_at: string; last_accessed: string | null;
    access_count: number; valid_from: string | null; valid_until: string | null;
    quality_score: number | null;
  };
  let rowMap: Map<number, MemoryRow> = new Map();

  if (sqliteVecAvailable) {
    try {
      const candidateLimit = limit * 5;
      const queryBuffer = floatArrayToBuffer(queryEmbedding);
      const vecResults = cachedPrepare(`
        SELECT m.memory_id AS doc_id, v.distance
        FROM vec_memories v
        JOIN vec_memories_map m ON m.vec_rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND k = ?
        ORDER BY v.distance
      `).all(queryBuffer, candidateLimit) as Array<{ doc_id: number; distance: number }>;

      if (vecResults.length > 0) {
        const docIds = vecResults.map(r => r.doc_id);
        const placeholders = docIds.map(() => '?').join(',');
        const rows = database.prepare(`
          SELECT id, content, tags, source, type, created_at,
                 last_accessed, access_count, valid_from, valid_until, quality_score
          FROM memories WHERE id IN (${placeholders})
        `).all(...docIds) as MemoryRow[];

        rowMap = new Map(rows.map(r => [r.id, r]));
        const distanceMap = new Map(vecResults.map(r => [r.doc_id, r.distance]));
        for (const row of rows) {
          const distance = distanceMap.get(row.id) ?? 1;
          const similarity = 1 - distance;
          if (similarity >= threshold) {
            vectorResults.push({ docId: row.id, score: similarity });
          }
        }
        vectorResults.sort((a, b) => b.score - a.score);
      }
    } catch {
      vectorResults = [];
    }
  }

  // Brute-force fallback with safety limit
  if (vectorResults.length === 0) {
    const rows = cachedPrepare(`
      SELECT id, content, tags, source, type, created_at, embedding,
             last_accessed, access_count, valid_from, valid_until, quality_score
      FROM memories WHERE embedding IS NOT NULL LIMIT ?
    `).all(BRUTE_FORCE_MAX_ROWS) as Array<MemoryRow & { embedding: Buffer }>;

    if (rows.length === 0) return [];
    rowMap = new Map(rows.map(r => [r.id, r]));

    for (const row of rows) {
      const embedding = bufferToFloatArray(row.embedding);
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      if (similarity >= threshold) {
        vectorResults.push({ docId: row.id, score: similarity });
      }
    }
    vectorResults.sort((a, b) => b.score - a.score);
  }
  const topVectorResults = vectorResults.slice(0, limit * 3);

  // 3. Combine using RRF
  const combined = bm25.reciprocalRankFusion(bm25Results, topVectorResults, alpha, limit);

  // 4. Ensure we have all needed rows
  if (combined.length > 0) {
    const missingIds = combined.filter(c => !rowMap.has(c.docId)).map(c => c.docId);
    if (missingIds.length > 0) {
      const placeholders = missingIds.map(() => '?').join(',');
      const missingRows = database.prepare(`
        SELECT id, content, tags, source, type, created_at,
               last_accessed, access_count, valid_from, valid_until, quality_score
        FROM memories WHERE id IN (${placeholders})
      `).all(...missingIds) as MemoryRow[];
      for (const row of missingRows) {
        rowMap.set(row.id, row);
      }
    }
  }

  const bm25Map = new Map(bm25Results.map((r) => [r.docId, r.score]));
  const vectorMap = new Map(vectorResults.map((r) => [r.docId, r.score]));

  const results: HybridMemoryResult[] = [];
  for (const c of combined) {
    const row = rowMap.get(c.docId);
    if (!row) continue;
    results.push({
      id: row.id,
      content: row.content,
      tags: row.tags,
      source: row.source,
      type: row.type,
      created_at: row.created_at,
      similarity: c.score,
      bm25Score: bm25Map.get(c.docId),
      vectorScore: vectorMap.get(c.docId),
      last_accessed: row.last_accessed,
      access_count: row.access_count,
      valid_from: row.valid_from,
      valid_until: row.valid_until,
      quality_score: row.quality_score,
    });
  }
  return results;
}

/**
 * Hybrid search for global memories (BM25 + vector with RRF fusion)
 */
export function hybridSearchGlobalMemories(
  query: string,
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.3,
  alpha: number = 0.5,
  tags?: string[],
  since?: Date
): HybridGlobalMemoryResult[] {
  const database = getGlobalDb();

  // 1. BM25 search
  const bm25Index = getGlobalMemoriesBm25Index();
  const bm25Results = bm25.search(query, bm25Index, 'docs', limit * 3);

  // 2. Vector search — try sqlite-vec first
  type GlobalMemRow = {
    id: number; content: string; tags: string | null; source: string | null;
    project: string | null; created_at: string;
  };
  let vectorResults: { docId: number; score: number }[] = [];
  let rowMap: Map<number, GlobalMemRow> = new Map();

  if (sqliteVecAvailable) {
    try {
      const candidateLimit = limit * 5;
      const queryBuffer = floatArrayToBuffer(queryEmbedding);
      const vecResults = cachedPrepareGlobal(`
        SELECT m.memory_id AS doc_id, v.distance
        FROM vec_memories v
        JOIN vec_memories_map m ON m.vec_rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND k = ?
        ORDER BY v.distance
      `).all(queryBuffer, candidateLimit) as Array<{ doc_id: number; distance: number }>;

      if (vecResults.length > 0) {
        const docIds = vecResults.map(r => r.doc_id);
        const placeholders = docIds.map(() => '?').join(',');

        let whereClause = `id IN (${placeholders})`;
        const params: any[] = [...docIds];
        if (since) {
          whereClause += ' AND created_at >= ?';
          params.push(since.toISOString());
        }

        const rows = database.prepare(`
          SELECT id, content, tags, source, project, created_at
          FROM memories WHERE ${whereClause}
        `).all(...params) as GlobalMemRow[];

        rowMap = new Map(rows.map(r => [r.id, r]));
        const distanceMap = new Map(vecResults.map(r => [r.doc_id, r.distance]));
        for (const row of rows) {
          const distance = distanceMap.get(row.id) ?? 1;
          const similarity = 1 - distance;
          if (similarity >= threshold) {
            vectorResults.push({ docId: row.id, score: similarity });
          }
        }
        vectorResults.sort((a, b) => b.score - a.score);
      }
    } catch {
      vectorResults = [];
    }
  }

  // Brute-force fallback with safety limit
  if (vectorResults.length === 0) {
    let sqlQuery = 'SELECT id, content, tags, source, project, embedding, created_at FROM memories WHERE embedding IS NOT NULL';
    const params: any[] = [];
    if (since) {
      sqlQuery += ' AND created_at >= ?';
      params.push(since.toISOString());
    }
    sqlQuery += ` LIMIT ${BRUTE_FORCE_MAX_ROWS}`;

    const rows = database.prepare(sqlQuery).all(...params) as Array<GlobalMemRow & { embedding: Buffer }>;

    if (rows.length === 0) return [];
    rowMap = new Map(rows.map(r => [r.id, r]));

    for (const row of rows) {
      const embedding = bufferToFloatArray(row.embedding);
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      if (similarity >= threshold) {
        vectorResults.push({ docId: row.id, score: similarity });
      }
    }
    vectorResults.sort((a, b) => b.score - a.score);
  }
  const topVectorResults = vectorResults.slice(0, limit * 3);

  // 3. Combine using RRF
  const combined = bm25.reciprocalRankFusion(bm25Results, topVectorResults, alpha, limit);

  // 4. Ensure we have all needed rows
  if (combined.length > 0) {
    const missingIds = combined.filter(c => !rowMap.has(c.docId)).map(c => c.docId);
    if (missingIds.length > 0) {
      const placeholders = missingIds.map(() => '?').join(',');
      const missingRows = database.prepare(`
        SELECT id, content, tags, source, project, created_at
        FROM memories WHERE id IN (${placeholders})
      `).all(...missingIds) as GlobalMemRow[];
      for (const row of missingRows) {
        rowMap.set(row.id, row);
      }
    }
  }

  const bm25Map = new Map(bm25Results.map((r) => [r.docId, r.score]));
  const vectorMap = new Map(vectorResults.map((r) => [r.docId, r.score]));

  const results: HybridGlobalMemoryResult[] = [];
  for (const c of combined) {
    const row = rowMap.get(c.docId);
    if (!row) continue;

    // Parse and filter by tags if specified
    const rowTags: string[] = row.tags ? JSON.parse(row.tags) : [];
    if (tags && tags.length > 0) {
      const hasMatchingTag = tags.some((t) =>
        rowTags.some((rt) => rt.toLowerCase().includes(t.toLowerCase()))
      );
      if (!hasMatchingTag) continue;
    }

    results.push({
      id: row.id,
      content: row.content,
      tags: rowTags,
      source: row.source,
      project: row.project,
      created_at: row.created_at,
      similarity: c.score,
      bm25Score: bm25Map.get(c.docId),
      vectorScore: vectorMap.get(c.docId),
      isGlobal: true,
    });
  }

  return results;
}
