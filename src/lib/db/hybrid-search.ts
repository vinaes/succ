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

// Re-export classifyQuery for convenience (hybrid-search consumers)
export { classifyQuery } from '../query-classifier.js';
export type { QueryType } from '../query-classifier.js';

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
  last_accessed?: string | null;
  access_count?: number;
  valid_from?: string | null;
  valid_until?: string | null;
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

export interface CodeSearchFilters {
  /** Filter results to only those matching this regex against content */
  regex?: string;
  /** Filter results to only chunks with this symbol_type (function, method, class, interface, type_alias) */
  symbolType?: string;
}

// ============================================================================
// Shared Hybrid Search Pipeline
// ============================================================================

interface HybridPipelineConfig<TRow extends { id: number }> {
  queryEmbedding: number[];
  bm25Results: { docId: number; score: number }[];
  limit: number;
  threshold: number;
  alpha: number;
  rrfK?: number;
  prepare: typeof cachedPrepare;
  logContext: string;
  vecQuery: string;
  filterVecRows: (docIds: number[]) => TRow[];
  loadBruteForceRows: () => (TRow & { embedding: Buffer })[] | null;
  fetchMissingRows: (ids: number[]) => TRow[];
}

interface HybridPipelineResult<TRow> {
  combined: { docId: number; score: number }[];
  rowMap: Map<number, TRow>;
  bm25Map: Map<number, number>;
  vectorMap: Map<number, number>;
}

/**
 * Shared pipeline for BM25 + vector hybrid search with RRF fusion.
 * Returns null when brute-force is skipped (caller handles BM25-only fallback).
 */
