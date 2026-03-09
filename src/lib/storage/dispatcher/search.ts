import { StorageDispatcherBase } from './base.js';
import { logWarn } from '../../fault-logger.js';
import { tokenizeCode, tokenizeCodeWithAST, tokenizeDocs } from '../../bm25.js';
import type {
  GlobalMemorySearchResult,
  HybridGlobalMemoryResult,
  HybridMemoryResult,
  HybridSearchResult,
  MemorySearchResult,
} from '../types.js';

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
    // Overfetch only when regex post-filter is needed (symbolType is filtered natively by Qdrant/PG)
    const hasRegex = !!filters?.regex;
    const fetchLimit = hasRegex ? lim * 3 : lim;
    const regexFilter = hasRegex ? { regex: filters!.regex } : undefined;
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
          return this.applyCodeFilters(qdrantResults, regexFilter, lim);
        }
      } catch (error) {
        this._warnQdrantFailure('hybridSearchCode failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres) {
      const results = await this.postgres.hybridSearchDocuments(
        query,
        queryEmbedding,
        fetchLimit,
        thresh,
        {
          codeOnly: true,
          symbolType: filters?.symbolType,
        }
      );
      return this.applyCodeFilters(results, regexFilter, lim);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.hybridSearchCode(query, queryEmbedding, limit, threshold, alpha, filters);
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
    if (this.hasQdrant()) {
      try {
        const results = await this.qdrant!.hybridSearchDocuments(
          query,
          queryEmbedding,
          lim,
          thresh,
          { docsOnly: true }
        );
        if (results.length > 0) {
          this._resetQdrantFailures();
          return results;
        }
      } catch (error) {
        this._warnQdrantFailure('hybridSearchDocs failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.hybridSearchDocuments(query, queryEmbedding, lim, thresh, {
        docsOnly: true,
      });
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.hybridSearchDocs(query, queryEmbedding, limit, threshold, alpha);
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
    if (this.hasQdrant()) {
      try {
        const results = await this.qdrant!.hybridSearchMemories(
          query,
          queryEmbedding,
          lim,
          thresh,
          { projectId: this.qdrant!.getProjectId() }
        );
        if (results.length > 0) {
          this._resetQdrantFailures();
          return results;
        }
      } catch (error) {
        this._warnQdrantFailure('hybridSearchMemories failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.hybridSearchMemories(query, queryEmbedding, lim, thresh);
    const sqlite = await this.getSqliteFns();
    return sqlite.hybridSearchMemories(query, queryEmbedding, limit, threshold, alpha);
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
    const thresh = threshold ?? 0.3;
    if (this.hasQdrant()) {
      try {
        const results = await this.qdrant!.hybridSearchGlobalMemories(
          query,
          queryEmbedding,
          lim,
          thresh,
          { tags, since }
        );
        if (results.length > 0) {
          this._resetQdrantFailures();
          return results;
        }
      } catch (error) {
        this._warnQdrantFailure('hybridSearchGlobalMemories failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.hybridSearchGlobalMemories(
        query,
        queryEmbedding,
        lim,
        thresh,
        tags,
        since
      );
    const sqlite = await this.getSqliteFns();
    return sqlite.hybridSearchGlobalMemories(
      query,
      queryEmbedding,
      limit,
      threshold,
      alpha,
      tags,
      since
    );
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
      try {
        regexFilter = new RegExp(filters.regex, 'i');
      } catch (error) {
        logWarn('storage', 'Invalid regex filter passed to hybridSearchCode; skipping regex', {
          regex: filters.regex,
          error: error instanceof Error ? error.message : String(error),
        });
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
