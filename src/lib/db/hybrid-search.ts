import { getDb, getGlobalDb, cachedPrepare, cachedPrepareGlobal } from './connection.js';
import { cosineSimilarity } from '../embeddings.js';
import * as bm25 from '../bm25.js';
import { bufferToFloatArray, floatArrayToBuffer } from './helpers.js';
import { MemoryType, sqliteVecAvailable } from './schema.js';
import { getTokenFrequency, getTotalTokenCount } from './token-frequency.js';
import { SearchResult } from './types.js';
import { logWarn } from '../fault-logger.js';
import { getErrorMessage } from '../errors.js';
import {
  getCodeBm25Index,
  getDocsBm25Index,
  getMemoriesBm25Index,
  getGlobalMemoriesBm25Index,
} from './bm25-indexes.js';
import { parseTags, parseMemoryType } from './parse-helpers.js';
import { getMemoriesByIds } from './memories.js';

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
  tags: string[];
  source: string | null;
  type: MemoryType | null;
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
  type: MemoryType | null;
  source_context?: string | null;
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
  let rowMap: Map<
    number,
    { id: number; file_path: string; content: string; start_line: number; end_line: number }
  > = new Map();

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
        const docIds = vecResults.map((r) => r.doc_id);
        const placeholders = docIds.map(() => '?').join(',');
        const rows = database
          .prepare(
            `
          SELECT id, file_path, content, start_line, end_line
          FROM documents
          WHERE id IN (${placeholders}) AND file_path LIKE 'code:%' AND superseded_at IS NULL
        `
          )
          .all(...docIds) as Array<{
          id: number;
          file_path: string;
          content: string;
          start_line: number;
          end_line: number;
        }>;

        rowMap = new Map(rows.map((r) => [r.id, r]));
        const distanceMap = new Map(vecResults.map((r) => [r.doc_id, r.distance]));

        for (const row of rows) {
          const distance = distanceMap.get(row.id) ?? 1;
          const similarity = 1 - distance;
          if (similarity >= threshold) {
            vectorResults.push({ docId: row.id, score: similarity });
          }
        }
        vectorResults.sort((a, b) => b.score - a.score);
      }
    } catch (error) {
      logWarn('hybrid-search', 'Code vector search failed, using fallback strategy', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Fall through to brute-force
      vectorResults = [];
    }
  }

  // Brute-force fallback for vector search (sqlite-vec unavailable or returned 0)
  if (vectorResults.length === 0) {
    const { count } = cachedPrepare(
      "SELECT COUNT(*) as count FROM documents WHERE file_path LIKE 'code:%' AND superseded_at IS NULL"
    ).get() as { count: number };

    if (count > BRUTE_FORCE_MAX_ROWS) {
      // Too many docs for brute-force — return BM25-only results
      const bm25Map = new Map(bm25Results.map((r) => [r.docId, r.score]));
      const docIds = bm25Results.slice(0, limit).map((r) => r.docId);
      if (docIds.length === 0) return [];
      const placeholders = docIds.map(() => '?').join(',');
      const fallbackRows = database
        .prepare(
          `
        SELECT id, file_path, content, start_line, end_line
        FROM documents WHERE id IN (${placeholders}) AND superseded_at IS NULL
      `
        )
        .all(...docIds) as Array<{
        id: number;
        file_path: string;
        content: string;
        start_line: number;
        end_line: number;
      }>;
      return fallbackRows.map((row) => ({
        file_path: row.file_path,
        content: row.content,
        start_line: row.start_line,
        end_line: row.end_line,
        similarity: bm25Map.get(row.id) ?? 0,
        bm25Score: bm25Map.get(row.id),
      }));
    }

    const rows = cachedPrepare(
      "SELECT id, file_path, content, start_line, end_line, embedding FROM documents WHERE file_path LIKE 'code:%' AND superseded_at IS NULL LIMIT ?"
    ).all(BRUTE_FORCE_MAX_ROWS) as Array<{
      id: number;
      file_path: string;
      content: string;
      start_line: number;
      end_line: number;
      embedding: Buffer;
    }>;

    if (rows.length === 0) return [];

    rowMap = new Map(rows.map((r) => [r.id, r]));

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
    const missingIds = combined.filter((c) => !rowMap.has(c.docId)).map((c) => c.docId);
    if (missingIds.length > 0) {
      const placeholders = missingIds.map(() => '?').join(',');
      const missingRows = getDb()
        .prepare(
          `
        SELECT id, file_path, content, start_line, end_line
        FROM documents WHERE id IN (${placeholders}) AND superseded_at IS NULL
      `
        )
        .all(...missingIds) as Array<{
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
  const resultDocIds = combined.map((c) => c.docId);
  const symbolMap = new Map<number, { symbol_name: string | null; symbol_type: string | null }>();
  if (resultDocIds.length > 0) {
    const placeholders = resultDocIds.map(() => '?').join(',');
    const symbolRows = database
      .prepare(
        `
      SELECT id, symbol_name, symbol_type FROM documents WHERE id IN (${placeholders})
    `
      )
      .all(...resultDocIds) as Array<{
      id: number;
      symbol_name: string | null;
      symbol_type: string | null;
    }>;
    for (const row of symbolRows) {
      symbolMap.set(row.id, { symbol_name: row.symbol_name, symbol_type: row.symbol_type });
    }
  }

  const queryTokens = query
    .toLowerCase()
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);

  // Pre-compile regex filter if provided (limit length and reject ReDoS-prone patterns)
  let regexFilter: RegExp | null = null;
  if (filters?.regex && filters.regex.length <= 500) {
    // Reject patterns with nested quantifiers that cause catastrophic backtracking
    const hasNestedQuantifiers = /(\+|\*|\{)\s*\)(\+|\*|\?)|\(\?[^)]*(\+|\*)\)(\+|\*|\?)/.test(
      filters.regex
    );
    if (hasNestedQuantifiers) {
      logWarn(
        'hybrid-search',
        'Regex filter rejected: nested quantifiers may cause catastrophic backtracking'
      );
    } else {
      try {
        regexFilter = new RegExp(filters.regex, 'i');
      } catch (error) {
        logWarn('hybrid-search', 'Invalid regex filter, skipping regex constraint', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
  let rowMap: Map<
    number,
    { id: number; file_path: string; content: string; start_line: number; end_line: number }
  > = new Map();

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
        const docIds = vecResults.map((r) => r.doc_id);
        const placeholders = docIds.map(() => '?').join(',');
        const rows = database
          .prepare(
            `
          SELECT id, file_path, content, start_line, end_line
          FROM documents
          WHERE id IN (${placeholders}) AND file_path NOT LIKE 'code:%' AND superseded_at IS NULL
        `
          )
          .all(...docIds) as Array<{
          id: number;
          file_path: string;
          content: string;
          start_line: number;
          end_line: number;
        }>;

        rowMap = new Map(rows.map((r) => [r.id, r]));
        const distanceMap = new Map(vecResults.map((r) => [r.doc_id, r.distance]));
        for (const row of rows) {
          const distance = distanceMap.get(row.id) ?? 1;
          const similarity = 1 - distance;
          if (similarity >= threshold) {
            vectorResults.push({ docId: row.id, score: similarity });
          }
        }
        vectorResults.sort((a, b) => b.score - a.score);
      }
    } catch (error) {
      logWarn('hybrid-search', 'Docs vector search failed, using fallback strategy', {
        error: error instanceof Error ? error.message : String(error),
      });
      vectorResults = [];
    }
  }

  // Brute-force fallback with safety limit
  if (vectorResults.length === 0) {
    const rows = cachedPrepare(
      "SELECT id, file_path, content, start_line, end_line, embedding FROM documents WHERE file_path NOT LIKE 'code:%' AND superseded_at IS NULL LIMIT ?"
    ).all(BRUTE_FORCE_MAX_ROWS) as Array<{
      id: number;
      file_path: string;
      content: string;
      start_line: number;
      end_line: number;
      embedding: Buffer;
    }>;

    if (rows.length === 0) return [];
    rowMap = new Map(rows.map((r) => [r.id, r]));

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
    const missingIds = combined.filter((c) => !rowMap.has(c.docId)).map((c) => c.docId);
    if (missingIds.length > 0) {
      const placeholders = missingIds.map(() => '?').join(',');
      const missingRows = database
        .prepare(
          `
        SELECT id, file_path, content, start_line, end_line
        FROM documents WHERE id IN (${placeholders}) AND superseded_at IS NULL
      `
        )
        .all(...missingIds) as Array<{
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
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    type: string | null;
    created_at: string;
    last_accessed: string | null;
    access_count: number;
    valid_from: string | null;
    valid_until: string | null;
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
        const docIds = vecResults.map((r) => r.doc_id);
        const placeholders = docIds.map(() => '?').join(',');
        const rows = database
          .prepare(
            `
          SELECT id, content, tags, source, type, created_at,
                 last_accessed, access_count, valid_from, valid_until, quality_score
          FROM memories WHERE id IN (${placeholders})
        `
          )
          .all(...docIds) as MemoryRow[];

        rowMap = new Map(rows.map((r) => [r.id, r]));
        const distanceMap = new Map(vecResults.map((r) => [r.doc_id, r.distance]));
        for (const row of rows) {
          const distance = distanceMap.get(row.id) ?? 1;
          const similarity = 1 - distance;
          if (similarity >= threshold) {
            vectorResults.push({ docId: row.id, score: similarity });
          }
        }
        vectorResults.sort((a, b) => b.score - a.score);
      }
    } catch (error) {
      logWarn('hybrid-search', 'Memory vector search failed, using fallback strategy', {
        error: error instanceof Error ? error.message : String(error),
      });
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
    rowMap = new Map(rows.map((r) => [r.id, r]));

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
    const missingIds = combined.filter((c) => !rowMap.has(c.docId)).map((c) => c.docId);
    if (missingIds.length > 0) {
      const placeholders = missingIds.map(() => '?').join(',');
      const missingRows = database
        .prepare(
          `
        SELECT id, content, tags, source, type, created_at,
               last_accessed, access_count, valid_from, valid_until, quality_score
        FROM memories WHERE id IN (${placeholders})
      `
        )
        .all(...missingIds) as MemoryRow[];
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
      tags: parseTags(row.tags),
      source: row.source,
      type: parseMemoryType(row.type),
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
 * Graph-enhanced memory search: BM25 + vector + PPR as third RRF signal.
 * Runs standard hybrid search first, then uses top results as PPR seed nodes
 * to discover graph-connected memories. Merges all three via weighted RRF.
 *
 * @param query - Search query
 * @param queryEmbedding - Query embedding vector
 * @param limit - Max results
 * @param threshold - Minimum similarity
 * @param alpha - BM25/vector balance
 * @param graphWeight - PPR signal weight in RRF (0-1, default 0.3)
 */
export async function graphEnhancedSearchMemories(
  query: string,
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.3,
  alpha: number = 0.5,
  graphWeight: number = 0.3
): Promise<HybridMemoryResult[]> {
  // Step 1: Standard BM25 + vector search
  const baseResults = hybridSearchMemories(query, queryEmbedding, limit * 2, threshold, alpha);

  if (baseResults.length === 0) return baseResults;

  // Step 2: Run PPR from top results as seed nodes
  let pprScores: Map<number, number>;
  try {
    const { personalizedPageRank } = await import('../graph/graphology-bridge.js');
    const seedIds = baseResults.slice(0, Math.min(10, baseResults.length)).map((r) => r.id);
    const pprResults = await personalizedPageRank(seedIds, limit * 3);
    pprScores = new Map(
      pprResults.map((r: { memoryId: number; score: number }) => [r.memoryId, r.score])
    );
  } catch (err) {
    logWarn('hybrid-search', 'PPR graph signal failed, returning base results', {
      error: getErrorMessage(err),
    });
    return baseResults.slice(0, limit);
  }

  if (pprScores.size === 0) return baseResults.slice(0, limit);

  // Step 3: Three-signal RRF merge
  const RRF_K = 60;
  // Clamp graphWeight to [0, 1] and guard against NaN/Infinity
  const safeWeight = Number.isFinite(graphWeight) ? Math.max(0, Math.min(1, graphWeight)) : 0;
  const textWeight = 1 - safeWeight; // BM25+vector share this weight

  const scoreMap = new Map<number, { score: number; result: HybridMemoryResult | null }>();

  // BM25+vector signal (from base results, already RRF-fused)
  for (let rank = 0; rank < baseResults.length; rank++) {
    const r = baseResults[rank];
    const rrfScore = textWeight / (RRF_K + rank + 1);
    scoreMap.set(r.id, { score: rrfScore, result: r });
  }

  // PPR graph signal
  const pprRanked = Array.from(pprScores.entries()).sort((a, b) => b[1] - a[1]);
  for (let rank = 0; rank < pprRanked.length; rank++) {
    const [memId] = pprRanked[rank];
    const rrfScore = safeWeight / (RRF_K + rank + 1);
    const existing = scoreMap.get(memId);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(memId, { score: rrfScore, result: null });
    }
  }

  // Hydrate graph-only hits (PPR discovered memories not in base text results)
  // Batch-fetch all missing IDs in a single query to avoid N+1 sequential lookups
  const missingIds = Array.from(scoreMap.entries())
    .filter(([, entry]) => entry.result === null)
    .map(([id]) => id);

  if (missingIds.length > 0) {
    try {
      const memories = getMemoriesByIds(missingIds);
      for (const memory of memories) {
        const entry = scoreMap.get(memory.id);
        if (!entry) continue;
        entry.result = {
          id: memory.id,
          content: memory.content,
          tags: memory.tags,
          source: memory.source,
          type: memory.type,
          created_at: memory.created_at,
          similarity: entry.score,
          last_accessed: memory.last_accessed,
          access_count: memory.access_count,
          valid_from: memory.valid_from,
          valid_until: memory.valid_until,
          quality_score: memory.quality_score,
        };
      }
    } catch (err) {
      logWarn('hybrid-search', `Failed to batch-hydrate graph-only memories`, {
        error: getErrorMessage(err),
        ids: missingIds.join(','),
      });
    }
  }

  // Sort by combined score, write fused score into similarity, filter out unhydrated entries
  return Array.from(scoreMap.values())
    .filter((e): e is { score: number; result: HybridMemoryResult } => e.result !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => ({ ...e.result, similarity: e.score }));
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
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    project: string | null;
    type: string | null;
    created_at: string;
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
        const docIds = vecResults.map((r) => r.doc_id);
        const placeholders = docIds.map(() => '?').join(',');

        let whereClause = `id IN (${placeholders})`;
        const params: any[] = [...docIds];
        if (since) {
          whereClause += ' AND created_at >= ?';
          params.push(since.toISOString());
        }

        const rows = database
          .prepare(
            `
          SELECT id, content, tags, source, project, type, created_at
          FROM memories WHERE ${whereClause}
        `
          )
          .all(...params) as GlobalMemRow[];

        rowMap = new Map(rows.map((r) => [r.id, r]));
        const distanceMap = new Map(vecResults.map((r) => [r.doc_id, r.distance]));
        for (const row of rows) {
          const distance = distanceMap.get(row.id) ?? 1;
          const similarity = 1 - distance;
          if (similarity >= threshold) {
            vectorResults.push({ docId: row.id, score: similarity });
          }
        }
        vectorResults.sort((a, b) => b.score - a.score);
      }
    } catch (error) {
      logWarn('hybrid-search', 'Global vector search failed, using fallback strategy', {
        error: error instanceof Error ? error.message : String(error),
      });
      vectorResults = [];
    }
  }

  // Brute-force fallback with safety limit
  if (vectorResults.length === 0) {
    let sqlQuery =
      'SELECT id, content, tags, source, project, type, embedding, created_at FROM memories WHERE embedding IS NOT NULL';
    const params: any[] = [];
    if (since) {
      sqlQuery += ' AND created_at >= ?';
      params.push(since.toISOString());
    }
    sqlQuery += ` LIMIT ${BRUTE_FORCE_MAX_ROWS}`;

    const rows = database.prepare(sqlQuery).all(...params) as Array<
      GlobalMemRow & { embedding: Buffer }
    >;

    if (rows.length === 0) return [];
    rowMap = new Map(rows.map((r) => [r.id, r]));

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
    const missingIds = combined.filter((c) => !rowMap.has(c.docId)).map((c) => c.docId);
    if (missingIds.length > 0) {
      const placeholders = missingIds.map(() => '?').join(',');
      const missingRows = database
        .prepare(
          `
        SELECT id, content, tags, source, project, type, created_at
        FROM memories WHERE id IN (${placeholders})
      `
        )
        .all(...missingIds) as GlobalMemRow[];
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
    const rowTags: string[] = parseTags(row.tags);
    if (tags && tags.length > 0) {
      const hasMatchingTag = tags.some((t) =>
        rowTags.some((rt) => rt.toLowerCase().includes(t.toLowerCase()))
      );
      if (!hasMatchingTag) continue;
    }

    results.push({
      id: row.id,
      content: row.content,
      tags: parseTags(row.tags),
      source: row.source,
      project: row.project,
      type: parseMemoryType(row.type),
      created_at: row.created_at,
      similarity: c.score,
      bm25Score: bm25Map.get(c.docId),
      vectorScore: vectorMap.get(c.docId),
      isGlobal: true,
    });
  }

  return results;
}