function runHybridPipeline<TRow extends { id: number }>(
  config: HybridPipelineConfig<TRow>
): HybridPipelineResult<TRow> | null {
  const {
    queryEmbedding,
    bm25Results,
    limit,
    threshold,
    alpha,
    rrfK,
    prepare,
    logContext,
    vecQuery,
    filterVecRows,
    loadBruteForceRows,
    fetchMissingRows,
  } = config;

  let vectorResults: { docId: number; score: number }[] = [];
  let rowMap = new Map<number, TRow>();

  if (sqliteVecAvailable) {
    try {
      const queryBuffer = floatArrayToBuffer(queryEmbedding);
      const vecResults = prepare(vecQuery).all(queryBuffer, limit * 5) as Array<{
        doc_id: number;
        distance: number;
      }>;

      if (vecResults.length > 0) {
        const rows = filterVecRows(vecResults.map((r) => r.doc_id));
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
      logWarn('hybrid-search', `${logContext} vector search failed, using fallback strategy`, {
        error: error instanceof Error ? error.message : String(error),
      });
      vectorResults = [];
    }
  }

  if (vectorResults.length === 0) {
    const bruteForceRows = loadBruteForceRows();
    if (bruteForceRows === null) return null;
    if (bruteForceRows.length === 0) {
      return { combined: [], rowMap, bm25Map: new Map(), vectorMap: new Map() };
    }

    rowMap = new Map(bruteForceRows.map((r) => [r.id, r]));
    for (const row of bruteForceRows) {
      const embedding = bufferToFloatArray(row.embedding);
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      if (similarity >= threshold) {
        vectorResults.push({ docId: row.id, score: similarity });
      }
    }
    vectorResults.sort((a, b) => b.score - a.score);
  }

  const topVectorResults = vectorResults.slice(0, limit * 3);
  const combined = bm25.reciprocalRankFusion(bm25Results, topVectorResults, alpha, limit, rrfK);

  if (combined.length > 0) {
    const missingIds = combined.filter((c) => !rowMap.has(c.docId)).map((c) => c.docId);
    if (missingIds.length > 0) {
      for (const row of fetchMissingRows(missingIds)) {
        rowMap.set(row.id, row);
      }
    }
  }

  return {
    combined,
    rowMap,
    bm25Map: new Map(bm25Results.map((r) => [r.docId, r.score])),
    vectorMap: new Map(vectorResults.map((r) => [r.docId, r.score])),
  };
}

// ============================================================================
// Hybrid Search Functions
// ============================================================================

const VEC_DOCUMENTS_QUERY = `
  SELECT m.doc_id, v.distance
  FROM vec_documents v
  JOIN vec_documents_map m ON m.vec_rowid = v.rowid
  WHERE v.embedding MATCH ? AND k = ?
  ORDER BY v.distance`;

const VEC_MEMORIES_QUERY = `
  SELECT m.memory_id AS doc_id, v.distance
  FROM vec_memories v
  JOIN vec_memories_map m ON m.vec_rowid = v.rowid
  WHERE v.embedding MATCH ? AND k = ?
  ORDER BY v.distance`;

/**
 * Hybrid search combining BM25 and vector similarity.
 * Uses sqlite-vec for fast KNN vector search when available.
 */
export function hybridSearchCode(
  query: string,
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.25,
  alpha: number = 0.5,
  filters?: CodeSearchFilters,
  rrfK?: number
): HybridSearchResult[] {
  const database = getDb();

  const bm25Index = getCodeBm25Index();
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

  type CodeRow = {
    id: number;
    file_path: string;
    content: string;
    start_line: number;
    end_line: number;
  };

  const pipeline = runHybridPipeline<CodeRow>({
    queryEmbedding,
    bm25Results,
    limit,
    threshold,
    alpha,
    rrfK,
    prepare: cachedPrepare,
    logContext: 'Code',
    vecQuery: VEC_DOCUMENTS_QUERY,
    filterVecRows: (docIds) => {
      const placeholders = docIds.map(() => '?').join(',');
      return database
        .prepare(
          `SELECT id, file_path, content, start_line, end_line
           FROM documents
           WHERE id IN (${placeholders}) AND file_path LIKE 'code:%' AND superseded_at IS NULL`
        )
        .all(...docIds) as CodeRow[];
    },
    loadBruteForceRows: () => {
      const { count } = cachedPrepare(
        "SELECT COUNT(*) as count FROM documents WHERE file_path LIKE 'code:%' AND superseded_at IS NULL"
      ).get() as { count: number };
      if (count > BRUTE_FORCE_MAX_ROWS) return null;
      return cachedPrepare(
        "SELECT id, file_path, content, start_line, end_line, embedding FROM documents WHERE file_path LIKE 'code:%' AND superseded_at IS NULL LIMIT ?"
      ).all(BRUTE_FORCE_MAX_ROWS) as (CodeRow & { embedding: Buffer })[];
    },
    fetchMissingRows: (ids) => {
      const placeholders = ids.map(() => '?').join(',');
      return database
        .prepare(
          `SELECT id, file_path, content, start_line, end_line
           FROM documents WHERE id IN (${placeholders}) AND superseded_at IS NULL`
        )
        .all(...ids) as CodeRow[];
    },
  });

  // BM25-only fallback when too many docs for brute-force
  if (pipeline === null) {
    const bm25Map = new Map(bm25Results.map((r) => [r.docId, r.score]));
    const docIds = bm25Results.slice(0, limit).map((r) => r.docId);
    if (docIds.length === 0) return [];
    const placeholders = docIds.map(() => '?').join(',');
    const rows = database
      .prepare(
        `SELECT id, file_path, content, start_line, end_line
         FROM documents WHERE id IN (${placeholders}) AND superseded_at IS NULL`
      )
      .all(...docIds) as CodeRow[];
    // Preserve BM25 ranking — IN (...) returns rows in nondeterministic order
    const rowById = new Map(rows.map((r) => [r.id, r]));
    return docIds
      .map((id) => {
        const row = rowById.get(id);
        if (!row) return null;
        return {
          file_path: row.file_path,
          content: row.content,
          start_line: row.start_line,
          end_line: row.end_line,
          similarity: bm25Map.get(row.id) ?? 0,
          bm25Score: bm25Map.get(row.id),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }

  const { combined, rowMap, bm25Map, vectorMap } = pipeline;
  if (combined.length === 0) return [];

  // Symbol name match boost
  const resultDocIds = combined.map((c) => c.docId);
  const symbolMap = new Map<number, { symbol_name: string | null; symbol_type: string | null }>();
  if (resultDocIds.length > 0) {
    const placeholders = resultDocIds.map(() => '?').join(',');
    const symbolRows = database
      .prepare(`SELECT id, symbol_name, symbol_type FROM documents WHERE id IN (${placeholders})`)
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

  let regexFilter: RegExp | null = null;
  if (filters?.regex && filters.regex.length <= 500) {
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

    const sym = symbolMap.get(c.docId);
    if (filters?.symbolType && sym?.symbol_type !== filters.symbolType) continue;
    if (regexFilter && !regexFilter.test(row.content)) continue;

    let score = c.score;
    if (sym?.symbol_name) {
      const symLower = sym.symbol_name.toLowerCase();
      for (const token of queryTokens) {
        if (symLower === token) {
          score += 0.15;
          break;
        } else if (symLower.includes(token) || token.includes(symLower)) {
          score += 0.08;
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
  alpha: number = 0.5,
  rrfK?: number
): HybridSearchResult[] {
  const database = getDb();
  const bm25Results = bm25.search(query, getDocsBm25Index(), 'docs', limit * 3);

  type DocRow = {
    id: number;
    file_path: string;
    content: string;
    start_line: number;
    end_line: number;
  };

  const pipeline = runHybridPipeline<DocRow>({
    queryEmbedding,
    bm25Results,
    limit,
    threshold,
    alpha,
    rrfK,
    prepare: cachedPrepare,
    logContext: 'Docs',
    vecQuery: VEC_DOCUMENTS_QUERY,
    filterVecRows: (docIds) => {
      const placeholders = docIds.map(() => '?').join(',');
      return database
        .prepare(
          `SELECT id, file_path, content, start_line, end_line
           FROM documents
           WHERE id IN (${placeholders}) AND file_path NOT LIKE 'code:%' AND superseded_at IS NULL`
        )
        .all(...docIds) as DocRow[];
    },
    loadBruteForceRows: () => {
      const { count } = cachedPrepare(
        "SELECT COUNT(*) as count FROM documents WHERE file_path NOT LIKE 'code:%' AND superseded_at IS NULL"
      ).get() as { count: number };
      if (count > BRUTE_FORCE_MAX_ROWS) return null;
      return cachedPrepare(
        "SELECT id, file_path, content, start_line, end_line, embedding FROM documents WHERE file_path NOT LIKE 'code:%' AND superseded_at IS NULL LIMIT ?"
      ).all(BRUTE_FORCE_MAX_ROWS) as (DocRow & { embedding: Buffer })[];
    },
    fetchMissingRows: (ids) => {
      const placeholders = ids.map(() => '?').join(',');
      return database
        .prepare(
          `SELECT id, file_path, content, start_line, end_line
           FROM documents WHERE id IN (${placeholders}) AND superseded_at IS NULL`
        )
        .all(...ids) as DocRow[];
    },
  });

  // BM25-only fallback when too many docs for brute-force
  if (pipeline === null) {
    const bm25Map = new Map(bm25Results.map((r) => [r.docId, r.score]));
    const docIds = bm25Results.slice(0, limit).map((r) => r.docId);
    if (docIds.length === 0) return [];
    const placeholders = docIds.map(() => '?').join(',');
    const rows = database
      .prepare(
        `SELECT id, file_path, content, start_line, end_line
         FROM documents WHERE id IN (${placeholders}) AND superseded_at IS NULL`
      )
      .all(...docIds) as DocRow[];
    const rowById = new Map(rows.map((r) => [r.id, r]));
    return docIds
      .map((id) => {
        const row = rowById.get(id);
        if (!row) return null;
        return {
          file_path: row.file_path,
          content: row.content,
          start_line: row.start_line,
          end_line: row.end_line,
          similarity: bm25Map.get(row.id) ?? 0,
          bm25Score: bm25Map.get(row.id),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }

  if (pipeline.combined.length === 0) return [];

  const { combined, rowMap, bm25Map, vectorMap } = pipeline;
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
  alpha: number = 0.5,
  rrfK?: number
): HybridMemoryResult[] {
  const database = getDb();

  const bm25Raw = bm25.search(query, getMemoriesBm25Index(), 'docs', limit * 3);
  let bm25Results = bm25Raw;
  if (bm25Raw.length > 0) {
    const bm25Ids = bm25Raw.map((r) => r.docId);
    const placeholders = bm25Ids.map(() => '?').join(',');
    const latestRows = cachedPrepare(
      `SELECT id FROM memories WHERE id IN (${placeholders}) AND COALESCE(is_latest, 1) = 1`
    ).all(...bm25Ids) as Array<{ id: number }>;
    const latestSet = new Set(latestRows.map((r) => r.id));
    bm25Results = bm25Raw.filter((r) => latestSet.has(r.docId));
  }

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

  const pipeline = runHybridPipeline<MemoryRow>({
    queryEmbedding,
    bm25Results,
    limit,
    threshold,
    alpha,
    rrfK,
    prepare: cachedPrepare,
    logContext: 'Memory',
    vecQuery: VEC_MEMORIES_QUERY,
    filterVecRows: (docIds) => {
      const placeholders = docIds.map(() => '?').join(',');
      return database
        .prepare(
          `SELECT id, content, tags, source, type, created_at,
                  last_accessed, access_count, valid_from, valid_until, quality_score
           FROM memories
           WHERE id IN (${placeholders}) AND COALESCE(is_latest, 1) = 1`
        )
        .all(...docIds) as MemoryRow[];
    },
    loadBruteForceRows: () => {
      const { count } = cachedPrepare(
        'SELECT COUNT(*) as count FROM memories WHERE embedding IS NOT NULL AND COALESCE(is_latest, 1) = 1'
      ).get() as { count: number };
      if (count > BRUTE_FORCE_MAX_ROWS) return null;
      return cachedPrepare(
        `SELECT id, content, tags, source, type, created_at, embedding,
                last_accessed, access_count, valid_from, valid_until, quality_score
         FROM memories WHERE embedding IS NOT NULL AND COALESCE(is_latest, 1) = 1 LIMIT ?`
      ).all(BRUTE_FORCE_MAX_ROWS) as (MemoryRow & { embedding: Buffer })[];
    },
    fetchMissingRows: (ids) => {
      const placeholders = ids.map(() => '?').join(',');
      return database
        .prepare(
          `SELECT id, content, tags, source, type, created_at,
                  last_accessed, access_count, valid_from, valid_until, quality_score
           FROM memories
           WHERE id IN (${placeholders}) AND COALESCE(is_latest, 1) = 1`
        )
        .all(...ids) as MemoryRow[];
    },
  });

  // BM25-only fallback when too many memories for brute-force
  if (pipeline === null) {
    const bm25Map = new Map(bm25Results.map((r) => [r.docId, r.score]));
    const docIds = bm25Results.slice(0, limit).map((r) => r.docId);
    if (docIds.length === 0) return [];
    const placeholders = docIds.map(() => '?').join(',');
    const rows = database
      .prepare(
        `SELECT id, content, tags, source, type, created_at,
                last_accessed, access_count, valid_from, valid_until, quality_score
         FROM memories WHERE id IN (${placeholders}) AND COALESCE(is_latest, 1) = 1`
      )
      .all(...docIds) as MemoryRow[];
    const rowById = new Map(rows.map((r) => [r.id, r]));
    return docIds
      .map((id) => {
        const row = rowById.get(id);
        if (!row) return null;
        return {
          id: row.id,
          content: row.content,
          tags: parseTags(row.tags),
          source: row.source,
          type: parseMemoryType(row.type),
          created_at: row.created_at,
          similarity: bm25Map.get(row.id) ?? 0,
          bm25Score: bm25Map.get(row.id),
          last_accessed: row.last_accessed,
          access_count: row.access_count,
          valid_from: row.valid_from,
          valid_until: row.valid_until,
          quality_score: row.quality_score,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }

  if (pipeline.combined.length === 0) return [];

  const { combined, rowMap, bm25Map, vectorMap } = pipeline;
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
 */
export async function graphEnhancedSearchMemories(
  query: string,
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.3,
  alpha: number = 0.5,
  graphWeight: number = 0.3,
  rrfK?: number
): Promise<HybridMemoryResult[]> {
  const baseResults = hybridSearchMemories(
    query,
    queryEmbedding,
    limit * 2,
    threshold,
    alpha,
    rrfK
  );
  if (baseResults.length === 0) return baseResults;

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

  const RRF_K = 60;
  const safeWeight = Number.isFinite(graphWeight) ? Math.max(0, Math.min(1, graphWeight)) : 0;
  const textWeight = 1 - safeWeight;

  const scoreMap = new Map<number, { score: number; result: HybridMemoryResult | null }>();

  for (let rank = 0; rank < baseResults.length; rank++) {
    const r = baseResults[rank];
    scoreMap.set(r.id, { score: textWeight / (RRF_K + rank + 1), result: r });
  }

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
  since?: Date,
  rrfK?: number
): HybridGlobalMemoryResult[] {
  const database = getGlobalDb();

  const bm25Raw = bm25.search(query, getGlobalMemoriesBm25Index(), 'docs', limit * 3);
  let bm25Results = bm25Raw;
  if (bm25Raw.length > 0) {
    const bm25Ids = bm25Raw.map((r) => r.docId);
    const placeholders = bm25Ids.map(() => '?').join(',');
    let filterSql = `SELECT id FROM memories WHERE id IN (${placeholders}) AND COALESCE(is_latest, 1) = 1`;
    const filterParams: (string | number)[] = [...bm25Ids];
    if (since) {
      filterSql += ' AND created_at >= ?';
      filterParams.push(since.toISOString());
    }
    const latestRows = database.prepare(filterSql).all(...filterParams) as Array<{ id: number }>;
    const latestSet = new Set(latestRows.map((r) => r.id));
    bm25Results = bm25Raw.filter((r) => latestSet.has(r.docId));
  }

  type GlobalMemRow = {
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    project: string | null;
    type: string | null;
    created_at: string;
  };

  const pipeline = runHybridPipeline<GlobalMemRow>({
    queryEmbedding,
    bm25Results,
    limit,
    threshold,
    alpha,
    rrfK,
    prepare: cachedPrepareGlobal,
    logContext: 'Global',
    vecQuery: VEC_MEMORIES_QUERY,
    filterVecRows: (docIds) => {
      const placeholders = docIds.map(() => '?').join(',');
      let whereClause = `id IN (${placeholders}) AND COALESCE(is_latest, 1) = 1`;
      const params: (string | number)[] = [...docIds];
      if (since) {
        whereClause += ' AND created_at >= ?';
        params.push(since.toISOString());
      }
      return database
        .prepare(
          `SELECT id, content, tags, source, project, type, created_at
           FROM memories WHERE ${whereClause}`
        )
        .all(...params) as GlobalMemRow[];
    },
    loadBruteForceRows: () => {
      let whereClauses = 'embedding IS NOT NULL AND COALESCE(is_latest, 1) = 1';
      const countParams: (string | number)[] = [];
      if (since) {
        whereClauses += ' AND created_at >= ?';
        countParams.push(since.toISOString());
      }
      const { count } = database
        .prepare(`SELECT COUNT(*) as count FROM memories WHERE ${whereClauses}`)
        .get(...countParams) as { count: number };
      if (count > BRUTE_FORCE_MAX_ROWS) return null;
      let sql = `SELECT id, content, tags, source, project, type, embedding, created_at FROM memories WHERE ${whereClauses}`;
      const params: (string | number)[] = [...countParams];
      sql += ' LIMIT ?';
      params.push(BRUTE_FORCE_MAX_ROWS);
      return database.prepare(sql).all(...params) as (GlobalMemRow & { embedding: Buffer })[];
    },
    fetchMissingRows: (ids) => {
      const placeholders = ids.map(() => '?').join(',');
      let sql = `SELECT id, content, tags, source, project, type, created_at
           FROM memories WHERE id IN (${placeholders}) AND COALESCE(is_latest, 1) = 1`;
      const params: (string | number)[] = [...ids];
      if (since) {
        sql += ' AND created_at >= ?';
        params.push(since.toISOString());
      }
      return database.prepare(sql).all(...params) as GlobalMemRow[];
    },
  });

  // BM25-only fallback when too many global memories for brute-force
  if (pipeline === null) {
    const bm25Map = new Map(bm25Results.map((r) => [r.docId, r.score]));
    const docIds = bm25Results.slice(0, limit).map((r) => r.docId);
    if (docIds.length === 0) return [];
    const placeholders = docIds.map(() => '?').join(',');
    let sql = `SELECT id, content, tags, source, project, type, created_at
         FROM memories WHERE id IN (${placeholders}) AND COALESCE(is_latest, 1) = 1`;
    const params: (string | number)[] = [...docIds];
    if (since) {
      sql += ' AND created_at >= ?';
      params.push(since.toISOString());
    }
    const rows = database.prepare(sql).all(...params) as GlobalMemRow[];
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const results: HybridGlobalMemoryResult[] = [];
    for (const id of docIds) {
      const row = rowById.get(id);
      if (!row) continue;
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
        tags: rowTags,
        source: row.source,
        project: row.project,
        type: parseMemoryType(row.type),
        created_at: row.created_at,
        similarity: bm25Map.get(row.id) ?? 0,
        bm25Score: bm25Map.get(row.id),
        isGlobal: true,
      });
    }
    return results;
  }

  if (pipeline.combined.length === 0) return [];

  const { combined, rowMap, bm25Map, vectorMap } = pipeline;
  const results: HybridGlobalMemoryResult[] = [];
  for (const c of combined) {
    const row = rowMap.get(c.docId);
    if (!row) continue;

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
      tags: rowTags,
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
