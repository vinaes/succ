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
import type { DocumentUpsertMeta, MemoryUpsertMeta } from './vector/qdrant.js';

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
      await _qdrantStore.init(384);
    } catch (error) {
      console.error('[Qdrant] Failed to initialize, falling back to builtin:', (error as Error).message);
      _qdrantStore = null;
    }
  }

  _initialized = true;
  _dispatcher = null;
}

export function getBackendType(): 'sqlite' | 'postgresql' { return _backend; }
export function getVectorBackendType(): 'builtin' | 'qdrant' { return _vectorBackend; }
export function isPostgresBackend(): boolean { return _backend === 'postgresql'; }
export function isQdrantVectors(): boolean { return _vectorBackend === 'qdrant'; }
export function getPostgresBackend(): PostgresBackend | null { return _postgresBackend; }
export function getQdrantStore(): QdrantVectorStore | null { return _qdrantStore; }

export async function closeStorageDispatcher(): Promise<void> {
  if (_postgresBackend) { await _postgresBackend.close(); _postgresBackend = null; }
  if (_qdrantStore) { await _qdrantStore.close(); _qdrantStore = null; }
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
    typesCreated: {} as Record<string, number>,
    startedAt: new Date().toISOString(),
  };

  constructor() {
    this.backend = _backend;
    this.vectorBackend = _vectorBackend;
    this.postgres = _postgresBackend;
    this.qdrant = _qdrantStore;
  }

  /** Get current session counters (non-destructive read) */
  getSessionCounters() {
    return { ...this._sessionCounters };
  }

  /** Flush session counters to learning_deltas table and reset */
  async flushSessionCounters(source: string): Promise<void> {
    const c = this._sessionCounters;
    const totalCreated = c.memoriesCreated + c.globalMemoriesCreated;

    if (totalCreated === 0 && c.recallQueries === 0 && c.searchQueries === 0 && c.codeSearchQueries === 0 && c.webSearchQueries === 0) return;

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
      console.error('[StorageDispatcher] Failed to flush session counters:', error);
    }

    this._sessionCounters = {
      memoriesCreated: 0, memoriesDuplicated: 0, globalMemoriesCreated: 0,
      recallQueries: 0, searchQueries: 0, codeSearchQueries: 0,
      webSearchQueries: 0, webSearchCostUsd: 0,
      typesCreated: {}, startedAt: new Date().toISOString(),
    };
  }

  private async getSqliteFns(): Promise<typeof import('../db/index.js')> {
    if (!this._sqliteFns) { this._sqliteFns = await import('../db/index.js'); }
    return this._sqliteFns;
  }

  /** Check if Qdrant is available with hybrid schema for a collection */
  private hasQdrantHybrid(collection: 'documents' | 'memories' | 'global_memories' = 'documents'): boolean {
    return this.vectorBackend === 'qdrant' && this.qdrant !== null && this.qdrant.hasHybridSearch(collection);
  }

  // ===========================================================================
  // Document Operations
  // ===========================================================================

  async upsertDocument(
    filePath: string, chunkIndex: number, content: string,
    startLine: number, endLine: number, embedding: number[]
  ): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      const id = await this.postgres.upsertDocument(filePath, chunkIndex, content, startLine, endLine, embedding);
      if (this.vectorBackend === 'qdrant' && this.qdrant) {
        try {
          if (this.qdrant.hasHybridSearch('documents')) {
            await this.qdrant.upsertDocumentWithPayload(id, embedding, {
              filePath, content, startLine, endLine,
              projectId: this.qdrant.getProjectId() ?? '',
            });
          } else {
            await this.qdrant.upsertDocumentVector(id, embedding);
          }
        } catch (error) {
          console.error(`[Qdrant] Failed to sync document vector ${id}:`, error);
        }
      }
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.upsertDocument(filePath, chunkIndex, content, startLine, endLine, embedding);
  }

  async upsertDocumentsBatch(documents: any[]): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      const ids = await this.postgres.upsertDocumentsBatch(documents);
      if (this.vectorBackend === 'qdrant' && this.qdrant && ids.length > 0) {
        try {
          if (this.qdrant.hasHybridSearch('documents')) {
            const items = documents.map((doc, idx) => ({
              id: ids[idx], embedding: doc.embedding,
              meta: { filePath: doc.filePath, content: doc.content, startLine: doc.startLine, endLine: doc.endLine, projectId: this.qdrant!.getProjectId() ?? '' } as DocumentUpsertMeta,
            }));
            await this.qdrant.upsertDocumentsBatchWithPayload(items);
          } else {
            await this.qdrant.upsertDocumentVectorsBatch(documents.map((doc, idx) => ({ id: ids[idx], embedding: doc.embedding })));
          }
        } catch (error) {
          console.error(`[Qdrant] Failed to sync ${ids.length} document vectors:`, error);
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
      if (this.vectorBackend === 'qdrant' && this.qdrant && ids.length > 0) {
        try {
          if (this.qdrant.hasHybridSearch('documents')) {
            const items = documents.map((doc, idx) => ({
              id: ids[idx], embedding: doc.embedding,
              meta: { filePath: doc.filePath, content: doc.content, startLine: doc.startLine, endLine: doc.endLine, projectId: this.qdrant!.getProjectId() ?? '' } as DocumentUpsertMeta,
            }));
            await this.qdrant.upsertDocumentsBatchWithPayload(items);
          } else {
            await this.qdrant.upsertDocumentVectorsBatch(documents.map((doc, idx) => ({ id: ids[idx], embedding: doc.embedding })));
          }
        } catch (error) {
          console.error(`[Qdrant] Failed to sync ${ids.length} document vectors:`, error);
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
        try { await this.qdrant.deleteDocumentVectorsByIds(deletedIds); }
        catch (error) { console.error(`[Qdrant] Failed to delete document vectors:`, error); }
      }
      return;
    }
    const sqlite = await this.getSqliteFns();
    sqlite.deleteDocumentsByPath(filePath);
  }

  async searchDocuments(
    queryEmbedding: number[], limit: number = 5, threshold: number = 0.5
  ): Promise<Array<{ file_path: string; content: string; start_line: number; end_line: number; similarity: number }>> {
    if (this.vectorBackend === 'qdrant' && this.qdrant) {
      try {
        if (this.qdrant.hasHybridSearch('documents')) {
          const client = await (this.qdrant as any).getClient();
          const name = (this.qdrant as any).collectionName('documents');
          const qResults = await client.query(name, {
            query: queryEmbedding, using: 'dense', limit, score_threshold: threshold,
            params: { hnsw_ef: 128, exact: false }, with_payload: true,
          });
          const points = qResults.points ?? qResults;
          if (points.length > 0 && points[0].payload?.content) {
            return points.map((p: any) => ({
              file_path: p.payload?.file_path ?? '', content: p.payload?.content ?? '',
              start_line: p.payload?.start_line ?? 0, end_line: p.payload?.end_line ?? 0, similarity: p.score,
            }));
          }
        }
        if (this.backend === 'postgresql' && this.postgres) {
          const results = await this.qdrant.searchDocuments(queryEmbedding, limit * 3, threshold);
          if (results.length > 0) {
            const pgRows = await this.postgres.getDocumentsByIds(results.map(r => r.id));
            return pgRows.map(row => {
              const score = results.find(r => r.id === row.id)?.similarity ?? 0;
              return { file_path: row.file_path, content: row.content, start_line: row.start_line, end_line: row.end_line, similarity: score };
            }).sort((a, b) => b.similarity - a.similarity).slice(0, limit);
          }
        }
      } catch (error) {
        console.error('[Qdrant] searchDocuments failed, falling back:', error);
      }
    }
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.searchDocuments(queryEmbedding, limit, threshold);
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.searchDocuments(queryEmbedding, limit, threshold);
  }

  async getRecentDocuments(limit: number = 10): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getRecentDocuments(limit);
    const sqlite = await this.getSqliteFns();
    return sqlite.getRecentDocuments(limit);
  }

  async getStats(): Promise<{ total_documents: number; total_files: number; last_indexed: string | null }> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getDocumentStats();
    const sqlite = await this.getSqliteFns();
    return sqlite.getStats();
  }

  async clearDocuments(): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) { await this.postgres.clearDocuments(); return; }
    const sqlite = await this.getSqliteFns();
    sqlite.clearDocuments();
  }

  async clearCodeDocuments(): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) { await this.postgres.clearCodeDocuments(); return; }
    const sqlite = await this.getSqliteFns();
    sqlite.clearCodeDocuments();
  }

  async getStoredEmbeddingDimension(): Promise<number | null> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getStoredEmbeddingDimension();
    const sqlite = await this.getSqliteFns();
    return sqlite.getStoredEmbeddingDimension();
  }

  // ===========================================================================
  // Memory Operations
  // ===========================================================================

  async saveMemory(
    content: string, embedding: number[], tags: string[] = [], source?: string,
    options?: { type?: MemoryType; deduplicate?: boolean; qualityScore?: number; qualityFactors?: Record<string, number>; validFrom?: string; validUntil?: string; }
  ): Promise<{ id: number; created: boolean; duplicate?: { id: number; content: string; similarity: number } }> {
    const type = options?.type ?? 'observation';
    const deduplicate = options?.deduplicate ?? true;
    const qualityScore = options?.qualityScore;
    const qualityFactors = options?.qualityFactors;
    const validFrom = options?.validFrom;
    const validUntil = options?.validUntil;

    if (this.backend === 'postgresql' && this.postgres) {
      if (deduplicate) {
        const similar = await this.findSimilarMemory(embedding, 0.95);
        if (similar) { this._sessionCounters.memoriesDuplicated++; return { id: similar.id, created: false, duplicate: similar }; }
      }
      const id = await this.postgres.saveMemory(content, embedding, tags, source, type, qualityScore, qualityFactors, validFrom, validUntil);

      // Sync to Qdrant with full payload
      if (this.vectorBackend === 'qdrant' && this.qdrant) {
        try {
          if (this.qdrant.hasHybridSearch('memories')) {
            await this.qdrant.upsertMemoryWithPayload(id, embedding, {
              content, tags, source, type, projectId: this.qdrant.getProjectId(),
              createdAt: new Date().toISOString(), validFrom, validUntil,
            });
          } else {
            await this.qdrant.upsertMemoryVector(id, embedding);
          }
        } catch (error) { console.error(`[Qdrant] Failed to sync memory vector ${id}:`, error); }
      }
      this._sessionCounters.memoriesCreated++;
      this._sessionCounters.typesCreated[type] = (this._sessionCounters.typesCreated[type] ?? 0) + 1;
      return { id, created: true };
    }

    const sqlite = await this.getSqliteFns();
    const result = sqlite.saveMemory(content, embedding, tags, source, {
      type, deduplicate,
      qualityScore: qualityScore != null ? { score: qualityScore, factors: qualityFactors ?? {} } : undefined,
      validFrom, validUntil,
    });

    // SQLite + Qdrant: sync memory
    if (this.vectorBackend === 'qdrant' && this.qdrant && !result.isDuplicate) {
      try {
        if (this.qdrant.hasHybridSearch('memories')) {
          await this.qdrant.upsertMemoryWithPayload(result.id, embedding, {
            content, tags, source, type, projectId: this.qdrant.getProjectId(),
            createdAt: new Date().toISOString(), validFrom, validUntil,
          });
        } else {
          await this.qdrant.upsertMemoryVector(result.id, embedding);
        }
      } catch (error) { console.error(`[Qdrant] Failed to sync memory vector ${result.id}:`, error); }
    }

    const created = !result.isDuplicate;
    if (created) {
      this._sessionCounters.memoriesCreated++;
      this._sessionCounters.typesCreated[type] = (this._sessionCounters.typesCreated[type] ?? 0) + 1;
    } else {
      this._sessionCounters.memoriesDuplicated++;
    }
    return {
      id: result.id, created,
      duplicate: result.isDuplicate && result.similarity != null
        ? { id: result.id, content: '', similarity: result.similarity } : undefined,
    };
  }

  async searchMemories(
    queryEmbedding: number[], limit: number = 5, threshold: number = 0.3,
    tags?: string[], since?: Date, options?: { includeExpired?: boolean; asOfDate?: Date }
  ): Promise<any[]> {
    if (this.hasQdrantHybrid('memories')) {
      try {
        const results = await this.qdrant!.hybridSearchMemories(
          '', queryEmbedding, limit, threshold,
          { projectId: this.qdrant!.getProjectId(), tags, since, asOfDate: options?.asOfDate, includeExpired: options?.includeExpired }
        );
        if (results.length > 0) return results;
      } catch (error) { console.error('[Qdrant] searchMemories hybrid failed, falling back:', error); }
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
    if (this.backend === 'postgresql' && this.postgres) {
      const deleted = await this.postgres.deleteMemory(id);
      if (deleted && this.vectorBackend === 'qdrant' && this.qdrant) await this.qdrant.deleteMemoryVector(id);
      return deleted;
    }
    const sqlite = await this.getSqliteFns();
    const deleted = sqlite.deleteMemory(id);
    if (deleted && this.vectorBackend === 'qdrant' && this.qdrant) {
      try { await this.qdrant.deleteMemoryVector(id); } catch { /* non-fatal */ }
    }
    return deleted;
  }

  async getRecentMemories(limit: number = 10): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getRecentMemories(limit);
    const sqlite = await this.getSqliteFns();
    return sqlite.getRecentMemories(limit);
  }

  async findSimilarMemory(embedding: number[], threshold?: number): Promise<{ id: number; content: string; similarity: number } | null> {
    const thresh = threshold ?? 0.92;
    if (this.vectorBackend === 'qdrant' && this.qdrant) {
      try {
        const results = await this.qdrant.findSimilarWithContent('memories', embedding, 3, thresh);
        if (results.length > 0 && results[0].similarity >= thresh) {
          return { id: results[0].id, content: results[0].content, similarity: results[0].similarity };
        }
        // v1 schema fallback: IDs only -> PG
        if (results.length === 0 && this.backend === 'postgresql' && this.postgres) {
          const qr = await this.qdrant.searchMemories(embedding, 3, thresh);
          if (qr.length > 0) {
            const pgRows = await this.postgres.getMemoriesByIds(qr.map(r => r.id), { excludeInvalidated: false });
            if (pgRows.length > 0) {
              const score = qr.find(r => r.id === pgRows[0].id)?.similarity ?? 0;
              if (score >= thresh) return { id: pgRows[0].id, content: pgRows[0].content, similarity: score };
            }
          }
        }
      } catch (error) { console.error('[Qdrant] findSimilarMemory failed, falling back:', error); }
    }
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.findSimilarMemory(embedding, threshold);
    const sqlite = await this.getSqliteFns();
    return sqlite.findSimilarMemory(embedding, threshold);
  }

  async saveMemoriesBatch(memories: any[], deduplicateThreshold?: number, options?: { autoLink?: boolean; linkThreshold?: number; deduplicate?: boolean }): Promise<any> {
    let result: any;
    if (this.backend === 'postgresql' && this.postgres) {
      result = await this.postgres.saveMemoriesBatch(memories, deduplicateThreshold, options);
    } else {
      const sqlite = await this.getSqliteFns();
      result = await sqlite.saveMemoriesBatch(memories, deduplicateThreshold, options);
    }

    // Sync newly saved memories to Qdrant
    if (this.vectorBackend === 'qdrant' && this.qdrant && result?.results?.length > 0) {
      try {
        const saved = result.results.filter((r: any) => !r.isDuplicate && r.id != null);
        if (saved.length > 0 && this.qdrant.hasHybridSearch('memories')) {
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
                validFrom: mem.validFrom ? (mem.validFrom instanceof Date ? mem.validFrom.toISOString() : mem.validFrom) : null,
                validUntil: mem.validUntil ? (mem.validUntil instanceof Date ? mem.validUntil.toISOString() : mem.validUntil) : null,
              },
            };
          });
          await this.qdrant.upsertMemoriesBatchWithPayload(items);
        }
      } catch (error) {
        console.error(`[Qdrant] Failed to sync ${result.saved} batch memories:`, error);
      }
    }

    return result;
  }

  async invalidateMemory(memoryId: number, supersededById: number): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.invalidateMemory(memoryId, supersededById);
    const sqlite = await this.getSqliteFns();
    return sqlite.invalidateMemory(memoryId, supersededById);
  }

  async restoreInvalidatedMemory(memoryId: number): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.restoreInvalidatedMemory(memoryId);
    const sqlite = await this.getSqliteFns();
    return sqlite.restoreInvalidatedMemory(memoryId);
  }

  async getConsolidationHistory(limit?: number): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getConsolidationHistory(limit);
    const sqlite = await this.getSqliteFns();
    return sqlite.getConsolidationHistory(limit);
  }

  async getMemoryStats(): Promise<any> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getMemoryStats();
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryStats();
  }

  async deleteMemoriesOlderThan(date: Date): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.deleteMemoriesOlderThan(date);
    const sqlite = await this.getSqliteFns();
    return sqlite.deleteMemoriesOlderThan(date);
  }

  async deleteMemoriesByTag(tag: string): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.deleteMemoriesByTag(tag);
    const sqlite = await this.getSqliteFns();
    return sqlite.deleteMemoriesByTag(tag);
  }

  async deleteMemoriesByIds(ids: number[]): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.deleteMemoriesByIds(ids);
    const sqlite = await this.getSqliteFns();
    return sqlite.deleteMemoriesByIds(ids);
  }

  async searchMemoriesAsOf(queryEmbedding: number[], asOfDate: Date, limit?: number, threshold?: number): Promise<any[]> {
    const lim = limit ?? 5;
    const thresh = threshold ?? 0.3;
    if (this.hasQdrantHybrid('memories')) {
      try {
        const results = await this.qdrant!.hybridSearchMemories('', queryEmbedding, lim, thresh, { createdBefore: asOfDate, asOfDate, includeExpired: false });
        if (results.length > 0) return results;
      } catch (error) { console.error('[Qdrant] searchMemoriesAsOf failed, falling back:', error); }
    }
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.searchMemoriesAsOf(queryEmbedding, asOfDate, limit, threshold);
    const sqlite = await this.getSqliteFns();
    return sqlite.searchMemoriesAsOf(queryEmbedding, asOfDate, limit, threshold);
  }

  // ===========================================================================
  // Memory Links
  // ===========================================================================

  async createMemoryLink(sourceId: number, targetId: number, relation: LinkRelation = 'related', weight: number = 1.0, validFrom?: string, validUntil?: string): Promise<{ id: number; created: boolean }> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.createMemoryLink(sourceId, targetId, relation, weight, validFrom, validUntil);
    const sqlite = await this.getSqliteFns();
    return sqlite.createMemoryLink(sourceId, targetId, relation, weight, { validFrom, validUntil });
  }

  async deleteMemoryLink(sourceId: number, targetId: number, relation?: LinkRelation): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.deleteMemoryLink(sourceId, targetId, relation);
    const sqlite = await this.getSqliteFns();
    return sqlite.deleteMemoryLink(sourceId, targetId, relation);
  }

  async getMemoryLinks(memoryId: number): Promise<any> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getMemoryLinks(memoryId);
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryLinks(memoryId);
  }

  async getMemoryWithLinks(memoryId: number, options?: { asOfDate?: Date; includeExpired?: boolean }): Promise<any> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getMemoryWithLinks(memoryId, options);
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryWithLinks(memoryId, options);
  }

  async findConnectedMemories(memoryId: number, maxDepth?: number): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.findConnectedMemories(memoryId, maxDepth);
    const sqlite = await this.getSqliteFns();
    return sqlite.findConnectedMemories(memoryId, maxDepth);
  }

  async findRelatedMemoriesForLinking(memoryId: number, threshold?: number, maxLinks?: number): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.findRelatedMemoriesForLinking(memoryId, threshold, maxLinks);
    const sqlite = await this.getSqliteFns();
    return sqlite.findRelatedMemoriesForLinking(memoryId, threshold, maxLinks);
  }

  async createAutoLinks(memoryId: number, threshold?: number, maxLinks?: number): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.createAutoLinks(memoryId, threshold, maxLinks);
    const sqlite = await this.getSqliteFns();
    return sqlite.createAutoLinks(memoryId, threshold, maxLinks);
  }

  async autoLinkSimilarMemories(threshold?: number, maxLinks?: number): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.autoLinkSimilarMemories(threshold, maxLinks);
    const sqlite = await this.getSqliteFns();
    return sqlite.autoLinkSimilarMemories(threshold, maxLinks);
  }

  async getGraphStats(): Promise<any> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getGraphStats();
    const sqlite = await this.getSqliteFns();
    return sqlite.getGraphStats();
  }

  async invalidateMemoryLink(sourceId: number, targetId: number, relation?: LinkRelation): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.invalidateMemoryLink(sourceId, targetId, relation);
    const sqlite = await this.getSqliteFns();
    return sqlite.invalidateMemoryLink(sourceId, targetId, relation);
  }

  async getMemoryLinksAsOf(memoryId: number, asOfDate: Date): Promise<any> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getMemoryLinksAsOf(memoryId, asOfDate);
    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryLinksAsOf(memoryId, asOfDate);
  }

  async findConnectedMemoriesAsOf(memoryId: number, asOfDate: Date, maxDepth?: number): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.findConnectedMemoriesAsOf(memoryId, asOfDate, maxDepth);
    const sqlite = await this.getSqliteFns();
    return sqlite.findConnectedMemoriesAsOf(memoryId, asOfDate, maxDepth);
  }

  async getGraphStatsAsOf(asOfDate: Date): Promise<any> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getGraphStatsAsOf(asOfDate);
    const sqlite = await this.getSqliteFns();
    return sqlite.getGraphStatsAsOf(asOfDate);
  }

  // ===========================================================================
  // Graph Enrichment
  // ===========================================================================

  async updateMemoryTags(memoryId: number, tags: string[]): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.updateMemoryTags(memoryId, tags);
    }
    const { getDb } = await import('../db/connection.js');
    const db = getDb();
    db.prepare('UPDATE memories SET tags = ? WHERE id = ?').run(JSON.stringify(tags), memoryId);
  }

  async updateMemoryLink(linkId: number, updates: { relation?: string; weight?: number; llmEnriched?: boolean }): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.updateMemoryLink(linkId, updates);
    }
    const { getDb } = await import('../db/connection.js');
    const db = getDb();
    const sets: string[] = [];
    const params: any[] = [];
    if (updates.relation !== undefined) { sets.push('relation = ?'); params.push(updates.relation); }
    if (updates.weight !== undefined) { sets.push('weight = ?'); params.push(updates.weight); }
    if (updates.llmEnriched !== undefined) { sets.push('llm_enriched = ?'); params.push(updates.llmEnriched ? 1 : 0); }
    if (sets.length > 0) {
      params.push(linkId);
      db.prepare(`UPDATE memory_links SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
  }

  async upsertCentralityScore(memoryId: number, degree: number, normalizedDegree: number): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.upsertCentralityScore(memoryId, degree, normalizedDegree);
    }
    const { getDb } = await import('../db/connection.js');
    const db = getDb();
    db.prepare(`INSERT INTO memory_centrality (memory_id, degree, normalized_degree, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(memory_id) DO UPDATE SET degree = excluded.degree, normalized_degree = excluded.normalized_degree, updated_at = excluded.updated_at`
    ).run(memoryId, degree, normalizedDegree);
  }

  async getCentralityScores(memoryIds: number[]): Promise<Map<number, number>> {
    if (memoryIds.length === 0) return new Map();
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.getCentralityScores(memoryIds);
    }
    const { getDb } = await import('../db/connection.js');
    const db = getDb();
    const placeholders = memoryIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT memory_id, normalized_degree FROM memory_centrality WHERE memory_id IN (${placeholders})`).all(...memoryIds) as Array<{ memory_id: number; normalized_degree: number }>;
    const map = new Map<number, number>();
    for (const row of rows) map.set(row.memory_id, row.normalized_degree);
    return map;
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
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.setFileHash(filePath, hash);
    const sqlite = await this.getSqliteFns();
    return sqlite.setFileHash(filePath, hash);
  }

  async deleteFileHash(filePath: string): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) { await this.postgres.deleteFileHash(filePath); return; }
    const sqlite = await this.getSqliteFns();
    sqlite.deleteFileHash(filePath);
  }

  async getAllFileHashes(): Promise<Map<string, string>> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getAllFileHashes();
    const sqlite = await this.getSqliteFns();
    return sqlite.getAllFileHashes();
  }

  async getAllFileHashesWithTimestamps(): Promise<Array<{ file_path: string; content_hash: string; indexed_at: string }>> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getAllFileHashesWithTimestamps();
    const sqlite = await this.getSqliteFns();
    return sqlite.getAllFileHashesWithTimestamps();
  }

  // ===========================================================================
  // Token Frequency Operations
  // ===========================================================================

  async updateTokenFrequencies(tokens: string[]): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) { await this.postgres.updateTokenFrequencies(tokens); return; }
    const sqlite = await this.getSqliteFns();
    sqlite.updateTokenFrequencies(tokens);
  }

  async getTokenFrequency(token: string): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getTokenFrequency(token);
    const sqlite = await this.getSqliteFns();
    return sqlite.getTokenFrequency(token);
  }

  async getTokenFrequencies(tokens: string[]): Promise<Map<string, number>> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getTokenFrequencies(tokens);
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
    if (this.backend === 'postgresql' && this.postgres) { await this.postgres.clearTokenFrequencies(); return; }
    const sqlite = await this.getSqliteFns();
    sqlite.clearTokenFrequencies();
  }

  async getTokenFrequencyStats(): Promise<{ unique_tokens: number; total_occurrences: number; avg_frequency: number }> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getTokenFrequencyStats();
    const sqlite = await this.getSqliteFns();
    return sqlite.getTokenFrequencyStats();
  }

  // ===========================================================================
  // Token Stats
  // ===========================================================================

  async recordTokenStat(record: any): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.recordTokenStat(record);
    const sqlite = await this.getSqliteFns();
    return sqlite.recordTokenStat(record);
  }

  async getTokenStatsSummary(): Promise<any> {
    if (this.backend === 'postgresql' && this.postgres) {
      const summary = await this.postgres.getTokenStatsSummary();
      const savingsPercent = summary.total_full_source_tokens > 0
        ? (summary.total_savings_tokens / summary.total_full_source_tokens) * 100 : 0;
      return {
        total_calls: summary.total_queries, total_returned_tokens: summary.total_returned_tokens,
        total_full_source_tokens: summary.total_full_source_tokens, total_savings_tokens: summary.total_savings_tokens,
        total_estimated_cost: summary.total_estimated_cost, savings_percent: savingsPercent, by_event_type: [],
      };
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.getTokenStatsSummary();
  }

  async getTokenStatsAggregated(): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getTokenStatsAggregated();
    const sqlite = await this.getSqliteFns();
    return sqlite.getTokenStatsAggregated();
  }

  async clearTokenStats(): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) { await this.postgres.clearTokenStats(); return; }
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
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getWebSearchHistory(filter);
    const sqlite = await this.getSqliteFns();
    return sqlite.getWebSearchHistory(filter);
  }

  async getWebSearchSummary(): Promise<WebSearchHistorySummary> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getWebSearchSummary();
    const sqlite = await this.getSqliteFns();
    return sqlite.getWebSearchSummary();
  }

  async getTodayWebSearchSpend(): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getTodayWebSearchSpend();
    const sqlite = await this.getSqliteFns();
    return sqlite.getTodayWebSearchSpend();
  }

  async clearWebSearchHistory(): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) { await this.postgres.clearWebSearchHistory(); return; }
    const sqlite = await this.getSqliteFns();
    sqlite.clearWebSearchHistory();
  }

  // ===========================================================================
  // Retention Operations
  // ===========================================================================

  async incrementMemoryAccess(memoryId: number, weight?: number): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) { await this.postgres.incrementMemoryAccess(memoryId, weight); return; }
    const sqlite = await this.getSqliteFns();
    sqlite.incrementMemoryAccess(memoryId, weight);
  }

  async incrementMemoryAccessBatch(accesses: Array<{ memoryId: number; weight: number }>): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) { await this.postgres.incrementMemoryAccessBatch(accesses); return; }
    const sqlite = await this.getSqliteFns();
    sqlite.incrementMemoryAccessBatch(accesses);
  }

  async getAllMemoriesForRetention(): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getAllMemoriesForRetention();
    const sqlite = await this.getSqliteFns();
    return sqlite.getAllMemoriesForRetention();
  }

  // ===========================================================================
  // BM25 Index Management
  // ===========================================================================

  async invalidateCodeBm25Index(): Promise<void> { const s = await this.getSqliteFns(); s.invalidateCodeBm25Index(); }
  async invalidateDocsBm25Index(): Promise<void> { const s = await this.getSqliteFns(); s.invalidateDocsBm25Index(); }
  async invalidateMemoriesBm25Index(): Promise<void> { const s = await this.getSqliteFns(); s.invalidateMemoriesBm25Index(); }
  async invalidateGlobalMemoriesBm25Index(): Promise<void> { const s = await this.getSqliteFns(); s.invalidateGlobalMemoriesBm25Index(); }
  async invalidateBM25Index(): Promise<void> { const s = await this.getSqliteFns(); s.invalidateBM25Index(); }
  async updateCodeBm25Index(docId: number, content: string): Promise<void> { const s = await this.getSqliteFns(); s.updateCodeBm25Index(docId, content); }
  async updateMemoriesBm25Index(memoryId: number, content: string): Promise<void> { const s = await this.getSqliteFns(); s.updateMemoriesBm25Index(memoryId, content); }
  async updateGlobalMemoriesBm25Index(memoryId: number, content: string): Promise<void> { const s = await this.getSqliteFns(); s.updateGlobalMemoriesBm25Index(memoryId, content); }

  // ===========================================================================
  // Hybrid Search — Approach C (BM25 + dense + RRF in single Qdrant call)
  // ===========================================================================

  async hybridSearchCode(query: string, queryEmbedding: number[], limit?: number, threshold?: number, alpha?: number): Promise<any[]> {
    this._sessionCounters.codeSearchQueries++;
    const lim = limit ?? 10;
    const thresh = threshold ?? 0.3;
    if (this.hasQdrantHybrid('documents')) {
      try {
        const results = await this.qdrant!.hybridSearchDocuments(query, queryEmbedding, lim, thresh, { codeOnly: true });
        if (results.length > 0) return results;
      } catch (error) { console.error('[Qdrant] hybridSearchCode failed, falling back:', error); }
    }
    if (this.backend === 'postgresql' && this.postgres) {
      return (await this.postgres.searchDocuments(queryEmbedding, lim, thresh)).map(r => ({ ...r, bm25Score: 0, vectorScore: r.similarity }));
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.hybridSearchCode(query, queryEmbedding, limit, threshold, alpha);
  }

  async hybridSearchDocs(query: string, queryEmbedding: number[], limit?: number, threshold?: number, alpha?: number): Promise<any[]> {
    this._sessionCounters.searchQueries++;
    const lim = limit ?? 10;
    const thresh = threshold ?? 0.3;
    if (this.hasQdrantHybrid('documents')) {
      try {
        const results = await this.qdrant!.hybridSearchDocuments(query, queryEmbedding, lim, thresh, { docsOnly: true });
        if (results.length > 0) return results;
      } catch (error) { console.error('[Qdrant] hybridSearchDocs failed, falling back:', error); }
    }
    if (this.backend === 'postgresql' && this.postgres) {
      return (await this.postgres.searchDocuments(queryEmbedding, lim, thresh)).map(r => ({ ...r, bm25Score: 0, vectorScore: r.similarity }));
    }
    const sqlite = await this.getSqliteFns();
    return sqlite.hybridSearchDocs(query, queryEmbedding, limit, threshold, alpha);
  }

  async hybridSearchMemories(query: string, queryEmbedding: number[], limit?: number, threshold?: number, alpha?: number): Promise<any[]> {
    this._sessionCounters.recallQueries++;
    const lim = limit ?? 10;
    const thresh = threshold ?? 0.3;
    if (this.hasQdrantHybrid('memories')) {
      try {
        const results = await this.qdrant!.hybridSearchMemories(query, queryEmbedding, lim, thresh, { projectId: this.qdrant!.getProjectId() });
        if (results.length > 0) return results;
      } catch (error) { console.error('[Qdrant] hybridSearchMemories failed, falling back:', error); }
    }
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.searchMemories(queryEmbedding, lim, thresh);
    const sqlite = await this.getSqliteFns();
    return sqlite.hybridSearchMemories(query, queryEmbedding, limit, threshold, alpha);
  }

  async hybridSearchGlobalMemories(query: string, queryEmbedding: number[], limit?: number, threshold?: number, alpha?: number, tags?: string[], since?: Date): Promise<any[]> {
    const lim = limit ?? 10;
    const thresh = threshold ?? 0.3;
    if (this.hasQdrantHybrid('global_memories')) {
      try {
        const results = await this.qdrant!.hybridSearchGlobalMemories(query, queryEmbedding, lim, thresh, { tags, since });
        if (results.length > 0) return results;
      } catch (error) { console.error('[Qdrant] hybridSearchGlobalMemories failed, falling back:', error); }
    }
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.searchGlobalMemories(queryEmbedding, lim, thresh, tags);
    const sqlite = await this.getSqliteFns();
    return sqlite.hybridSearchGlobalMemories(query, queryEmbedding, limit, threshold, alpha, tags, since);
  }

  // ===========================================================================
  // Global Memory Operations
  // ===========================================================================

  async saveGlobalMemory(
    content: string, embedding: number[], tags: string[] = [], source?: string,
    options?: { type?: MemoryType; deduplicate?: boolean; qualityScore?: number; qualityFactors?: Record<string, number>; }
  ): Promise<{ id: number; created: boolean; duplicate?: { id: number; content: string; similarity: number } }> {
    const type = options?.type ?? 'observation';
    const deduplicate = options?.deduplicate ?? true;
    const qualityScore = options?.qualityScore;
    const qualityFactors = options?.qualityFactors;

    if (this.backend === 'postgresql' && this.postgres) {
      if (deduplicate) {
        const similar = await this.findSimilarGlobalMemory(embedding, 0.95);
        if (similar) { this._sessionCounters.memoriesDuplicated++; return { id: similar.id, created: false, duplicate: similar }; }
      }
      const id = await this.postgres.saveGlobalMemory(content, embedding, tags, source, type, qualityScore, qualityFactors);

      if (this.vectorBackend === 'qdrant' && this.qdrant) {
        try {
          if (this.qdrant.hasHybridSearch('global_memories')) {
            await this.qdrant.upsertGlobalMemoryWithPayload(id, embedding, { content, tags, source, type, createdAt: new Date().toISOString() });
          } else {
            await this.qdrant.upsertGlobalMemoryVector(id, embedding);
          }
        } catch (error) { console.error(`[Qdrant] Failed to sync global memory vector ${id}:`, error); }
      }
      this._sessionCounters.globalMemoriesCreated++;
      return { id, created: true };
    }

    const sqlite = await this.getSqliteFns();
    const result = sqlite.saveGlobalMemory(content, embedding, tags, source, undefined, { type, deduplicate });

    if (this.vectorBackend === 'qdrant' && this.qdrant && !result.isDuplicate) {
      try {
        if (this.qdrant.hasHybridSearch('global_memories')) {
          await this.qdrant.upsertGlobalMemoryWithPayload(result.id, embedding, { content, tags, source, type, createdAt: new Date().toISOString() });
        } else {
          await this.qdrant.upsertGlobalMemoryVector(result.id, embedding);
        }
      } catch (error) { console.error(`[Qdrant] Failed to sync global memory vector ${result.id}:`, error); }
    }

    if (!result.isDuplicate) {
      this._sessionCounters.globalMemoriesCreated++;
    } else {
      this._sessionCounters.memoriesDuplicated++;
    }
    return {
      id: result.id, created: !result.isDuplicate,
      duplicate: result.isDuplicate && result.similarity != null ? { id: result.id, content: '', similarity: result.similarity } : undefined,
    };
  }

  async searchGlobalMemories(queryEmbedding: number[], limit: number = 5, threshold: number = 0.3, tags?: string[]): Promise<any[]> {
    if (this.hasQdrantHybrid('global_memories')) {
      try {
        const results = await this.qdrant!.hybridSearchGlobalMemories('', queryEmbedding, limit, threshold, { tags });
        if (results.length > 0) return results;
      } catch (error) { console.error('[Qdrant] searchGlobalMemories failed, falling back:', error); }
    }
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.searchGlobalMemories(queryEmbedding, limit, threshold, tags);
    const sqlite = await this.getSqliteFns();
    return sqlite.searchGlobalMemories(queryEmbedding, limit, threshold, tags);
  }

  async getRecentGlobalMemories(limit: number = 10): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getRecentGlobalMemories(limit);
    const sqlite = await this.getSqliteFns();
    return sqlite.getRecentGlobalMemories(limit);
  }

  async deleteGlobalMemory(id: number): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres) {
      const deleted = await this.postgres.deleteGlobalMemory(id);
      if (deleted && this.vectorBackend === 'qdrant' && this.qdrant) await this.qdrant.deleteGlobalMemoryVector(id);
      return deleted;
    }
    const sqlite = await this.getSqliteFns();
    const deleted = sqlite.deleteGlobalMemory(id);
    if (deleted && this.vectorBackend === 'qdrant' && this.qdrant) {
      try { await this.qdrant.deleteGlobalMemoryVector(id); } catch { /* non-fatal */ }
    }
    return deleted;
  }

  async findSimilarGlobalMemory(embedding: number[], threshold?: number): Promise<{ id: number; content: string; similarity: number } | null> {
    const thresh = threshold ?? 0.92;
    if (this.vectorBackend === 'qdrant' && this.qdrant) {
      try {
        const results = await this.qdrant.findSimilarWithContent('global_memories', embedding, 3, thresh);
        if (results.length > 0 && results[0].similarity >= thresh) {
          return { id: results[0].id, content: results[0].content, similarity: results[0].similarity };
        }
        if (results.length === 0 && this.backend === 'postgresql' && this.postgres) {
          const qr = await this.qdrant.searchGlobalMemories(embedding, 3, thresh);
          if (qr.length > 0) {
            const pgRows = await this.postgres.getMemoriesByIds(qr.map(r => r.id), { excludeInvalidated: false });
            if (pgRows.length > 0) {
              const score = qr.find(r => r.id === pgRows[0].id)?.similarity ?? 0;
              if (score >= thresh) return { id: pgRows[0].id, content: pgRows[0].content, similarity: score };
            }
          }
        }
      } catch (error) { console.error('[Qdrant] findSimilarGlobalMemory failed, falling back:', error); }
    }
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.findSimilarGlobalMemory(embedding, threshold);
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

  async getAllSkills(): Promise<Array<{
    id: number; name: string; description: string; source: string;
    path?: string; content?: string; skyllId?: string; usageCount: number; lastUsed?: string;
  }>> {
    if (this.backend === 'postgresql' && this.postgres) {
      const rows = await this.postgres.getAllSkills();
      return rows.map(r => ({ ...r, lastUsed: r.lastUsed ? String(r.lastUsed) : undefined, usageCount: r.usageCount }));
    }
    const { getAllSkills } = await import('../db/skills.js');
    const rows = getAllSkills();
    return rows.map(r => ({
      id: r.id, name: r.name, description: r.description, source: r.source,
      path: r.path, content: r.content, skyllId: r.skyll_id,
      usageCount: r.usage_count ?? 0, lastUsed: r.last_used,
    }));
  }

  async searchSkills(query: string, limit: number = 10): Promise<Array<{
    id: number; name: string; description: string; source: string;
    path?: string; usageCount: number;
  }>> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.searchSkills(query, limit);
    const { searchSkills } = await import('../db/skills.js');
    const rows = searchSkills(query, limit);
    return rows.map(r => ({
      id: r.id, name: r.name, description: r.description, source: r.source,
      path: r.path, usageCount: r.usage_count ?? 0,
    }));
  }

  async getSkillByName(name: string): Promise<{
    id: number; name: string; description: string; source: string;
    path?: string; content?: string; skyllId?: string;
  } | null> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getSkillByName(name);
    const { getSkillByName } = await import('../db/skills.js');
    const row = getSkillByName(name);
    if (!row) return null;
    return {
      id: row.id, name: row.name, description: row.description, source: row.source,
      path: row.path, content: row.content, skyllId: row.skyll_id,
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
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.clearExpiredSkyllCache();
    const { clearExpiredSkyllCache } = await import('../db/skills.js');
    return clearExpiredSkyllCache();
  }

  async getCachedSkyllSkill(skyllId: string): Promise<{
    id: number; name: string; description: string; content?: string;
  } | null> {
    if (this.backend === 'postgresql' && this.postgres) return this.postgres.getCachedSkyllSkill(skyllId);
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

  async getAllMemoriesForExport(): Promise<Array<{
    id: number; content: string; tags: string[]; source: string | null;
    embedding: number[] | null; type: string | null;
    quality_score: number | null; quality_factors: Record<string, number> | null;
    access_count: number; last_accessed: string | null; created_at: string;
    invalidated_by: number | null;
  }>> {
    if (this.backend === 'postgresql' && this.postgres) {
      const rows = await this.postgres.getAllMemoriesWithEmbeddings();
      return rows.map((r: any) => ({
        id: r.id, content: r.content,
        tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags ?? []),
        source: r.source ?? null, embedding: r.embedding ?? null,
        type: r.type ?? null,
        quality_score: r.qualityScore ?? r.quality_score ?? null,
        quality_factors: (() => {
          const qf = r.qualityFactors ?? r.quality_factors;
          return qf ? (typeof qf === 'string' ? JSON.parse(qf) : qf) : null;
        })(),
        access_count: r.accessCount ?? r.access_count ?? 0,
        last_accessed: r.lastAccessed ?? r.last_accessed ?? null,
        created_at: r.createdAt ?? r.created_at ?? new Date().toISOString(),
        invalidated_by: r.invalidatedBy ?? r.invalidated_by ?? null,
      }));
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const rows = db.prepare(
      `SELECT id, content, tags, source, embedding, type,
              quality_score, quality_factors, access_count, last_accessed, created_at, invalidated_by
       FROM memories ORDER BY id ASC`
    ).all() as any[];
    return rows.map((row: any) => ({
      id: row.id, content: row.content,
      tags: row.tags ? JSON.parse(row.tags) : [],
      source: row.source, type: row.type,
      embedding: row.embedding ? Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)) : null,
      quality_score: row.quality_score,
      quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
      access_count: row.access_count ?? 0, last_accessed: row.last_accessed,
      created_at: row.created_at,
      invalidated_by: row.invalidated_by ?? null,
    }));
  }

  async getAllDocumentsForExport(): Promise<Array<{
    id: number; file_path: string; chunk_index: number; content: string;
    start_line: number; end_line: number; embedding: number[] | null; created_at: string;
  }>> {
    if (this.backend === 'postgresql' && this.postgres) {
      const rows = await this.postgres.getAllDocumentsWithEmbeddings();
      return rows.map((r: any) => ({
        id: r.id, file_path: r.filePath ?? r.file_path,
        chunk_index: r.chunkIndex ?? r.chunk_index ?? 0,
        content: r.content, start_line: r.startLine ?? r.start_line ?? 0,
        end_line: r.endLine ?? r.end_line ?? 0,
        embedding: r.embedding ?? null,
        created_at: r.createdAt ?? r.created_at ?? new Date().toISOString(),
      }));
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const rows = db.prepare(
      `SELECT id, file_path, chunk_index, content, start_line, end_line, embedding, created_at
       FROM documents ORDER BY id ASC`
    ).all() as any[];
    return rows.map((row: any) => ({
      id: row.id, file_path: row.file_path, chunk_index: row.chunk_index,
      content: row.content, start_line: row.start_line, end_line: row.end_line,
      embedding: row.embedding ? Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)) : null,
      created_at: row.created_at,
    }));
  }

  async getAllMemoryLinksForExport(): Promise<Array<{
    id: number; source_id: number; target_id: number;
    relation: string; weight: number; created_at: string;
    llm_enriched: boolean;
  }>> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const { rows } = await pool.query(
        `SELECT ml.id, ml.source_id, ml.target_id, ml.relation, ml.weight,
                ml.created_at::text as created_at, COALESCE(ml.llm_enriched, 0) as llm_enriched
         FROM memory_links ml
         JOIN memories m ON ml.source_id = m.id
         WHERE LOWER(m.project_id) = $1 OR m.project_id IS NULL
         ORDER BY ml.id ASC`,
        [this.postgres.getProjectId()]
      );
      return rows.map((r: any) => ({ ...r, llm_enriched: !!r.llm_enriched }));
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const rows = db.prepare(
      `SELECT id, source_id, target_id, relation, weight, created_at,
              COALESCE(llm_enriched, 0) as llm_enriched
       FROM memory_links ORDER BY id ASC`
    ).all() as any[];
    return rows.map((r: any) => ({ ...r, llm_enriched: !!r.llm_enriched }));
  }

  async getAllCentralityForExport(): Promise<Array<{
    memory_id: number; degree: number; normalized_degree: number; updated_at: string;
  }>> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const { rows } = await pool.query(
        `SELECT mc.memory_id, mc.degree, mc.normalized_degree, mc.updated_at::text as updated_at
         FROM memory_centrality mc
         JOIN memories m ON mc.memory_id = m.id
         WHERE LOWER(m.project_id) = $1 OR m.project_id IS NULL
         ORDER BY mc.memory_id ASC`,
        [this.postgres.getProjectId()]
      );
      return rows;
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    return db.prepare(
      `SELECT memory_id, degree, normalized_degree, updated_at
       FROM memory_centrality ORDER BY memory_id ASC`
    ).all() as any[];
  }

  // ===========================================================================
  // Learning Deltas
  // ===========================================================================

  async appendLearningDelta(delta: {
    timestamp: string; source: string;
    memoriesBefore: number; memoriesAfter: number; newMemories: number;
    typesAdded: Record<string, number>; avgQualityOfNew?: number | null;
  }): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      await pool.query(
        `INSERT INTO learning_deltas (project_id, timestamp, source, memories_before, memories_after, new_memories, types_added, avg_quality)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          this.postgres.getProjectId(),
          delta.timestamp, delta.source,
          delta.memoriesBefore, delta.memoriesAfter, delta.newMemories,
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
      delta.timestamp, delta.source,
      delta.memoriesBefore, delta.memoriesAfter, delta.newMemories,
      Object.keys(delta.typesAdded).length > 0 ? JSON.stringify(delta.typesAdded) : null,
      delta.avgQualityOfNew ?? null,
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

  async getLearningDeltas(options: {
    limit?: number; since?: string;
  } = {}): Promise<Array<{
    id: number; timestamp: string; source: string;
    memories_before: number; memories_after: number; new_memories: number;
    types_added: string | null; avg_quality: number | null; created_at: string;
  }>> {
    const limit = options.limit && options.limit > 0 ? options.limit : 20;

    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const params: any[] = [this.postgres.getProjectId()];
      let sql = `SELECT id, timestamp::text as timestamp, source, memories_before, memories_after,
                        new_memories, types_added, avg_quality, created_at::text as created_at
                 FROM learning_deltas WHERE project_id = $1`;
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
    return db.prepare(sql).all(...params) as any[];
  }

  // ===========================================================================
  // AI Readiness Stats
  // ===========================================================================

  async getCodeFileCount(): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT file_path) as count FROM documents WHERE project_id = $1 AND file_path LIKE 'code:%'`,
        [this.postgres.getProjectId()]
      );
      return parseInt(rows[0]?.count ?? '0');
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const row = db.prepare(`SELECT COUNT(DISTINCT file_path) as count FROM documents WHERE file_path LIKE 'code:%'`).get() as { count: number };
    return row.count;
  }

  async getDocsFileCount(): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT file_path) as count FROM documents WHERE project_id = $1 AND file_path NOT LIKE 'code:%'`,
        [this.postgres.getProjectId()]
      );
      return parseInt(rows[0]?.count ?? '0');
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const row = db.prepare(`SELECT COUNT(DISTINCT file_path) as count FROM documents WHERE file_path NOT LIKE 'code:%'`).get() as { count: number };
    return row.count;
  }

  async getAverageMemoryQuality(): Promise<{ avg: number | null; count: number }> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const { rows } = await pool.query(
        `SELECT AVG(quality_score) as avg, COUNT(*) as count FROM memories WHERE project_id = $1 AND quality_score IS NOT NULL`,
        [this.postgres.getProjectId()]
      );
      return { avg: rows[0]?.avg ? parseFloat(rows[0].avg) : null, count: parseInt(rows[0]?.count ?? '0') };
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const row = db.prepare(`SELECT AVG(quality_score) as avg, COUNT(*) as count FROM memories WHERE quality_score IS NOT NULL`).get() as { avg: number | null; count: number };
    return { avg: row.avg, count: row.count };
  }

  // ===========================================================================
  // Filtered Memory Export (for agents-md-generator)
  // ===========================================================================

  async getMemoriesForAgentsExport(options: {
    types: string[]; minQuality: number; limit: number;
  }): Promise<Array<{
    id: number; content: string; type: string | null; tags: string[];
    source: string | null; quality_score: number | null; created_at: string;
  }>> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const typePlaceholders = options.types.map((_, i) => `$${i + 2}`).join(', ');
      const { rows } = await pool.query(
        `SELECT id, content, type, tags, source, quality_score, created_at::text as created_at
         FROM memories
         WHERE project_id = $1
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
    const rows = db.prepare(
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
    ).all(...options.types, options.minQuality, options.limit) as any[];
    return rows.map((r: any) => ({
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
  }): Promise<Array<{
    id: number; content: string; tags: string[]; source: string | null;
    embedding: number[] | null; type: string | null;
    quality_score: number | null; created_at: string;
    invalidated_by: number | null;
  }>> {
    if (this.backend === 'postgresql' && this.postgres) {
      const rows = await this.postgres.getAllMemoriesWithEmbeddings();
      let result = rows.map((r: any) => ({
        id: r.id, content: r.content,
        tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags ?? []),
        source: r.source ?? null, embedding: r.embedding ?? null,
        type: r.type ?? null,
        quality_score: r.qualityScore ?? r.quality_score ?? null,
        created_at: r.createdAt ?? r.created_at ?? new Date().toISOString(),
        invalidated_by: r.invalidatedBy ?? r.invalidated_by ?? null,
      }));
      if (options?.excludeInvalidated) result = result.filter(r => r.invalidated_by == null);
      if (options?.types?.length) result = result.filter(r => r.type != null && options.types!.includes(r.type));
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
    const rows = db.prepare(sql).all(...params) as any[];
    return rows.map((row: any) => ({
      id: row.id, content: row.content,
      tags: row.tags ? JSON.parse(row.tags) : [],
      source: row.source, embedding: row.embedding
        ? Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4))
        : null,
      type: row.type, quality_score: row.quality_score,
      created_at: row.created_at,
      invalidated_by: row.invalidated_by ?? null,
    }));
  }

  async deleteMemoryLinksForMemory(memoryId: number): Promise<number> {
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const result = await pool.query(
        'DELETE FROM memory_links WHERE (source_id = $1 OR target_id = $1) AND project_id = $2',
        [memoryId, this.postgres.getProjectId()]
      );
      return result.rowCount ?? 0;
    }
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const result = db.prepare(
      'DELETE FROM memory_links WHERE source_id = ? OR target_id = ?'
    ).run(memoryId, memoryId);
    return result.changes;
  }

  // ===========================================================================
  // Backend Info
  // ===========================================================================

  getBackendInfo(): { backend: 'sqlite' | 'postgresql'; vector: 'builtin' | 'qdrant'; vectorName: string } {
    return {
      backend: this.backend,
      vector: this.vectorBackend,
      vectorName: this.vectorBackend === 'qdrant' ? 'qdrant' : this.backend === 'postgresql' ? 'pgvector' : 'sqlite-vec',
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
    const log = options?.onProgress ?? (() => {});
    const dryRun = options?.dryRun ?? false;

    if (this.vectorBackend !== 'qdrant' || !this.qdrant) {
      throw new Error('Qdrant is not configured. Set storage.vector = "qdrant" in config.');
    }

    const stats = { memories: 0, globalMemories: 0, documents: 0 };

    if (target === 'memories' || target === 'all') {
      stats.memories = await this.backfillMemories(log, dryRun);
    }
    if (target === 'global_memories' || target === 'all') {
      stats.globalMemories = await this.backfillGlobalMemories(log, dryRun);
    }
    if (target === 'documents' || target === 'all') {
      stats.documents = await this.backfillDocuments(log, dryRun);
    }

    return stats;
  }

  private async backfillMemories(log: (msg: string) => void, dryRun: boolean): Promise<number> {
    if (!this.qdrant?.hasHybridSearch('memories')) {
      log('Skipping memories: Qdrant hybrid schema not available');
      return 0;
    }

    const projectId = this.qdrant.getProjectId();

    if (this.backend === 'postgresql' && this.postgres) {
      const rows = await this.postgres.getAllMemoriesWithEmbeddings();
      log(`Found ${rows.length} memories in PostgreSQL`);
      if (dryRun || rows.length === 0) return rows.length;

      const items = rows
        .filter(r => r.embedding?.length > 0)
        .map(r => ({ id: r.id, embedding: r.embedding, meta: { ...r, projectId } }));

      log(`Upserting ${items.length} memories to Qdrant...`);
      await this.qdrant!.upsertMemoriesBatchWithPayload(items);
      log(`Done: ${items.length} memories synced`);
      return items.length;
    }

    // SQLite path
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const rows = db.prepare(
      `SELECT m.id, m.content, m.tags, m.source, m.type,
              m.quality_score, m.access_count, m.created_at, m.last_accessed,
              m.valid_from, m.valid_until, m.invalidated_by,
              v.embedding
       FROM memories m
       LEFT JOIN memory_vec_mapping mv ON mv.memory_id = m.id
       LEFT JOIN memory_vec v ON v.rowid = mv.vec_rowid
       ORDER BY m.id`
    ).all() as any[];

    log(`Found ${rows.length} memories in SQLite`);
    if (dryRun || rows.length === 0) return rows.length;

    const items = rows
      .filter((r: any) => r.embedding)
      .map((r: any) => ({
        id: r.id,
        embedding: Array.from(new Float32Array(r.embedding.buffer ?? r.embedding)),
        meta: {
          content: r.content,
          tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags ?? []),
          source: r.source,
          type: r.type,
          projectId,
          createdAt: r.created_at ?? new Date().toISOString(),
          validFrom: r.valid_from,
          validUntil: r.valid_until,
          invalidatedBy: r.invalidated_by,
          accessCount: r.access_count ?? 0,
          lastAccessed: r.last_accessed,
          qualityScore: r.quality_score,
        },
      }));

    log(`Upserting ${items.length} memories to Qdrant...`);
    await this.qdrant!.upsertMemoriesBatchWithPayload(items);
    log(`Done: ${items.length} memories synced`);
    return items.length;
  }

  private async backfillGlobalMemories(log: (msg: string) => void, dryRun: boolean): Promise<number> {
    if (!this.qdrant?.hasHybridSearch('global_memories')) {
      log('Skipping global memories: Qdrant hybrid schema not available');
      return 0;
    }

    // PostgreSQL: global memories are rows with project_id IS NULL
    if (this.backend === 'postgresql' && this.postgres) {
      const pool = await this.postgres.getPool();
      const { rows } = await pool.query(
        `SELECT id, content, embedding::text, tags, source, type,
                quality_score, access_count,
                created_at::text as created_at,
                last_accessed::text as last_accessed,
                valid_from::text as valid_from,
                valid_until::text as valid_until,
                invalidated_by
         FROM memories WHERE project_id IS NULL ORDER BY id`
      );

      log(`Found ${rows.length} global memories in PostgreSQL`);
      if (dryRun || rows.length === 0) return rows.length;

      const items = rows
        .filter((r: any) => r.embedding)
        .map((r: any) => ({
          id: r.id,
          embedding: parsePgVector(r.embedding),
          meta: {
            content: r.content,
            tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags ?? []),
            source: r.source,
            type: r.type,
            projectId: null,
            createdAt: r.created_at ?? new Date().toISOString(),
            validFrom: r.valid_from,
            validUntil: r.valid_until,
            invalidatedBy: r.invalidated_by,
            accessCount: r.access_count ?? 0,
            lastAccessed: r.last_accessed,
            qualityScore: r.quality_score,
          },
        }));

      log(`Upserting ${items.length} global memories to Qdrant...`);
      await this.qdrant!.upsertGlobalMemoriesBatchWithPayload(items);
      log(`Done: ${items.length} global memories synced`);
      return items.length;
    }

    // SQLite: global memories in separate DB
    const sqlite = await this.getSqliteFns();
    const gdb = sqlite.getGlobalDb();

    // Check if vec tables exist (they may not if sqlite-vec was never initialized)
    let rows: any[];
    try {
      rows = gdb.prepare(
        `SELECT m.id, m.content, m.tags, m.source, m.type,
                m.quality_score, m.access_count, m.created_at, m.last_accessed,
                m.valid_from, m.valid_until, m.invalidated_by,
                v.embedding
         FROM memories m
         LEFT JOIN memory_vec_mapping mv ON mv.memory_id = m.id
         LEFT JOIN memory_vec v ON v.rowid = mv.vec_rowid
         ORDER BY m.id`
      ).all() as any[];
    } catch {
      // sqlite-vec tables may not exist — fall back to memory-only query (no embeddings)
      log('Global DB has no vector tables — fetching memories without embeddings');
      rows = gdb.prepare(
        `SELECT id, content, tags, source, type,
                quality_score, access_count, created_at, last_accessed,
                valid_from, valid_until, invalidated_by
         FROM memories ORDER BY id`
      ).all() as any[];
    }

    log(`Found ${rows.length} global memories in SQLite`);
    if (dryRun || rows.length === 0) return rows.length;

    const items = rows
      .filter((r: any) => r.embedding)
      .map((r: any) => ({
        id: r.id,
        embedding: Array.from(new Float32Array(r.embedding.buffer ?? r.embedding)),
        meta: {
          content: r.content,
          tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags ?? []),
          source: r.source,
          type: r.type,
          projectId: null,
          createdAt: r.created_at ?? new Date().toISOString(),
          validFrom: r.valid_from,
          validUntil: r.valid_until,
          invalidatedBy: r.invalidated_by,
          accessCount: r.access_count ?? 0,
          lastAccessed: r.last_accessed,
          qualityScore: r.quality_score,
        },
      }));

    log(`Upserting ${items.length} global memories to Qdrant...`);
    await this.qdrant!.upsertGlobalMemoriesBatchWithPayload(items);
    log(`Done: ${items.length} global memories synced`);
    return items.length;
  }

  private async backfillDocuments(log: (msg: string) => void, dryRun: boolean): Promise<number> {
    if (!this.qdrant?.hasHybridSearch('documents')) {
      log('Skipping documents: Qdrant hybrid schema not available');
      return 0;
    }

    const projectId = this.qdrant!.getProjectId() ?? '';

    if (this.backend === 'postgresql' && this.postgres) {
      const rows = await this.postgres.getAllDocumentsWithEmbeddings();
      log(`Found ${rows.length} documents in PostgreSQL`);
      if (dryRun || rows.length === 0) return rows.length;

      const items = rows
        .filter(r => r.embedding?.length > 0)
        .map(r => ({ id: r.id, embedding: r.embedding, meta: r }));

      log(`Upserting ${items.length} documents to Qdrant...`);
      await this.qdrant!.upsertDocumentsBatchWithPayload(items);
      log(`Done: ${items.length} documents synced`);
      return items.length;
    }

    // SQLite path
    const sqlite = await this.getSqliteFns();
    const db = sqlite.getDb();
    const rows = db.prepare(
      `SELECT d.id, d.file_path, d.content, d.start_line, d.end_line,
              v.embedding
       FROM documents d
       LEFT JOIN document_vec_mapping dm ON dm.document_id = d.id
       LEFT JOIN document_vec v ON v.rowid = dm.vec_rowid
       ORDER BY d.id`
    ).all() as any[];

    log(`Found ${rows.length} documents in SQLite`);
    if (dryRun || rows.length === 0) return rows.length;

    const items = rows
      .filter((r: any) => r.embedding)
      .map((r: any) => ({
        id: r.id,
        embedding: Array.from(new Float32Array(r.embedding.buffer ?? r.embedding)),
        meta: {
          filePath: r.file_path,
          content: r.content,
          startLine: r.start_line,
          endLine: r.end_line,
          projectId,
        } as import('./vector/qdrant.js').DocumentUpsertMeta,
      }));

    log(`Upserting ${items.length} documents to Qdrant...`);
    await this.qdrant!.upsertDocumentsBatchWithPayload(items);
    log(`Done: ${items.length} documents synced`);
    return items.length;
  }
}

/** Parse pgvector string '[1.0, 2.0, 3.0]' to number[] */
function parsePgVector(str: string): number[] {
  const inner = str.slice(1, -1);
  if (!inner) return [];
  return inner.split(',').map(s => parseFloat(s.trim()));
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
