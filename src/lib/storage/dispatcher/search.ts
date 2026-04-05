import safeRegex from 'safe-regex2';
import { StorageDispatcherBase } from './base.js';
import { logInfo, logWarn } from '../../fault-logger.js';
import { getEmbedding } from '../../embeddings.js';
import { tokenizeCode, tokenizeCodeWithAST, tokenizeDocs } from '../../bm25.js';
import { rerank, type Rerankable } from '../../reranker.js';
import { getErrorMessage } from '../../errors.js';
import type {
  GlobalMemorySearchResult,
  HybridGlobalMemoryResult,
  HybridMemoryResult,
  HybridSearchResult,
  MemorySearchResult,
} from '../types.js';

/** Hard cap on overfetch multiplier to prevent unbounded DB/Qdrant reads */
const RERANK_FETCH_CAP = 200;

export class SearchDispatcherMixin extends StorageDispatcherBase {
  async invalidateCodeBm25Index(): Promise<void> {
    if (this.backend === 'postgresql') return; // tsvector maintained on insert
    const s = await this.getSqliteFns();
    s.invalidateCodeBm25Index();
  }

  async invalidateDocsBm25Index(): Promise<void> {
    if (this.backend === 'postgresql') return; // tsvector maintained on insert
    const s = await this.getSqliteFns();
    s.invalidateDocsBm25Index();
  }

  async invalidateMemoriesBm25Index(): Promise<void> {
    if (this.backend === 'postgresql') return; // tsvector maintained on insert
    const s = await this.getSqliteFns();
    s.invalidateMemoriesBm25Index();
  }

  async invalidateGlobalMemoriesBm25Index(): Promise<void> {
    if (this.backend === 'postgresql') return; // tsvector maintained on insert
    const s = await this.getSqliteFns();
    s.invalidateGlobalMemoriesBm25Index();
  }

  async invalidateBM25Index(): Promise<void> {
    if (this.backend === 'postgresql') return; // tsvector maintained on insert
    const s = await this.getSqliteFns();
    s.invalidateBM25Index();
  }

