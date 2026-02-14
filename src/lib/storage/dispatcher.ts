/**
 * Storage Dispatcher - Routes database operations to the configured backend.
 *
 * This module provides a unified interface that automatically routes database
 * operations to either:
 * - SQLite (default, uses db.ts functions directly)
 * - PostgreSQL (uses backends/postgresql.ts)
 *
 * Additionally supports Qdrant for vector search when configured.
 * When Qdrant is present, ALL search goes through Qdrant hybrid
 * (BM25 + dense + RRF fusion) regardless of SQL backend.
 *
 * 4 supported configurations:
 * - SQLite standalone
 * - SQLite + Qdrant
 * - PostgreSQL standalone
 * - PostgreSQL + Qdrant
 *
 * Usage:
 *   import { getStorageDispatcher } from './storage/dispatcher.js';
 *   const storage = await getStorageDispatcher();
 *   await storage.saveMemory(...);
 */

import { getConfig, getProjectRoot } from '../config.js';
import { logError, logWarn } from '../fault-logger.js';
import type { PostgresBackend } from './backends/postgresql.js';
import type { QdrantVectorStore } from './vector/qdrant.js';
import type {
  MemoryType,
  LinkRelation,
  StorageConfig,
  WebSearchHistoryInput,
  WebSearchHistoryRecord,
  WebSearchHistoryFilter,
  WebSearchHistorySummary,
} from './types.js';
import type { DocumentUpsertMeta } from './vector/qdrant.js';

// Internal SQL query result types
interface SqlLearningDelta {
  id: number;
  timestamp: string;
  source: string;
  memories_before: number;
  memories_after: number;
  new_memories: number;
  types_added: string | null;
  avg_quality: number | null;
  created_at: string;
}

interface SqlMemoryRow {
  id: number;
  content: string;
  tags: string | null;
  source: string | null;
  type: string | null;
  quality_score: number | null;
  quality_factors: string | null;
  access_count: number;
  last_accessed: string | null;
  valid_from: string | null;
  valid_until: string | null;
  invalidated_by: number | null;
  created_at: string;
  embedding?: Buffer | null;
}

// Dispatcher state
let _backend: 'sqlite' | 'postgresql' = 'sqlite';
let _vectorBackend: 'builtin' | 'qdrant' = 'builtin';
let _postgresBackend: PostgresBackend | null = null;
let _qdrantStore: QdrantVectorStore | null = null;
let _initialized = false;

function getDispatcherStorageConfig(): StorageConfig {
  const config = getConfig();
  return {
    backend: config.storage?.backend ?? 'sqlite',
    vector: config.storage?.vector ?? 'builtin',
    sqlite: config.storage?.sqlite,
    postgresql: config.storage?.postgresql,
    qdrant: config.storage?.qdrant,
  };
}

export async function initStorageDispatcher(): Promise<void> {
  if (_initialized) return;

  const config = getDispatcherStorageConfig();
  _backend = config.backend ?? 'sqlite';
  _vectorBackend = config.vector ?? 'builtin';

  const projectId = getProjectRoot().replace(/\\/g, '/').toLowerCase();

  if (_backend === 'postgresql') {
    const { createPostgresBackend } = await import('./backends/postgresql.js');
    _postgresBackend = createPostgresBackend(config);
    _postgresBackend.setProjectId(projectId);
    await _postgresBackend.getDocumentStats();
  }

  if (_vectorBackend === 'qdrant') {
    try {
      const { createQdrantVectorStore } = await import('./vector/qdrant.js');
      _qdrantStore = createQdrantVectorStore(config);
      _qdrantStore.setProjectId(projectId);
      const { getEmbeddingInfo } = await import('../embeddings.js');
      const embDims = getEmbeddingInfo().dimensions ?? 384;
      await _qdrantStore.init(embDims);
    } catch (error) {
      logError(
        'storage',
        `Qdrant init failed, falling back to builtin: ${(error as Error).message}`,
        error as Error
      );
      _qdrantStore = null;
    }
  }

  _initialized = true;
  _dispatcher = null;
}

export function getBackendType(): 'sqlite' | 'postgresql' {
  return _backend;
}
export function getVectorBackendType(): 'builtin' | 'qdrant' {
  return _vectorBackend;
}
export function isPostgresBackend(): boolean {
  return _backend === 'postgresql';
}
export function isQdrantVectors(): boolean {
  return _vectorBackend === 'qdrant';
}
export function getPostgresBackend(): PostgresBackend | null {
  return _postgresBackend;
}
export function getQdrantStore(): QdrantVectorStore | null {
  return _qdrantStore;
}

export async function closeStorageDispatcher(): Promise<void> {
  if (_postgresBackend) {
    await _postgresBackend.close();
    _postgresBackend = null;
  }
  if (_qdrantStore) {
    await _qdrantStore.close();
    _qdrantStore = null;
  }
  _initialized = false;
  _dispatcher = null;
}

// =============================================================================
// Storage Dispatcher
// =============================================================================

export class StorageDispatcher {
  private backend: 'sqlite' | 'postgresql';
  private vectorBackend: 'builtin' | 'qdrant';
  private postgres: PostgresBackend | null;
  private qdrant: QdrantVectorStore | null;
  private _sqliteFns: typeof import('../db/index.js') | null = null;

  // Learning delta auto-tracking counters
  private _sessionCounters = {
    memoriesCreated: 0,
    memoriesDuplicated: 0,
    globalMemoriesCreated: 0,
    recallQueries: 0,
    searchQueries: 0,
    codeSearchQueries: 0,
    webSearchQueries: 0,
    webSearchCostUsd: 0,
    qdrantSyncFailures: 0,
    typesCreated: {} as Record<string, number>,
    startedAt: new Date().toISOString(),
  };

  constructor() {
    this.backend = _backend;
    this.vectorBackend = _vectorBackend;
    this.postgres = _postgresBackend;
    this.qdrant = _qdrantStore;
  }

  /** Log Qdrant failure and increment counter. Qdrant is optional — errors never throw. */
  private _warnQdrantFailure(operation: string, error: unknown): void {
    this._sessionCounters.qdrantSyncFailures++;
    const msg = error instanceof Error ? error.message : String(error);
    logError('storage', `Qdrant ${operation} failed: ${msg}`);
  }

  /** Get current session counters (non-destructive read) */
  getSessionCounters() {
    return { ...this._sessionCounters };
  }

  /** Flush session counters to learning_deltas table and reset */
  async flushSessionCounters(source: string): Promise<void> {
    const c = this._sessionCounters;
    const totalCreated = c.memoriesCreated + c.globalMemoriesCreated;

    if (
      totalCreated === 0 &&
      c.recallQueries === 0 &&
      c.searchQueries === 0 &&
      c.codeSearchQueries === 0 &&
      c.webSearchQueries === 0
    )
      return;

    try {
      const stats = await this.getMemoryStats();
      await this.appendLearningDelta({
        timestamp: new Date().toISOString(),
        source,
        memoriesBefore: (stats.total_memories ?? 0) - totalCreated,
        memoriesAfter: stats.total_memories ?? 0,
        newMemories: totalCreated,
        typesAdded: c.typesCreated,
        avgQualityOfNew: null,
      });
    } catch (error) {
      // Don't let flush errors break shutdown
      logError(
        'storage',
        'Failed to flush session counters',
        error instanceof Error ? error : new Error(String(error))
      );
    }

    this._sessionCounters = {
      memoriesCreated: 0,
      memoriesDuplicated: 0,
      globalMemoriesCreated: 0,
      recallQueries: 0,
      searchQueries: 0,
      codeSearchQueries: 0,
      webSearchQueries: 0,
      webSearchCostUsd: 0,
      qdrantSyncFailures: 0,
      typesCreated: {},
      startedAt: new Date().toISOString(),
    };
  }

  private async getSqliteFns(): Promise<typeof import('../db/index.js')> {
    if (!this._sqliteFns) {
      this._sqliteFns = await import('../db/index.js');
    }
    return this._sqliteFns;
  }

  /** Check if Qdrant is configured and available */
  private hasQdrant(): boolean {
    return this.vectorBackend === 'qdrant' && this.qdrant !== null;
  }

  // ===========================================================================
  // Document Operations
  // ===========================================================================