  async updateCodeBm25Index(
    docId: number,
    content: string,
    symbolName?: string,
    signature?: string
  ): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      const sigTokens = signature ? tokenizeCode(signature) : [];
      const tokens = tokenizeCodeWithAST(content, sigTokens, symbolName).join(' ');
      await this.postgres.updateDocumentSearchVector(docId, tokens);
      return;
    }
    const s = await this.getSqliteFns();
    s.updateCodeBm25Index(docId, content, symbolName, signature);
  }

  async updateMemoriesBm25Index(memoryId: number, content: string): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      const tokens = tokenizeDocs(content).join(' ');
      await this.postgres.updateMemorySearchVector(memoryId, tokens);
      return;
    }
    const s = await this.getSqliteFns();
    s.updateMemoriesBm25Index(memoryId, content);
  }

  async updateGlobalMemoriesBm25Index(memoryId: number, content: string): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      const tokens = tokenizeDocs(content).join(' ');
      await this.postgres.updateMemorySearchVector(memoryId, tokens);
      return;
    }
    const s = await this.getSqliteFns();
    s.updateGlobalMemoriesBm25Index(memoryId, content);
  }

  // ===========================================================================
  // Hybrid Search — Approach C (BM25 + dense + RRF in single Qdrant call)
  // ===========================================================================

  async hybridSearchCode(
    query: string,
    queryEmbedding: number[],
    limit?: number,
    threshold?: number,
    alpha?: number,
    filters?: { regex?: string; symbolType?: string }
  ): Promise<HybridSearchResult[]> {
    this._sessionCounters.codeSearchQueries++;
    const lim = limit ?? 10;
    const thresh = threshold ?? 0.3;
    // Overfetch for reranking (need more candidates to rerank from)
    const hasRegex = !!filters?.regex;
    const rerankerOverfetch = 3; // Fetch 3x candidates for reranking quality
    const fetchLimit = Math.min(
      hasRegex ? lim * rerankerOverfetch * 2 : lim * rerankerOverfetch,
      RERANK_FETCH_CAP
    );
    const regexFilter = hasRegex ? { regex: filters!.regex } : undefined;
    let results: HybridSearchResult[];
    if (this.hasQdrant()) {
      try {
        const qdrantResults = await this.qdrant!.hybridSearchDocuments(
          query,
          queryEmbedding,
          fetchLimit,
          thresh,
          { codeOnly: true, symbolType: filters?.symbolType }
        );
        if (qdrantResults.length > 0) {
          this._resetQdrantFailures();
          results = this.applyCodeFilters(qdrantResults, regexFilter, fetchLimit);
          return rerank(query, results, lim);
        }
      } catch (error) {
        this._warnQdrantFailure('hybridSearchCode failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres) {
      results = await this.postgres.hybridSearchDocuments(
        query,
        queryEmbedding,
        fetchLimit,
        thresh,
        {
          codeOnly: true,
          symbolType: filters?.symbolType,
        }
      );
      results = this.applyCodeFilters(results, regexFilter, fetchLimit);
      return rerank(query, results, lim);
    }
    const sqlite = await this.getSqliteFns();
    results = await sqlite.hybridSearchCode(
      query,
      queryEmbedding,
      fetchLimit,
      thresh,
      alpha,
      filters
    );
    return rerank(query, results, lim);
  }

  async hybridSearchDocs(
    query: string,
    queryEmbedding: number[],
    limit?: number,
    threshold?: number,
    alpha?: number
  ): Promise<HybridSearchResult[]> {
    this._sessionCounters.searchQueries++;
    const lim = limit ?? 10;
    const thresh = threshold ?? 0.3;
    const fetchLimit = Math.min(lim * 3, RERANK_FETCH_CAP); // Overfetch for reranking
    let results: HybridSearchResult[];
    if (this.hasQdrant()) {
      try {
        results = await this.qdrant!.hybridSearchDocuments(
          query,
          queryEmbedding,
          fetchLimit,
          thresh,
          { docsOnly: true }
        );
        if (results.length > 0) {
          this._resetQdrantFailures();
          return rerank(query, results, lim);
        }
      } catch (error) {
        this._warnQdrantFailure('hybridSearchDocs failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres) {
      results = await this.postgres.hybridSearchDocuments(
        query,
        queryEmbedding,
        fetchLimit,
        thresh,
        {
          docsOnly: true,
        }
      );
      return rerank(query, results, lim);
    }
    const sqlite = await this.getSqliteFns();
    results = await sqlite.hybridSearchDocs(query, queryEmbedding, fetchLimit, thresh, alpha);
    return rerank(query, results, lim);
  }

  async hybridSearchMemories(
    query: string,
    queryEmbedding: number[],
    limit?: number,
    threshold?: number,
    alpha?: number
  ): Promise<Array<MemorySearchResult | HybridMemoryResult>> {
    this._sessionCounters.recallQueries++;
    const lim = limit ?? 10;
    const thresh = threshold ?? 0.3;
    const fetchLimit = Math.min(lim * 3, RERANK_FETCH_CAP); // Overfetch for reranking
    let results: Array<MemorySearchResult | HybridMemoryResult>;
    if (this.hasQdrant()) {
      try {
        results = await this.qdrant!.hybridSearchMemories(
          query,
          queryEmbedding,
          fetchLimit,
          thresh,
          { projectId: this.qdrant!.getProjectId() }
        );
        if (results.length > 0) {
          this._resetQdrantFailures();
          return rerank(query, results as (MemorySearchResult & Rerankable)[], lim);
        }
      } catch (error) {
        this._warnQdrantFailure('hybridSearchMemories failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres) {
      results = await this.postgres.hybridSearchMemories(query, queryEmbedding, fetchLimit, thresh);
      return rerank(query, results as (MemorySearchResult & Rerankable)[], lim);
    }
    const sqlite = await this.getSqliteFns();
    results = await sqlite.hybridSearchMemories(query, queryEmbedding, fetchLimit, thresh, alpha);
    return rerank(query, results as (MemorySearchResult & Rerankable)[], lim);
  }

  /**
   * Run hybridSearchMemories for each sub-query, then merge via Reciprocal Rank Fusion.
   * Routes through the storage dispatcher so all backends (SQLite, PostgreSQL, Qdrant) are supported.
   */
  async decomposedSearchMemories(
    subQueries: string[],
    originalQuery: string,
    queryEmbedding: number[],
    limit: number = 5,
    threshold: number = 0.3,
    alpha: number = 0.5
  ): Promise<Array<MemorySearchResult | HybridMemoryResult>> {
    if (subQueries.length === 0) {
      return this.hybridSearchMemories(originalQuery, queryEmbedding, limit, threshold, alpha);
    }

    try {
      // Get embeddings for all sub-queries in parallel
      const subEmbeddings = await Promise.all(subQueries.map((sq) => getEmbedding(sq)));

      // Run search for each sub-query through the dispatcher (backend-agnostic)
      const subResults = await Promise.all(
        subQueries.map((sq, i) =>
          this.hybridSearchMemories(sq, subEmbeddings[i], limit, threshold, alpha)
        )
      );

      // Merge via RRF: each sub-query's results contribute rank-based scores
      const RRF_K = 60;
      const scoreMap = new Map<
        number,
        { score: number; result: MemorySearchResult | HybridMemoryResult }
      >();

      for (const results of subResults) {
        for (let rank = 0; rank < results.length; rank++) {
          const r = results[rank];
          const id = r.id;
          const rrfScore = 1 / (RRF_K + rank + 1);
          const existing = scoreMap.get(id);
          if (existing) {
            existing.score += rrfScore;
            if (r.similarity > existing.result.similarity) {
              existing.result = r;
            }
          } else {
            scoreMap.set(id, { score: rrfScore, result: r });
          }
        }
      }

      // Also include original query results as an RRF signal
      const originalResults = await this.hybridSearchMemories(
        originalQuery,
        queryEmbedding,
        limit,
        threshold,
        alpha
      );
      for (let rank = 0; rank < originalResults.length; rank++) {
        const r = originalResults[rank];
        const id = r.id;
        const rrfScore = 1 / (RRF_K + rank + 1);
        const existing = scoreMap.get(id);
        if (existing) {
          existing.score += rrfScore;
          if (r.similarity > existing.result.similarity) {
            existing.result = r;
          }
        } else {
          scoreMap.set(id, { score: rrfScore, result: r });
        }
      }

      // Sort by combined RRF score; keep original similarity for downstream merge with global results
      const merged = Array.from(scoreMap.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((entry) => entry.result);

      logInfo(
        'storage-search',
        `Decomposed search: ${subQueries.length} sub-queries → ${merged.length} merged results`
      );

      return merged;
    } catch (error) {
      logWarn('storage-search', 'Decomposed search failed, falling back to single query', {
        error: getErrorMessage(error),
      });
      return this.hybridSearchMemories(originalQuery, queryEmbedding, limit, threshold, alpha);
    }
  }

  async hybridSearchGlobalMemories(
    query: string,
    queryEmbedding: number[],
    limit?: number,
    threshold?: number,
    alpha?: number,
    tags?: string[],
    since?: Date
  ): Promise<Array<GlobalMemorySearchResult | MemorySearchResult | HybridGlobalMemoryResult>> {
    const lim = limit ?? 10;
    const fetchLimit = Math.min(lim * 3, RERANK_FETCH_CAP); // Overfetch for reranking
    const thresh = threshold ?? 0.3;
    if (this.hasQdrant()) {
      try {
        const results = await this.qdrant!.hybridSearchGlobalMemories(
          query,
          queryEmbedding,
          fetchLimit,
          thresh,
          { tags, since }
        );
        if (results.length > 0) {
          this._resetQdrantFailures();
          const mapped: HybridGlobalMemoryResult[] = results.map((r) => ({
            ...r,
            project: null,
          }));
          return rerank(query, mapped as (HybridGlobalMemoryResult & Rerankable)[], lim);
        }
      } catch (error) {
        this._warnQdrantFailure('hybridSearchGlobalMemories failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres) {
      const results = await this.postgres.hybridSearchGlobalMemories(
        query,
        queryEmbedding,
        fetchLimit,
        thresh,
        tags,
        since
      );
      return rerank(query, results as (GlobalMemorySearchResult & Rerankable)[], lim);
    }
    const sqlite = await this.getSqliteFns();
    const results = await sqlite.hybridSearchGlobalMemories(
      query,
      queryEmbedding,
      fetchLimit,
      thresh,
      alpha,
      tags,
      since
    );
    return rerank(query, results as (GlobalMemorySearchResult & Rerankable)[], lim);
  }

  /** Post-filter code search results by regex and/or symbolType, then trim to limit. */

  protected applyCodeFilters(
    results: HybridSearchResult[],
    filters: { regex?: string; symbolType?: string } | undefined,
    limit: number
  ): HybridSearchResult[] {
    if (!filters) return results.slice(0, limit);

    let regexFilter: RegExp | null = null;
    if (filters.regex && filters.regex.length <= 500) {
      // Validate against ReDoS using safe-regex2 (AST-based star-height analysis)
      if (!safeRegex(filters.regex)) {
        logWarn('storage', 'Regex filter rejected: ReDoS vulnerability detected', {
          regex: filters.regex,
        });
      } else {
        try {
          regexFilter = new RegExp(filters.regex, 'i');
        } catch (error) {
          logWarn('storage', 'Invalid regex filter passed to hybridSearchCode; skipping regex', {
            regex: filters.regex,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const filtered: HybridSearchResult[] = [];
    for (const r of results) {
      if (filters.symbolType && r.symbol_type !== filters.symbolType) continue;
      if (regexFilter && !regexFilter.test(r.content)) continue;
      filtered.push(r);
      if (filtered.length >= limit) break;
    }
    return filtered;
  }

  /**
   * Rebuild all tsvector search_vectors on PostgreSQL.
   * No-op on SQLite (BM25 indexes are rebuilt lazily on next search).
   * Use after tokenizer logic changes or manual DB edits.
   */
  async rebuildSearchVectors(): Promise<{ documents: number; memories: number } | null> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.rebuildAllSearchVectors();
    }
    return null;
  }

  // ===========================================================================
  // Global Memory Operations
  // ===========================================================================
}