  async upsertDocument(
    filePath: string,
    chunkIndex: number,
    content: string,
    startLine: number,
    endLine: number,
    embedding: number[],
    symbolName?: string,
    symbolType?: string,
    signature?: string
  ): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      const id = await this.postgres.upsertDocument(
        filePath,
        chunkIndex,
        content,
        startLine,
        endLine,
        embedding,
        symbolName,
        symbolType,
        signature
      );
      if (this.hasQdrant()) {
        try {
          await this.qdrant!.upsertDocumentWithPayload(id, embedding, {
            filePath,
            content,
            startLine,
            endLine,
            projectId: this.qdrant!.getProjectId() ?? '',
            symbolName,
            symbolType,
            signature,
          });
        } catch (error) {
          this._warnQdrantFailure(`Failed to sync document vector ${id}`, error);
        }
      }
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.upsertDocument(
      filePath,
      chunkIndex,
      content,
      startLine,
      endLine,
      embedding,
      symbolName,
      symbolType,
      signature
    );
  }

  async upsertDocumentsBatch(documents: any[]): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      const ids = await this.postgres.upsertDocumentsBatch(documents);
      if (this.hasQdrant() && ids.length > 0) {
        try {
          const items = documents.map((doc, idx) => ({
            id: ids[idx],
            embedding: doc.embedding,
            meta: {
              filePath: doc.filePath,
              content: doc.content,
              startLine: doc.startLine,
              endLine: doc.endLine,
              projectId: this.qdrant!.getProjectId() ?? '',
              symbolName: doc.symbolName,
              symbolType: doc.symbolType,
              signature: doc.signature,
            } as DocumentUpsertMeta,
          }));
          await this.qdrant!.upsertDocumentsBatchWithPayload(items);
        } catch (error) {
          this._warnQdrantFailure(`Failed to sync ${ids.length} document vectors`, error);
        }
      }
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.upsertDocumentsBatch(documents);
  }

  async upsertDocumentsBatchWithHashes(documents: any[]): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      const ids = await this.postgres.upsertDocumentsBatchWithHashes(documents);
      if (this.hasQdrant() && ids.length > 0) {
        try {
          const items = documents.map((doc, idx) => ({
            id: ids[idx],
            embedding: doc.embedding,
            meta: {
              filePath: doc.filePath,
              content: doc.content,
              startLine: doc.startLine,
              endLine: doc.endLine,
              projectId: this.qdrant!.getProjectId() ?? '',
              symbolName: doc.symbolName,
              symbolType: doc.symbolType,
              signature: doc.signature,
            } as DocumentUpsertMeta,
          }));
          await this.qdrant!.upsertDocumentsBatchWithPayload(items);
        } catch (error) {
          this._warnQdrantFailure(`Failed to sync ${ids.length} document vectors`, error);
        }
      }
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.upsertDocumentsBatchWithHashes(documents);
  }

  async deleteDocumentsByPath(filePath: string): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      const deletedIds = await this.postgres.deleteDocumentsByPath(filePath);
      if (this.vectorBackend === 'qdrant' && this.qdrant && deletedIds.length > 0) {
        try {
          await this.qdrant.deleteDocumentVectorsByIds(deletedIds);
        } catch (error) {
          this._warnQdrantFailure('Failed to delete document vectors', error);
        }
      }
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.deleteDocumentsByPath(filePath);
  }

  async searchDocuments(
    queryEmbedding: number[],
    limit: number = 5,
    threshold: number = 0.5
  ): Promise<
    Array<{
      file_path: string;
      content: string;
      start_line: number;
      end_line: number;
      similarity: number;
    }>
  > {
    if (this.hasQdrant()) {
      try {
        // Access Qdrant private methods via property access for backward compatibility
        const qdrantAny = this.qdrant as unknown as {
          getClient(): Promise<any>;
          collectionName(type: string): string;
        };
        const client = await qdrantAny.getClient();
        const name = qdrantAny.collectionName('documents');
        const qResults = await client.query(name, {
          query: queryEmbedding,
          using: 'dense',
          limit,
          score_threshold: threshold,
          params: { hnsw_ef: 128, exact: false },
          with_payload: true,
        });
        const points = qResults.points ?? qResults;
        if (points.length > 0 && points[0].payload?.content) {
          return points.map((p: any) => ({
            file_path: p.payload?.file_path ?? '',
            content: p.payload?.content ?? '',
            start_line: p.payload?.start_line ?? 0,
            end_line: p.payload?.end_line ?? 0,
            similarity: p.score,
          }));
        }
        if (this.backend === 'postgresql' && this.postgres) {
          const results = await this.qdrant!.searchDocuments(queryEmbedding, limit * 3, threshold);
          if (results.length > 0) {
            const pgRows = await this.postgres.getDocumentsByIds(results.map((r) => r.id));
            return pgRows
              .map((row) => {
                const score = results.find((r) => r.id === row.id)?.similarity ?? 0;
                return {
                  file_path: row.file_path,
                  content: row.content,
                  start_line: row.start_line,
                  end_line: row.end_line,
                  similarity: score,
                };
              })
              .sort((a, b) => b.similarity - a.similarity)
              .slice(0, limit);
          }
        }
      } catch (error) {
        this._warnQdrantFailure('searchDocuments failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.searchDocuments(queryEmbedding, limit, threshold);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.searchDocuments(queryEmbedding, limit, threshold);
  }

  async getRecentDocuments(limit: number = 10): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getRecentDocuments(limit);
    const sqlite = await this.getSqliteFns();
    return sqlite.getRecentDocuments(limit);
  }

  async getStats(): Promise<{
    total_documents: number;
    total_files: number;
    last_indexed: string | null;
  }> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getDocumentStats();
    const sqlite = await this.getSqliteFns();
    return sqlite.getStats();
  }

  async clearDocuments(): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.clearDocuments();
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.clearDocuments();
  }

  async clearCodeDocuments(): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.clearCodeDocuments();
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.clearCodeDocuments();
  }

  async getStoredEmbeddingDimension(): Promise<number | null> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getStoredEmbeddingDimension();
    const sqlite = await this.getSqliteFns();
    return sqlite.getStoredEmbeddingDimension();
  }

  // ===========================================================================
  // Memory Operations
  // ===========================================================================

  async saveMemory(
    content: string,
    embedding: number[],
    tags: string[] = [],
    source?: string,
    options?: {
      type?: MemoryType;
      deduplicate?: boolean;
      qualityScore?: number;
      qualityFactors?: Record<string, number>;
      validFrom?: string;
      validUntil?: string;
    }
  ): Promise<{
    id: number;
    created: boolean;
    duplicate?: { id: number; content: string; similarity: number };
  }> {
    const type = options?.type ?? 'observation';
    const deduplicate = options?.deduplicate ?? true;
    const qualityScore = options?.qualityScore;
    const qualityFactors = options?.qualityFactors;
    const validFrom = options?.validFrom;
    const validUntil = options?.validUntil;

    // Auto-correction: detect similar (but not duplicate) memories in 0.82-0.92 range
    if (deduplicate) {
      try {
        const correctionCandidate = await this.findSimilarMemory(embedding, 0.82);
        if (correctionCandidate) {
          if (correctionCandidate.similarity >= 0.92) {
            // Exact/near-exact duplicate — skip saving
            this._sessionCounters.memoriesDuplicated++;
            return { id: correctionCandidate.id, created: false, duplicate: correctionCandidate };
          }
          // Similar but different = correction/refinement — increment existing
          await this.incrementCorrectionCount(correctionCandidate.id);
        }
      } catch {
        // Non-fatal: correction detection failure shouldn't block save
      }
    }

    let savedId: number;
    let wasDuplicate = false;

    if (this.backend === 'postgresql' && this.postgres) {
      savedId = await this.postgres.saveMemory(
        content,
        embedding,
        tags,
        source,
        type,
        qualityScore,
        qualityFactors,
        validFrom,
        validUntil
      );

      // Sync to Qdrant with full payload
      if (this.hasQdrant()) {
        try {
          await this.qdrant!.upsertMemoryWithPayload(savedId, embedding, {
            content,
            tags,
            source,
            type,
            projectId: this.qdrant!.getProjectId(),
            createdAt: new Date().toISOString(),
            validFrom,
            validUntil,
          });
        } catch (error) {
          this._warnQdrantFailure(`Failed to sync memory vector ${savedId}`, error);
        }
      }
    } else {
      const sqlite = await this.getSqliteFns();
      const result = sqlite.saveMemory(content, embedding, tags, source, {
        type,
        deduplicate: false, // dedup already handled above
        qualityScore:
          qualityScore != null ? { score: qualityScore, factors: qualityFactors ?? {} } : undefined,
        validFrom,
        validUntil,
      });

      savedId = result.id;
      wasDuplicate = result.isDuplicate;

      // SQLite + Qdrant: sync memory
      if (this.hasQdrant() && !wasDuplicate) {
        try {
          await this.qdrant!.upsertMemoryWithPayload(savedId, embedding, {
            content,
            tags,
            source,
            type,
            projectId: this.qdrant!.getProjectId(),
            createdAt: new Date().toISOString(),
            validFrom,
            validUntil,
          });
        } catch (error) {
          this._warnQdrantFailure(`Failed to sync memory vector ${savedId}`, error);
        }
      }
    }

    if (!wasDuplicate) {
      this._sessionCounters.memoriesCreated++;
      this._sessionCounters.typesCreated[type] =
        (this._sessionCounters.typesCreated[type] ?? 0) + 1;

      // Auto-detect invariant content and set is_invariant + compute priority_score
      // Hybrid: regex fast path (8 languages) + embedding similarity fallback (any language)
      // Skip observations — they're subagent reports/facts, not rules/constraints.
      // Invariant detection only makes sense for decision/learning/pattern/error types.
      try {
        if (type !== 'observation') {
          const { detectInvariant, detectInvariantWithEmbedding } =
            await import('../working-memory-pipeline.js');
          const isInvariant =
            detectInvariant(content) || (await detectInvariantWithEmbedding(content, embedding));
          if (isInvariant) {
            await this.setMemoryInvariant(savedId, true);
          }
        }
        await this.recomputePriorityScore(savedId);
      } catch {
        // Non-fatal
      }
    } else {
      this._sessionCounters.memoriesDuplicated++;
    }

    return {
      id: savedId,
      created: !wasDuplicate,
      duplicate: wasDuplicate ? { id: savedId, content: '', similarity: 1.0 } : undefined,
    };
  }

  async searchMemories(
    queryEmbedding: number[],
    limit: number = 5,
    threshold: number = 0.3,
    tags?: string[],
    since?: Date,
    options?: { includeExpired?: boolean; asOfDate?: Date }
  ): Promise<any[]> {
    if (this.hasQdrant()) {
      try {
        const results = await this.qdrant!.hybridSearchMemories(
          '',
          queryEmbedding,
          limit,
          threshold,
          {
            projectId: this.qdrant!.getProjectId(),
            tags,
            since,
            asOfDate: options?.asOfDate,
            includeExpired: options?.includeExpired,
          }
        );
        if (results.length > 0) return results;
      } catch (error) {
        this._warnQdrantFailure('searchMemories hybrid failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.searchMemories(queryEmbedding, limit, threshold, tags, since, options);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.searchMemories(queryEmbedding, limit, threshold, tags, since, options);
  }

  async getMemoryById(id: number): Promise<any | null> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getMemoryById(id);
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryById(id);
  }

  async deleteMemory(id: number): Promise<boolean> {
    // Tier 1 immutability guard: pinned memories cannot be deleted
    await this._guardPinned(id);

    if (this.backend === 'postgresql' && this.postgres) {
      const deleted = await this.postgres.deleteMemory(id);
      if (deleted && this.vectorBackend === 'qdrant' && this.qdrant)
        await this.qdrant.deleteMemoryVector(id);
      return deleted;
    }
    const sqlite = await this.getSqliteFns();
    const deleted = sqlite.deleteMemory(id);
    if (deleted && this.vectorBackend === 'qdrant' && this.qdrant) {
      try {
        await this.qdrant.deleteMemoryVector(id);
      } catch (err) {
        logWarn('storage', `Qdrant vector delete failed for memory ${id}`, { error: String(err) });
      }
    }
    return deleted;
  }

  async getRecentMemories(limit: number = 10): Promise<any[]> {
    // Two-phase fetch: pinned memories + over-fetched recent
    const overfetchLimit = limit * 3;
    let raw: any[];
    let pinned: any[];
    if (this.backend === 'postgresql' && this.postgres) {
      [raw, pinned] = await Promise.all([
        this.postgres.getRecentMemories(overfetchLimit),
        this.postgres.getPinnedMemories(),
      ]);
    } else {
      const sqlite = await this.getSqliteFns();
      raw = sqlite.getRecentMemories(overfetchLimit);
      pinned = sqlite.getPinnedMemories();
    }
    // Apply working memory pipeline: pinned first → validity filter → score → rank
    const { applyWorkingMemoryPipeline, applyDiversityFilter } =
      await import('../working-memory-pipeline.js');
    // Over-request to account for diversity filtering
    const pipelineLimit = Math.min(limit * 2, raw.length + pinned.length);
    const pipeline = applyWorkingMemoryPipeline(raw, pipelineLimit, new Date(), pinned);
    // Diversity filter: remove near-duplicate embeddings
    const diverse = await applyDiversityFilter(pipeline, (ids) =>
      this.getMemoryEmbeddingsByIds(ids)
    );
    return diverse.slice(0, limit);
  }

  async findSimilarMemory(
    embedding: number[],
    threshold?: number
  ): Promise<{ id: number; content: string; similarity: number } | null> {
    const thresh = threshold ?? 0.92;
    if (this.vectorBackend === 'qdrant' && this.qdrant) {
      try {
        const results = await this.qdrant.findSimilarWithContent('memories', embedding, 3, thresh);
        if (results.length > 0 && results[0].similarity >= thresh) {
          return {
            id: results[0].id,
            content: results[0].content,
            similarity: results[0].similarity,
          };
        }
        // v1 schema fallback: IDs only -> PG
        if (results.length === 0 && this.backend === 'postgresql' && this.postgres) {
          const qr = await this.qdrant.searchMemories(embedding, 3, thresh);
          if (qr.length > 0) {
            const pgRows = await this.postgres.getMemoriesByIds(
              qr.map((r) => r.id),
              { excludeInvalidated: false }
            );
            if (pgRows.length > 0) {
              const score = qr.find((r) => r.id === pgRows[0].id)?.similarity ?? 0;
              if (score >= thresh)
                return { id: pgRows[0].id, content: pgRows[0].content, similarity: score };
            }
          }
        }
      } catch (error) {
        this._warnQdrantFailure('findSimilarMemory failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.findSimilarMemory(embedding, threshold);
    const sqlite = await this.getSqliteFns();
    return sqlite.findSimilarMemory(embedding, threshold);
  }

  async saveMemoriesBatch(
    memories: any[],
    deduplicateThreshold?: number,
    options?: { autoLink?: boolean; linkThreshold?: number; deduplicate?: boolean }
  ): Promise<any> {
    let result: any;
    if (this.backend === 'postgresql' && this.postgres) {
      result = await this.postgres.saveMemoriesBatch(memories, deduplicateThreshold, options);
    } else {
      const sqlite = await this.getSqliteFns();
      result = await sqlite.saveMemoriesBatch(memories, deduplicateThreshold, options);
    }

    // Sync newly saved memories to Qdrant
    if (this.hasQdrant() && result?.results?.length > 0) {
      try {
        const saved = result.results.filter((r: any) => !r.isDuplicate && r.id != null);
        if (saved.length > 0) {
          const items = saved.map((r: any) => {
            const mem = memories[r.index];
            return {
              id: r.id,
              embedding: mem.embedding,
              meta: {
                content: mem.content,
                tags: mem.tags ?? [],
                source: mem.source,
                type: mem.type,
                projectId: this.qdrant!.getProjectId(),
                createdAt: new Date().toISOString(),
                validFrom: mem.validFrom
                  ? mem.validFrom instanceof Date
                    ? mem.validFrom.toISOString()
                    : mem.validFrom
                  : null,
                validUntil: mem.validUntil
                  ? mem.validUntil instanceof Date
                    ? mem.validUntil.toISOString()
                    : mem.validUntil
                  : null,
              },
            };
          });
          await this.qdrant!.upsertMemoriesBatchWithPayload(items);
        }
      } catch (error) {
        this._warnQdrantFailure(`Failed to sync ${result.saved} batch memories`, error);
      }
    }

    return result;
  }

  async invalidateMemory(memoryId: number, supersededById: number): Promise<boolean> {
    // Tier 1 immutability guard: pinned memories cannot be invalidated
    await this._guardPinned(memoryId);

    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.invalidateMemory(memoryId, supersededById);
    const sqlite = await this.getSqliteFns();
    return sqlite.invalidateMemory(memoryId, supersededById);
  }

  async restoreInvalidatedMemory(memoryId: number): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.restoreInvalidatedMemory(memoryId);
    const sqlite = await this.getSqliteFns();
    return sqlite.restoreInvalidatedMemory(memoryId);
  }

  async getConsolidationHistory(limit?: number): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getConsolidationHistory(limit);
    const sqlite = await this.getSqliteFns();
    return sqlite.getConsolidationHistory(limit);
  }

  async getMemoryStats(): Promise<any> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getMemoryStats();
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryStats();
  }

  async deleteMemoriesOlderThan(date: Date): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.deleteMemoriesOlderThan(date);
    const sqlite = await this.getSqliteFns();
    return sqlite.deleteMemoriesOlderThan(date);
  }

  async deleteMemoriesByTag(tag: string): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.deleteMemoriesByTag(tag);
    const sqlite = await this.getSqliteFns();
    return sqlite.deleteMemoriesByTag(tag);
  }

  async deleteMemoriesByIds(ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    // Filter out pinned memories (Tier 1 immutability)
    const safeIds = await this._filterOutPinned(ids);
    if (safeIds.length === 0) return 0;
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.deleteMemoriesByIds(safeIds);
    const sqlite = await this.getSqliteFns();
    return sqlite.deleteMemoriesByIds(safeIds);
  }

  async searchMemoriesAsOf(
    queryEmbedding: number[],
    asOfDate: Date,
    limit?: number,
    threshold?: number
  ): Promise<any[]> {
    const lim = limit ?? 5;
    const thresh = threshold ?? 0.3;
    if (this.hasQdrant()) {
      try {
        const results = await this.qdrant!.hybridSearchMemories('', queryEmbedding, lim, thresh, {
          createdBefore: asOfDate,
          asOfDate,
          includeExpired: false,
        });
        if (results.length > 0) return results;
      } catch (error) {
        this._warnQdrantFailure('searchMemoriesAsOf failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.searchMemoriesAsOf(queryEmbedding, asOfDate, limit, threshold);
    const sqlite = await this.getSqliteFns();
    return sqlite.searchMemoriesAsOf(queryEmbedding, asOfDate, limit, threshold);
  }

  // ===========================================================================
  // Memory Links
  // ===========================================================================

  async createMemoryLink(
    sourceId: number,
    targetId: number,
    relation: LinkRelation = 'related',
    weight: number = 1.0,
    validFrom?: string,
    validUntil?: string
  ): Promise<{ id: number; created: boolean }> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.createMemoryLink(
        sourceId,
        targetId,
        relation,
        weight,
        validFrom,
        validUntil
      );
    const sqlite = await this.getSqliteFns();
    return sqlite.createMemoryLink(sourceId, targetId, relation, weight, { validFrom, validUntil });
  }

  async deleteMemoryLink(
    sourceId: number,
    targetId: number,
    relation?: LinkRelation
  ): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.deleteMemoryLink(sourceId, targetId, relation);
    const sqlite = await this.getSqliteFns();
    return sqlite.deleteMemoryLink(sourceId, targetId, relation);
  }

  async getMemoryLinks(memoryId: number): Promise<any> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getMemoryLinks(memoryId);
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryLinks(memoryId);
  }

  async getMemoryWithLinks(
    memoryId: number,
    options?: { asOfDate?: Date; includeExpired?: boolean }
  ): Promise<any> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getMemoryWithLinks(memoryId, options);
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryWithLinks(memoryId, options);
  }

  async findConnectedMemories(memoryId: number, maxDepth?: number): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.findConnectedMemories(memoryId, maxDepth);
    const sqlite = await this.getSqliteFns();
    return sqlite.findConnectedMemories(memoryId, maxDepth);
  }

  async findRelatedMemoriesForLinking(
    memoryId: number,
    threshold?: number,
    maxLinks?: number
  ): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.findRelatedMemoriesForLinking(memoryId, threshold, maxLinks);
    const sqlite = await this.getSqliteFns();
    return sqlite.findRelatedMemoriesForLinking(memoryId, threshold, maxLinks);
  }

  async createAutoLinks(memoryId: number, threshold?: number, maxLinks?: number): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.createAutoLinks(memoryId, threshold, maxLinks);
    const sqlite = await this.getSqliteFns();
    return sqlite.createAutoLinks(memoryId, threshold, maxLinks);
  }

  async autoLinkSimilarMemories(threshold?: number, maxLinks?: number): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.autoLinkSimilarMemories(threshold, maxLinks);
    const sqlite = await this.getSqliteFns();
    return sqlite.autoLinkSimilarMemories(threshold, maxLinks);
  }

  async getGraphStats(): Promise<any> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getGraphStats();
    const sqlite = await this.getSqliteFns();
    return sqlite.getGraphStats();
  }

  async invalidateMemoryLink(
    sourceId: number,
    targetId: number,
    relation?: LinkRelation
  ): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.invalidateMemoryLink(sourceId, targetId, relation);
    const sqlite = await this.getSqliteFns();
    return sqlite.invalidateMemoryLink(sourceId, targetId, relation);
  }

  async getMemoryLinksAsOf(memoryId: number, asOfDate: Date): Promise<any> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getMemoryLinksAsOf(memoryId, asOfDate);
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryLinksAsOf(memoryId, asOfDate);
  }

  async findConnectedMemoriesAsOf(
    memoryId: number,
    asOfDate: Date,
    maxDepth?: number
  ): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.findConnectedMemoriesAsOf(memoryId, asOfDate, maxDepth);
    const sqlite = await this.getSqliteFns();
    return sqlite.findConnectedMemoriesAsOf(memoryId, asOfDate, maxDepth);
  }

  async getGraphStatsAsOf(asOfDate: Date): Promise<any> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getGraphStatsAsOf(asOfDate);
    const sqlite = await this.getSqliteFns();
    return sqlite.getGraphStatsAsOf(asOfDate);
  }

  // ===========================================================================
  // Graph Enrichment
  // ===========================================================================

  async updateMemoryEmbedding(memoryId: number, embedding: number[]): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.updateMemoryEmbedding(memoryId, embedding);
    }
    const sqlite = await this.getSqliteFns();
    sqlite.updateMemoryEmbedding(memoryId, embedding);
  }

  async updateMemoryEmbeddingsBatch(
    updates: Array<{ id: number; embedding: number[] }>
  ): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.updateMemoryEmbeddingsBatch(updates);
    }
    const sqlite = await this.getSqliteFns();
    for (const { id, embedding } of updates) {
      sqlite.updateMemoryEmbedding(id, embedding);
    }
  }

  async getMemoriesNeedingReembedding(
    limit: number = 100,
    afterId: number = 0
  ): Promise<Array<{ id: number; content: string }>> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.getMemoriesNeedingReembedding(limit, afterId);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoriesNeedingReembedding(limit, afterId);
  }

  async getMemoryCount(): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.getMemoryCount();
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryCount();
  }

  async getMemoryEmbeddingCount(): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.getMemoryEmbeddingCount();
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryEmbeddingCount();
  }

  async updateMemoryTags(memoryId: number, tags: string[]): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.updateMemoryTags(memoryId, tags);
    }
    const sqlite = await this.getSqliteFns();
    sqlite.updateMemoryTags(memoryId, tags);
  }

  async updateMemoryLink(
    linkId: number,
    updates: { relation?: string; weight?: number; llmEnriched?: boolean }
  ): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.updateMemoryLink(linkId, updates);
    }
    const sqlite = await this.getSqliteFns();
    sqlite.updateMemoryLink(linkId, updates);
  }

  async upsertCentralityScore(
    memoryId: number,
    degree: number,
    normalizedDegree: number
  ): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.upsertCentralityScore(memoryId, degree, normalizedDegree);
    }
    const sqlite = await this.getSqliteFns();
    sqlite.upsertCentralityScore(memoryId, degree, normalizedDegree);
  }

  async getCentralityScores(memoryIds: number[]): Promise<Map<number, number>> {
    if (memoryIds.length === 0) return new Map();
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.getCentralityScores(memoryIds);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.getCentralityScores(memoryIds);
  }

  // ===========================================================================
  // File Hashes
  // ===========================================================================

  async getFileHash(filePath: string): Promise<string | null> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getFileHash(filePath);
    const sqlite = await this.getSqliteFns();
    return sqlite.getFileHash(filePath);
  }

  async setFileHash(filePath: string, hash: string): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.setFileHash(filePath, hash);
    const sqlite = await this.getSqliteFns();
    return sqlite.setFileHash(filePath, hash);
  }

  async deleteFileHash(filePath: string): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.deleteFileHash(filePath);
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.deleteFileHash(filePath);
  }

  async getAllFileHashes(): Promise<Map<string, string>> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getAllFileHashes();
    const sqlite = await this.getSqliteFns();
    return sqlite.getAllFileHashes();
  }

  async getAllFileHashesWithTimestamps(): Promise<
    Array<{ file_path: string; content_hash: string; indexed_at: string }>
  > {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getAllFileHashesWithTimestamps();
    const sqlite = await this.getSqliteFns();
    return sqlite.getAllFileHashesWithTimestamps();
  }

  // ===========================================================================
  // Token Frequency Operations
  // ===========================================================================

  async updateTokenFrequencies(tokens: string[]): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.updateTokenFrequencies(tokens);
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.updateTokenFrequencies(tokens);
  }

  async getTokenFrequency(token: string): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getTokenFrequency(token);
    const sqlite = await this.getSqliteFns();
    return sqlite.getTokenFrequency(token);
  }

  async getTokenFrequencies(tokens: string[]): Promise<Map<string, number>> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getTokenFrequencies(tokens);
    const sqlite = await this.getSqliteFns();
    return sqlite.getTokenFrequencies(tokens);
  }

  async getTotalTokenCount(): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getTotalTokenCount();
    const sqlite = await this.getSqliteFns();
    return sqlite.getTotalTokenCount();
  }

  async getTopTokens(limit?: number): Promise<Array<{ token: string; frequency: number }>> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getTopTokens(limit);
    const sqlite = await this.getSqliteFns();
    return sqlite.getTopTokens(limit);
  }

  async clearTokenFrequencies(): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.clearTokenFrequencies();
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.clearTokenFrequencies();
  }

  async getTokenFrequencyStats(): Promise<{
    unique_tokens: number;
    total_occurrences: number;
    avg_frequency: number;
  }> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getTokenFrequencyStats();
    const sqlite = await this.getSqliteFns();
    return sqlite.getTokenFrequencyStats();
  }

  // ===========================================================================
  // Token Stats
  // ===========================================================================

  async recordTokenStat(record: any): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.recordTokenStat(record);
    const sqlite = await this.getSqliteFns();
    return sqlite.recordTokenStat(record);
  }

  async getTokenStatsSummary(): Promise<any> {
    if (this.backend === 'postgresql' && this.postgres) {
      const summary = await this.postgres.getTokenStatsSummary();
      const savingsPercent =
        summary.total_full_source_tokens > 0
          ? (summary.total_savings_tokens / summary.total_full_source_tokens) * 100
          : 0;
      return {
        total_calls: summary.total_queries,
        total_returned_tokens: summary.total_returned_tokens,
        total_full_source_tokens: summary.total_full_source_tokens,
        total_savings_tokens: summary.total_savings_tokens,
        total_estimated_cost: summary.total_estimated_cost,
        savings_percent: savingsPercent,
        by_event_type: [],
      };
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.getTokenStatsSummary();
  }

  async getTokenStatsAggregated(): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getTokenStatsAggregated();
    const sqlite = await this.getSqliteFns();
    return sqlite.getTokenStatsAggregated();
  }

  async clearTokenStats(): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.clearTokenStats();
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.clearTokenStats();
  }

  // ===========================================================================
  // Web Search History
  // ===========================================================================

  async recordWebSearch(record: WebSearchHistoryInput): Promise<number> {
    this._sessionCounters.webSearchQueries++;
    this._sessionCounters.webSearchCostUsd += record.estimated_cost_usd;
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.recordWebSearch(record);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.recordWebSearch(record);
  }

  async getWebSearchHistory(filter: WebSearchHistoryFilter): Promise<WebSearchHistoryRecord[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getWebSearchHistory(filter);
    const sqlite = await this.getSqliteFns();
    return sqlite.getWebSearchHistory(filter);
  }

  async getWebSearchSummary(): Promise<WebSearchHistorySummary> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getWebSearchSummary();
    const sqlite = await this.getSqliteFns();
    return sqlite.getWebSearchSummary();
  }

  async getTodayWebSearchSpend(): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getTodayWebSearchSpend();
    const sqlite = await this.getSqliteFns();
    return sqlite.getTodayWebSearchSpend();
  }

  async clearWebSearchHistory(): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.clearWebSearchHistory();
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.clearWebSearchHistory();
  }

  // ===========================================================================
  // Retention Operations
  // ===========================================================================

  async incrementMemoryAccess(memoryId: number, weight?: number): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.incrementMemoryAccess(memoryId, weight);
    } else {
      const sqlite = await this.getSqliteFns();
      sqlite.incrementMemoryAccess(memoryId, weight);
    }
    // Recompute priority_score after access change
    await this.recomputePriorityScore(memoryId);
  }

  async incrementMemoryAccessBatch(
    accesses: Array<{ memoryId: number; weight: number }>
  ): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.incrementMemoryAccessBatch(accesses);
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.incrementMemoryAccessBatch(accesses);
  }

  async incrementCorrectionCount(memoryId: number): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.incrementCorrectionCount(memoryId);
    } else {
      const sqlite = await this.getSqliteFns();
      sqlite.incrementCorrectionCount(memoryId);
    }
    // Recompute priority_score after correction change
    await this.recomputePriorityScore(memoryId);
  }

  async setMemoryInvariant(memoryId: number, isInvariant: boolean): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.setMemoryInvariant(memoryId, isInvariant);
    } else {
      const sqlite = await this.getSqliteFns();
      sqlite.setMemoryInvariant(memoryId, isInvariant);
    }
    // Recompute priority_score after invariant change
    await this.recomputePriorityScore(memoryId);
  }

  async getPinnedMemories(threshold?: number): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getPinnedMemories(threshold);
    const sqlite = await this.getSqliteFns();
    return sqlite.getPinnedMemories(threshold);
  }

  async updatePriorityScore(memoryId: number, score: number): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      await this.postgres.updatePriorityScore(memoryId, score);
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.updatePriorityScore(memoryId, score);
  }

  async recomputePriorityScore(memoryId: number): Promise<void> {
    try {
      const memory = await this.getMemoryById(memoryId);
      if (!memory) return;
      const { computePriorityScore } = await import('../working-memory-pipeline.js');
      const score = computePriorityScore(
        {
          is_invariant: !!(memory as any).is_invariant,
          quality_score: memory.quality_score,
          correction_count: (memory as any).correction_count ?? 0,
          type: (memory as any).type ?? null,
          tags: memory.tags,
          access_count: memory.access_count,
          last_accessed: memory.last_accessed
            ? typeof memory.last_accessed === 'object'
              ? (memory.last_accessed as any).toISOString()
              : memory.last_accessed
            : null,
          created_at:
            typeof memory.created_at === 'object'
              ? (memory.created_at as any).toISOString()
              : memory.created_at,
        },
        new Date()
      );
      await this.updatePriorityScore(memoryId, score);
    } catch {
      // Non-fatal: priority_score recomputation failure shouldn't break writes
    }
  }

  /** Filter out pinned memory IDs from a list (for bulk operations) */
  private async _filterOutPinned(ids: number[]): Promise<number[]> {
    const { isPinned } = await import('../working-memory-pipeline.js');
    const safe: number[] = [];
    for (const id of ids) {
      const memory = await this.getMemoryById(id);
      if (!memory) {
        safe.push(id);
        continue;
      }
      if (
        !isPinned({
          is_invariant: !!(memory as any).is_invariant,
          correction_count: (memory as any).correction_count ?? 0,
        })
      ) {
        safe.push(id);
      }
    }
    return safe;
  }

  /** Throw PinnedMemoryError if the memory is pinned (Tier 1 immutability) */
  private async _guardPinned(memoryId: number): Promise<void> {
    const memory = await this.getMemoryById(memoryId);
    if (!memory) return;
    const { isPinned, PinnedMemoryError } = await import('../working-memory-pipeline.js');
    if (
      isPinned({
        is_invariant: !!(memory as any).is_invariant,
        correction_count: (memory as any).correction_count ?? 0,
      })
    ) {
      throw new PinnedMemoryError(memoryId);
    }
  }

  async getAllMemoriesForRetention(): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getAllMemoriesForRetention();
    const sqlite = await this.getSqliteFns();
    return sqlite.getAllMemoriesForRetention();
  }

  // ===========================================================================
  // BM25 Index Management
  // ===========================================================================

  async invalidateCodeBm25Index(): Promise<void> {
    const s = await this.getSqliteFns();
    s.invalidateCodeBm25Index();
  }
  async invalidateDocsBm25Index(): Promise<void> {
    const s = await this.getSqliteFns();
    s.invalidateDocsBm25Index();
  }
  async invalidateMemoriesBm25Index(): Promise<void> {
    const s = await this.getSqliteFns();
    s.invalidateMemoriesBm25Index();
  }
  async invalidateGlobalMemoriesBm25Index(): Promise<void> {
    const s = await this.getSqliteFns();
    s.invalidateGlobalMemoriesBm25Index();
  }
  async invalidateBM25Index(): Promise<void> {
    const s = await this.getSqliteFns();
    s.invalidateBM25Index();
  }
  async updateCodeBm25Index(
    docId: number,
    content: string,
    symbolName?: string,
    signature?: string
  ): Promise<void> {
    const s = await this.getSqliteFns();
    s.updateCodeBm25Index(docId, content, symbolName, signature);
  }
  async updateMemoriesBm25Index(memoryId: number, content: string): Promise<void> {
    const s = await this.getSqliteFns();
    s.updateMemoriesBm25Index(memoryId, content);
  }
  async updateGlobalMemoriesBm25Index(memoryId: number, content: string): Promise<void> {
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
  ): Promise<any[]> {
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
        if (qdrantResults.length > 0) return this.applyCodeFilters(qdrantResults, regexFilter, lim);
      } catch (error) {
        this._warnQdrantFailure('hybridSearchCode failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres) {
      const results = (
        await this.postgres.searchDocuments(queryEmbedding, fetchLimit, thresh, {
          codeOnly: true,
          symbolType: filters?.symbolType,
        })
      ).map((r) => ({ ...r, bm25Score: 0, vectorScore: r.similarity }));
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
  ): Promise<any[]> {
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
        if (results.length > 0) return results;
      } catch (error) {
        this._warnQdrantFailure('hybridSearchDocs failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres) {
      return (
        await this.postgres.searchDocuments(queryEmbedding, lim, thresh, { docsOnly: true })
      ).map((r) => ({ ...r, bm25Score: 0, vectorScore: r.similarity }));
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
  ): Promise<any[]> {
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
        if (results.length > 0) return results;
      } catch (error) {
        this._warnQdrantFailure('hybridSearchMemories failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.searchMemories(queryEmbedding, lim, thresh);
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
  ): Promise<any[]> {
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
        if (results.length > 0) return results;
      } catch (error) {
        this._warnQdrantFailure('hybridSearchGlobalMemories failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.searchGlobalMemories(queryEmbedding, lim, thresh, tags);
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
  private applyCodeFilters(
    results: any[],
    filters: { regex?: string; symbolType?: string } | undefined,
    limit: number
  ): any[] {
    if (!filters) return results.slice(0, limit);

    let regexFilter: RegExp | null = null;
    if (filters.regex && filters.regex.length <= 500) {
      try {
        regexFilter = new RegExp(filters.regex, 'i');
      } catch {
        /* invalid regex — skip */
      }
    }

    const filtered: any[] = [];
    for (const r of results) {
      if (filters.symbolType && r.symbol_type !== filters.symbolType) continue;
      if (regexFilter && !regexFilter.test(r.content)) continue;
      filtered.push(r);
      if (filtered.length >= limit) break;
    }
    return filtered;
  }

  // ===========================================================================
  // Global Memory Operations
  // ===========================================================================

  async saveGlobalMemory(
    content: string,
    embedding: number[],
    tags: string[] = [],
    source?: string,
    options?: {
      type?: MemoryType;
      deduplicate?: boolean;
      qualityScore?: number;
      qualityFactors?: Record<string, number>;
    }
  ): Promise<{
    id: number;
    created: boolean;
    duplicate?: { id: number; content: string; similarity: number };
  }> {
    const type = options?.type ?? 'observation';
    const deduplicate = options?.deduplicate ?? true;
    const qualityScore = options?.qualityScore;
    const qualityFactors = options?.qualityFactors;

    if (this.backend === 'postgresql' && this.postgres) {
      if (deduplicate) {
        const similar = await this.findSimilarGlobalMemory(embedding, 0.95);
        if (similar) {
          this._sessionCounters.memoriesDuplicated++;
          return { id: similar.id, created: false, duplicate: similar };
        }
      }
      const id = await this.postgres.saveGlobalMemory(
        content,
        embedding,
        tags,
        source,
        type,
        qualityScore,
        qualityFactors
      );

      if (this.hasQdrant()) {
        try {
          await this.qdrant!.upsertGlobalMemoryWithPayload(id, embedding, {
            content,
            tags,
            source,
            type,
            createdAt: new Date().toISOString(),
          });
        } catch (error) {
          this._warnQdrantFailure(`Failed to sync global memory vector ${id}`, error);
        }
      }
      this._sessionCounters.globalMemoriesCreated++;
      return { id, created: true };
    }

    const sqlite = await this.getSqliteFns();
    const result = sqlite.saveGlobalMemory(content, embedding, tags, source, undefined, {
      type,
      deduplicate,
    });

    if (this.hasQdrant() && !result.isDuplicate) {
      try {
        await this.qdrant!.upsertGlobalMemoryWithPayload(result.id, embedding, {
          content,
          tags,
          source,
          type,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        this._warnQdrantFailure(`Failed to sync global memory vector ${result.id}`, error);
      }
    }

    if (!result.isDuplicate) {
      this._sessionCounters.globalMemoriesCreated++;
    } else {
      this._sessionCounters.memoriesDuplicated++;
    }
    return {
      id: result.id,
      created: !result.isDuplicate,
      duplicate:
        result.isDuplicate && result.similarity != null
          ? { id: result.id, content: '', similarity: result.similarity }
          : undefined,
    };
  }

  async searchGlobalMemories(
    queryEmbedding: number[],
    limit: number = 5,
    threshold: number = 0.3,
    tags?: string[]
  ): Promise<any[]> {
    if (this.hasQdrant()) {
      try {
        const results = await this.qdrant!.hybridSearchGlobalMemories(
          '',
          queryEmbedding,
          limit,
          threshold,
          { tags }
        );
        if (results.length > 0) return results;
      } catch (error) {
        this._warnQdrantFailure('searchGlobalMemories failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.searchGlobalMemories(queryEmbedding, limit, threshold, tags);
    const sqlite = await this.getSqliteFns();
    return sqlite.searchGlobalMemories(queryEmbedding, limit, threshold, tags);
  }

  async getRecentGlobalMemories(limit: number = 10): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getRecentGlobalMemories(limit);
    const sqlite = await this.getSqliteFns();
    return sqlite.getRecentGlobalMemories(limit);
  }

  async deleteGlobalMemory(id: number): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres) {
      const deleted = await this.postgres.deleteGlobalMemory(id);
      if (deleted && this.vectorBackend === 'qdrant' && this.qdrant)
        await this.qdrant.deleteGlobalMemoryVector(id);
      return deleted;
    }
    const sqlite = await this.getSqliteFns();
    const deleted = sqlite.deleteGlobalMemory(id);
    if (deleted && this.vectorBackend === 'qdrant' && this.qdrant) {
      try {
        await this.qdrant.deleteGlobalMemoryVector(id);
      } catch (err) {
        logWarn('storage', `Qdrant global vector delete failed for memory ${id}`, {
          error: String(err),
        });
      }
    }
    return deleted;
  }

  async findSimilarGlobalMemory(
    embedding: number[],
    threshold?: number
  ): Promise<{ id: number; content: string; similarity: number } | null> {
    const thresh = threshold ?? 0.92;
    if (this.vectorBackend === 'qdrant' && this.qdrant) {
      try {
        const results = await this.qdrant.findSimilarWithContent(
          'global_memories',
          embedding,
          3,
          thresh
        );
        if (results.length > 0 && results[0].similarity >= thresh) {
          return {
            id: results[0].id,
            content: results[0].content,
            similarity: results[0].similarity,
          };
        }
        if (results.length === 0 && this.backend === 'postgresql' && this.postgres) {
          const qr = await this.qdrant.searchGlobalMemories(embedding, 3, thresh);
          if (qr.length > 0) {
            const pgRows = await this.postgres.getMemoriesByIds(
              qr.map((r) => r.id),
              { excludeInvalidated: false }
            );
            if (pgRows.length > 0) {
              const score = qr.find((r) => r.id === pgRows[0].id)?.similarity ?? 0;
              if (score >= thresh)
                return { id: pgRows[0].id, content: pgRows[0].content, similarity: score };
            }
          }
        }
      } catch (error) {
        this._warnQdrantFailure('findSimilarGlobalMemory failed, falling back', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.findSimilarGlobalMemory(embedding, threshold);
    const sqlite = await this.getSqliteFns();
    return sqlite.findSimilarGlobalMemory(embedding, threshold);
  }

  async getGlobalMemoryStats(): Promise<any> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getGlobalMemoryStats();
    const sqlite = await this.getSqliteFns();
    return sqlite.getGlobalMemoryStats();
  }

  // ===========================================================================
  // Skills
  // ===========================================================================

  async upsertSkill(skill: {
    name: string;
    description: string;
    source: 'local' | 'skyll';
    path?: string;
    content?: string;
    skyllId?: string;
    cacheExpires?: string;
  }): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.upsertSkill({
        ...skill,
        cacheExpires: skill.cacheExpires ? new Date(skill.cacheExpires) : undefined,
      });
    }
    const { upsertSkill } = await import('../db/skills.js');
    return upsertSkill(skill);
  }

  async getAllSkills(): Promise<
    Array<{
      id: number;
      name: string;
      description: string;
      source: string;
      path?: string;
      content?: string;
      skyllId?: string;
      usageCount: number;
      lastUsed?: string;
    }>
  > {
    if (this.backend === 'postgresql' && this.postgres) {
      const rows = await this.postgres.getAllSkills();
      return rows.map((r) => ({
        ...r,
        lastUsed: r.lastUsed ? String(r.lastUsed) : undefined,
        usageCount: r.usageCount,
      }));
    }
    const { getAllSkills } = await import('../db/skills.js');
    const rows = getAllSkills();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      source: r.source,
      path: r.path,
      content: r.content,
      skyllId: r.skyll_id,
      usageCount: r.usage_count ?? 0,
      lastUsed: r.last_used,
    }));
  }

  async searchSkills(
    query: string,
    limit: number = 10
  ): Promise<
    Array<{
      id: number;
      name: string;
      description: string;
      source: string;
      path?: string;
      usageCount: number;
    }>
  > {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.searchSkills(query, limit);
    const { searchSkills } = await import('../db/skills.js');
    const rows = searchSkills(query, limit);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      source: r.source,
      path: r.path,
      usageCount: r.usage_count ?? 0,
    }));
  }

  async getSkillByName(name: string): Promise<{
    id: number;
    name: string;
    description: string;
    source: string;
    path?: string;
    content?: string;
    skyllId?: string;
  } | null> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getSkillByName(name);
    const { getSkillByName } = await import('../db/skills.js');
    const row = getSkillByName(name);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      source: row.source,
      path: row.path,
      content: row.content,
      skyllId: row.skyll_id,
    };
  }

  async trackSkillUsage(name: string): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.trackSkillUsage(name);
    const { trackSkillUsage } = await import('../db/skills.js');
    trackSkillUsage(name);
  }

  async deleteSkill(name: string): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.deleteSkill(name);
    const { deleteSkill } = await import('../db/skills.js');
    return deleteSkill(name);
  }

  async clearExpiredSkyllCache(): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.clearExpiredSkyllCache();
    const { clearExpiredSkyllCache } = await import('../db/skills.js');
    return clearExpiredSkyllCache();
  }

  async getCachedSkyllSkill(skyllId: string): Promise<{
    id: number;
    name: string;
    description: string;
    content?: string;
  } | null> {
    if (this.backend === 'postgresql' && this.postgres)
      return this.postgres.getCachedSkyllSkill(skyllId);
    const { getCachedSkyllSkill } = await import('../db/skills.js');
    return getCachedSkyllSkill(skyllId);
  }

  async getSkyllCacheStats(): Promise<{ cachedSkills: number }> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getSkyllCacheStats();
    const { getSkyllCacheStats } = await import('../db/skills.js');
    return getSkyllCacheStats();
  }

  // ===========================================================================
  // Bulk Export (for checkpoint, graph-export)
  // ===========================================================================

  async getAllMemoriesForExport(): Promise<
    Array<{
      id: number;
      content: string;
      tags: string[];
      source: string | null;
      embedding: number[] | null;
      type: string | null;
      quality_score: number | null;
      quality_factors: Record<string, number> | null;
      access_count: number;
      last_accessed: string | null;
      created_at: string;
      invalidated_by: number | null;
    }>
  > {
    const { getAllMemoriesForExportImpl } = await import('./dispatcher-export.js');
    return getAllMemoriesForExportImpl(this);
  }

  async getAllDocumentsForExport(): Promise<
    Array<{
      id: number;
      file_path: string;
      chunk_index: number;
      content: string;
      start_line: number;
      end_line: number;
      embedding: number[] | null;
      created_at: string;
    }>
  > {
    const { getAllDocumentsForExportImpl } = await import('./dispatcher-export.js');
    return getAllDocumentsForExportImpl(this);
  }

  async getAllMemoryLinksForExport(): Promise<
    Array<{
      id: number;
      source_id: number;
      target_id: number;
      relation: string;
      weight: number;
      created_at: string;
      llm_enriched: boolean;
    }>
  > {
    const { getAllMemoryLinksForExportImpl } = await import('./dispatcher-export.js');
    return getAllMemoryLinksForExportImpl(this);
  }

  async getAllCentralityForExport(): Promise<
    Array<{
      memory_id: number;
      degree: number;
      normalized_degree: number;
      updated_at: string;
    }>
  > {
    const { getAllCentralityForExportImpl } = await import('./dispatcher-export.js');
    return getAllCentralityForExportImpl(this);
  }

  // ===========================================================================
  // Learning Deltas
  // ===========================================================================

  async appendLearningDelta(delta: {
    timestamp: string;
    source: string;
    memoriesBefore: number;
    memoriesAfter: number;
    newMemories: number;
    typesAdded: Record<string, number>;
    avgQualityOfNew?: number | null;
  }): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      await pool.query(
        `INSERT INTO learning_deltas (project_id, timestamp, source, memories_before, memories_after, new_memories, types_added, avg_quality)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          this.postgres.getProjectId(),
          delta.timestamp,
          delta.source,
          delta.memoriesBefore,
          delta.memoriesAfter,
          delta.newMemories,
          Object.keys(delta.typesAdded).length > 0 ? JSON.stringify(delta.typesAdded) : null,
          delta.avgQualityOfNew ?? null,
        ]
      );
      return;
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    db.prepare(
      `INSERT INTO learning_deltas (timestamp, source, memories_before, memories_after, new_memories, types_added, avg_quality)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      delta.timestamp,
      delta.source,
      delta.memoriesBefore,
      delta.memoriesAfter,
      delta.newMemories,
      Object.keys(delta.typesAdded).length > 0 ? JSON.stringify(delta.typesAdded) : null,
      delta.avgQualityOfNew ?? null
    );
  }

  async appendRawLearningDelta(text: string): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      await pool.query(
        `INSERT INTO learning_deltas (project_id, timestamp, source, memories_before, memories_after, new_memories)
         VALUES ($1, $2, $3, 0, 0, 0)`,
        [this.postgres.getProjectId(), new Date().toISOString(), text]
      );
      return;
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    db.prepare(
      `INSERT INTO learning_deltas (timestamp, source, memories_before, memories_after, new_memories)
       VALUES (?, ?, 0, 0, 0)`
    ).run(new Date().toISOString(), text);
  }

  async getLearningDeltas(
    options: {
      limit?: number;
      since?: string;
    } = {}
  ): Promise<
    Array<{
      id: number;
      timestamp: string;
      source: string;
      memories_before: number;
      memories_after: number;
      new_memories: number;
      types_added: string | null;
      avg_quality: number | null;
      created_at: string;
    }>
  > {
    const limit = options.limit && options.limit > 0 ? options.limit : 20;

    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const params: any[] = [this.postgres.getProjectId()];
      let sql = `SELECT id, timestamp::text as timestamp, source, memories_before, memories_after,
                        new_memories, types_added, avg_quality, created_at::text as created_at
                 FROM learning_deltas WHERE LOWER(project_id) = $1`;
      if (options.since) {
        params.push(options.since);
        sql += ` AND timestamp >= $${params.length}`;
      }
      params.push(limit);
      sql += ` ORDER BY timestamp DESC LIMIT $${params.length}`;
      const { rows } = await pool.query(sql, params);
      return rows;
    }

    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const params: any[] = [];
    let sql = 'SELECT * FROM learning_deltas';
    if (options.since) {
      sql += ' WHERE timestamp >= ?';
      params.push(options.since);
    }
    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params) as SqlLearningDelta[];
  }

  // ===========================================================================
  // AI Readiness Stats
  // ===========================================================================

  async getCodeFileCount(): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT file_path) as count FROM documents WHERE LOWER(project_id) = $1 AND file_path LIKE 'code:%'`,
        [this.postgres.getProjectId()]
      );
      return parseInt(rows[0]?.count ?? '0');
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const row = db
      .prepare(
        `SELECT COUNT(DISTINCT file_path) as count FROM documents WHERE file_path LIKE 'code:%'`
      )
      .get() as { count: number };
    return row.count;
  }

  async getDocsFileCount(): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT file_path) as count FROM documents WHERE LOWER(project_id) = $1 AND file_path NOT LIKE 'code:%'`,
        [this.postgres.getProjectId()]
      );
      return parseInt(rows[0]?.count ?? '0');
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const row = db
      .prepare(
        `SELECT COUNT(DISTINCT file_path) as count FROM documents WHERE file_path NOT LIKE 'code:%'`
      )
      .get() as { count: number };
    return row.count;
  }

  async getAverageMemoryQuality(): Promise<{ avg: number | null; count: number }> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const { rows } = await pool.query(
        `SELECT AVG(quality_score) as avg, COUNT(*) as count FROM memories WHERE LOWER(project_id) = $1 AND quality_score IS NOT NULL`,
        [this.postgres.getProjectId()]
      );
      return {
        avg: rows[0]?.avg ? parseFloat(rows[0].avg) : null,
        count: parseInt(rows[0]?.count ?? '0'),
      };
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const row = db
      .prepare(
        `SELECT AVG(quality_score) as avg, COUNT(*) as count FROM memories WHERE quality_score IS NOT NULL`
      )
      .get() as { avg: number | null; count: number };
    return { avg: row.avg, count: row.count };
  }

  // ===========================================================================
  // Filtered Memory Export (for agents-md-generator)
  // ===========================================================================

  async getMemoriesForAgentsExport(options: {
    types: string[];
    minQuality: number;
    limit: number;
  }): Promise<
    Array<{
      id: number;
      content: string;
      type: string | null;
      tags: string[];
      source: string | null;
      quality_score: number | null;
      created_at: string;
    }>
  > {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const typePlaceholders = options.types.map((_, i) => `$${i + 2}`).join(', ');
      const { rows } = await pool.query(
        `SELECT id, content, type, tags, source, quality_score, created_at::text as created_at
         FROM memories
         WHERE LOWER(project_id) = $1
           AND invalidated_by IS NULL
           AND type IN (${typePlaceholders})
           AND (quality_score IS NULL OR quality_score >= $${options.types.length + 2})
         ORDER BY
           CASE type
             WHEN 'dead_end' THEN 0 WHEN 'decision' THEN 1
             WHEN 'pattern' THEN 2 WHEN 'learning' THEN 3 ELSE 4
           END,
           quality_score DESC NULLS LAST
         LIMIT $${options.types.length + 3}`,
        [this.postgres.getProjectId(), ...options.types, options.minQuality, options.limit]
      );
      return rows.map((r: any) => ({
        ...r,
        tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags ?? []),
      }));
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const typePlaceholders = options.types.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT id, content, type, tags, source, quality_score, created_at
       FROM memories
       WHERE invalidated_by IS NULL
         AND type IN (${typePlaceholders})
         AND (quality_score IS NULL OR quality_score >= ?)
       ORDER BY
         CASE type
           WHEN 'dead_end' THEN 0 WHEN 'decision' THEN 1
           WHEN 'pattern' THEN 2 WHEN 'learning' THEN 3 ELSE 4
         END,
         quality_score DESC
       LIMIT ?`
      )
      .all(...options.types, options.minQuality, options.limit) as Array<{
      id: number;
      content: string;
      type: string | null;
      tags: string | null;
      source: string | null;
      quality_score: number | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      ...r,
      tags: r.tags ? JSON.parse(r.tags) : [],
    }));
  }

  // ===========================================================================
  // Consolidation Helpers
  // ===========================================================================

  async getAllMemoriesWithEmbeddings(options?: {
    types?: string[];
    excludeInvalidated?: boolean;
  }): Promise<
    Array<{
      id: number;
      content: string;
      tags: string[];
      source: string | null;
      embedding: number[] | null;
      type: string | null;
      quality_score: number | null;
      created_at: string;
      invalidated_by: number | null;
    }>
  > {
    if (this.backend === 'postgresql' && this.postgres) {
      const rows = await this.postgres.getAllMemoriesWithEmbeddings();
      let result = rows.map((r: any) => ({
        id: r.id,
        content: r.content,
        tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags ?? []),
        source: r.source ?? null,
        embedding: r.embedding ?? null,
        type: r.type ?? null,
        quality_score: r.qualityScore ?? r.quality_score ?? null,
        created_at: r.createdAt ?? r.created_at ?? new Date().toISOString(),
        invalidated_by: r.invalidatedBy ?? r.invalidated_by ?? null,
      }));
      if (options?.excludeInvalidated) result = result.filter((r) => r.invalidated_by == null);
      if (options?.types?.length)
        result = result.filter((r) => r.type != null && options.types!.includes(r.type));
      return result;
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    let sql = `SELECT id, content, tags, source, embedding, type, quality_score, created_at, invalidated_by FROM memories`;
    const conditions: string[] = [];
    if (options?.excludeInvalidated) conditions.push('invalidated_by IS NULL');
    if (options?.types?.length) {
      const placeholders = options.types.map(() => '?').join(', ');
      conditions.push(`type IN (${placeholders})`);
    }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY id ASC';

    const params = options?.types?.length ? options.types : [];
    const rows = db.prepare(sql).all(...params) as SqlMemoryRow[];
    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      tags: row.tags ? JSON.parse(row.tags) : [],
      source: row.source,
      embedding: row.embedding
        ? Array.from(
            new Float32Array(
              row.embedding.buffer,
              row.embedding.byteOffset,
              row.embedding.byteLength / 4
            )
          )
        : null,
      type: row.type,
      quality_score: row.quality_score,
      created_at: row.created_at,
      invalidated_by: row.invalidated_by ?? null,
    }));
  }

  async getMemoryEmbeddingsByIds(ids: number[]): Promise<Map<number, number[]>> {
    if (ids.length === 0) return new Map();

    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await pool.query(
        `SELECT id, embedding::text FROM memories WHERE id IN (${placeholders})`,
        ids
      );
      const map = new Map<number, number[]>();
      for (const row of rows) {
        if (row.embedding) {
          // pgvector returns embedding as string "[0.1,0.2,...]"
          const vec = JSON.parse(row.embedding.replace(/^\[/, '[').replace(/\]$/, ']'));
          map.set(row.id, vec);
        }
      }
      return map;
    }

    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, embedding FROM memories WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ id: number; embedding: Buffer | null }>;
    const map = new Map<number, number[]>();
    for (const row of rows) {
      if (row.embedding) {
        map.set(
          row.id,
          Array.from(
            new Float32Array(
              row.embedding.buffer,
              row.embedding.byteOffset,
              row.embedding.byteLength / 4
            )
          )
        );
      }
    }
    return map;
  }

  async deleteMemoryLinksForMemory(memoryId: number): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const result = await pool.query(
        'DELETE FROM memory_links WHERE (source_id = $1 OR target_id = $1) AND LOWER(project_id) = $2',
        [memoryId, this.postgres.getProjectId()]
      );
      return result.rowCount ?? 0;
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const result = db
      .prepare('DELETE FROM memory_links WHERE source_id = ? OR target_id = ?')
      .run(memoryId, memoryId);
    return result.changes;
  }

  // ===========================================================================
  // Bulk Restore (for checkpoint restore)
  // ===========================================================================

  /**
   * Bulk restore memories, links, centrality, and documents from checkpoint data.
   * Used by checkpoint.ts to avoid direct SQLite/PG access.
   */
  async bulkRestore(data: {
    memories: Array<{
      id: number;
      content: string;
      tags: string[];
      source: string | null;
      embedding: number[] | null;
      type: string | null;
      quality_score: number | null;
      quality_factors: Record<string, number> | null;
      access_count: number;
      last_accessed: string | null;
      created_at: string;
    }>;
    memoryLinks: Array<{
      source_id: number;
      target_id: number;
      relation: string;
      weight: number;
      created_at: string;
      llm_enriched?: boolean;
    }>;
    centrality: Array<{
      memory_id: number;
      degree: number;
      normalized_degree: number;
      updated_at: string;
    }>;
    documents: Array<{
      file_path: string;
      chunk_index: number;
      content: string;
      start_line: number;
      end_line: number;
      embedding: number[] | null;
      created_at: string;
    }>;
    overwrite: boolean;
    restoreDocuments: boolean;
  }): Promise<{
    memoriesRestored: number;
    linksRestored: number;
    documentsRestored: number;
    memoryIdMap: Map<number, number>;
  }> {
    const { bulkRestoreImpl } = await import('./dispatcher-export.js');
    return bulkRestoreImpl(this, data);
  }

  // ===========================================================================
  // Backend Info
  // ===========================================================================

  getBackendInfo(): {
    backend: 'sqlite' | 'postgresql';
    vector: 'builtin' | 'qdrant';
    vectorName: string;
  } {
    return {
      backend: this.backend,
      vector: this.vectorBackend,
      vectorName:
        this.vectorBackend === 'qdrant'
          ? 'qdrant'
          : this.backend === 'postgresql'
            ? 'pgvector'
            : 'sqlite-vec',
    };
  }

  // ===========================================================================
  // Qdrant Backfill — Sync existing SQL data → Qdrant
  // ===========================================================================

  /**
   * Backfill Qdrant collections from the SQL backend.
   * Use after Qdrant schema migration or when collections are empty.
   */
  async backfillQdrant(
    target: 'memories' | 'global_memories' | 'documents' | 'all' = 'all',
    options?: { onProgress?: (msg: string) => void; dryRun?: boolean }
  ): Promise<{ memories: number; globalMemories: number; documents: number }> {
    const { backfillQdrantImpl } = await import('./dispatcher-export.js');
    return backfillQdrantImpl(this, target, options);
  }
}

/** Parse pgvector string '[1.0, 2.0, 3.0]' to number[] */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function parsePgVector(str: string): number[] {
  const inner = str.slice(1, -1);
  if (!inner) return [];
  return inner.split(',').map((s) => parseFloat(s.trim()));
}

// Singleton
let _dispatcher: StorageDispatcher | null = null;

export async function getStorageDispatcher(): Promise<StorageDispatcher> {
  if (!_initialized) await initStorageDispatcher();
  if (!_dispatcher) _dispatcher = new StorageDispatcher();
  return _dispatcher;
}

export function resetStorageDispatcher(): void {
  _dispatcher = null;
  _initialized = false;
  _postgresBackend = null;
  _qdrantStore = null;
  _backend = 'sqlite';
  _vectorBackend = 'builtin';
}
