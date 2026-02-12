/**
 * Qdrant vector store implementation — Approach C: Full Hybrid Search.
 *
 * When Qdrant is configured (storage.vector = "qdrant"), it becomes the
 * single search engine for ALL backends (SQLite + Qdrant, PgSQL + Qdrant).
 *
 * Uses Qdrant's built-in server-side BM25 (Qdrant/bm25 model) + dense vectors
 * + RRF (Reciprocal Rank Fusion) — all in a single API call.
 *
 * Collections (named vectors):
 * - {prefix}documents — dense (384d) + bm25 sparse
 * - {prefix}memories — dense (384d) + bm25 sparse
 * - {prefix}global_memories — dense (384d) + bm25 sparse
 *
 * Payloads store full metadata so search results can be returned
 * without a second round-trip to PG/SQLite.
 */

import type { VectorStore } from './interface.js';
import type { VectorSearchResult, VectorItem, StorageConfig, Memory, MemoryType } from '../types.js';

// Lazy-load qdrant client
let QdrantClient: any = null;

import { logWarn } from '../../fault-logger.js';

async function loadQdrant(): Promise<any> {
  if (QdrantClient) return QdrantClient;
  try {
    const module = await import('@qdrant/js-client-rest');
    QdrantClient = module.QdrantClient;
    return QdrantClient;
  } catch {
    throw new Error(
      'Qdrant support requires the "@qdrant/js-client-rest" package. ' +
      'Install it with: npm install @qdrant/js-client-rest'
    );
  }
}

export interface QdrantConfig {
  url?: string;
  apiKey?: string;
  collectionPrefix?: string;
  /** HNSW ef parameter for search (higher = more accurate but slower). Default: 128 */
  searchEf?: number;
  /** Enable scalar quantization for faster search. Default: true */
  useQuantization?: boolean;
  /** Project ID for scoping memories. NULL = global. */
  projectId?: string;
}

// ============================================================================
// Payload Types (what we store alongside vectors in Qdrant)
// ============================================================================

export interface DocumentPayload {
  doc_type: 'code' | 'doc';
  file_path: string;
  content: string;
  start_line: number;
  end_line: number;
  project_id: string;
}

export interface MemoryPayload {
  content: string;
  tags: string[];
  source: string | null;
  type: string | null;
  project_id: string | null;
  created_at: string;
  valid_from: string | null;
  valid_until: string | null;
  invalidated_by: number | null;
  access_count: number;
  last_accessed: string | null;
  quality_score: number | null;
}

// ============================================================================
// Metadata passed from dispatcher for upserts
// ============================================================================

export interface DocumentUpsertMeta {
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  projectId: string;
}

export interface MemoryUpsertMeta {
  content: string;
  tags: string[];
  source?: string | null;
  type?: string | null;
  projectId?: string | null;
  createdAt: string;
  validFrom?: string | null;
  validUntil?: string | null;
  // Extended fields for backfill (preserve existing data)
  invalidatedBy?: number | null;
  accessCount?: number;
  lastAccessed?: string | null;
  qualityScore?: number | null;
}

// ============================================================================
// Hybrid Search Result Types
// ============================================================================

export interface QdrantDocumentResult {
  id: number;
  file_path: string;
  content: string;
  start_line: number;
  end_line: number;
  similarity: number;
  bm25Score: number;
  vectorScore: number;
}

export interface QdrantMemoryResult extends Memory {
  similarity: number;
}

// ============================================================================
// QdrantVectorStore — Approach C
// ============================================================================

export class QdrantVectorStore implements VectorStore {
  private client: any = null;
  private config: QdrantConfig;
  private dimensions: number = 384;
  private prefix: string;
  private searchEf: number;
  private useQuantization: boolean;
  private projectId: string | null = null;
  private initialized: { documents: boolean; memories: boolean; globalMemories: boolean } = {
    documents: false,
    memories: false,
    globalMemories: false,
  };
  /** Track whether collections have the new multi-vector schema */
  private hasMultiVectorSchema: { documents: boolean; memories: boolean; globalMemories: boolean } = {
    documents: false,
    memories: false,
    globalMemories: false,
  };

  constructor(config: QdrantConfig) {
    this.config = config;
    this.prefix = config.collectionPrefix ?? 'succ_';
    this.searchEf = config.searchEf ?? 128;
    this.useQuantization = config.useQuantization ?? true;
    this.projectId = config.projectId ?? null;
  }

  setProjectId(projectId: string | null): void {
    this.projectId = projectId;
  }

  getProjectId(): string | null {
    return this.projectId;
  }

  private async getClient(): Promise<any> {
    if (this.client) return this.client;

    const ClientClass = await loadQdrant();
    this.client = new ClientClass({
      url: this.config.url ?? 'http://localhost:6333',
      apiKey: this.config.apiKey,
    });

    return this.client;
  }

  private collectionName(type: 'documents' | 'memories' | 'global_memories'): string {
    return `${this.prefix}${type}`;
  }

  private initKey(type: 'documents' | 'memories' | 'global_memories'): 'documents' | 'memories' | 'globalMemories' {
    return type === 'global_memories' ? 'globalMemories' : type;
  }

  async init(dimensions: number): Promise<void> {
    this.dimensions = dimensions;
    await this.getClient();

    await this.ensureCollection('documents');
    await this.ensureCollection('memories');
    await this.ensureCollection('global_memories');
  }

  // ==========================================================================
  // Collection Management — Multi-Vector Schema
  // ==========================================================================

  private async ensureCollection(type: 'documents' | 'memories' | 'global_memories'): Promise<void> {
    const client = await this.getClient();
    const name = this.collectionName(type);
    const key = this.initKey(type);

    try {
      const info = await client.getCollection(name);

      // Check if collection has the new multi-vector schema (named vectors)
      // Old schema: info.config.params.vectors.size (unnamed)
      // New schema: info.config.params.vectors.dense.size (named)
      const vectors = info.config?.params?.vectors;
      if (vectors && typeof vectors === 'object' && 'dense' in vectors) {
        // Has new schema with named vectors
        this.hasMultiVectorSchema[key] = true;
      } else {
        // Old unnamed-vector schema — needs migration
        logWarn('qdrant', `Collection "${name}" uses old single-vector schema. Deleting and recreating with multi-vector schema. Re-indexing required.`);
        await client.deleteCollection(name);
        await this.createMultiVectorCollection(name, type);
        this.hasMultiVectorSchema[key] = true;
      }

      this.initialized[key] = true;
    } catch (e: any) {
      // Collection doesn't exist, create it
      if (e.status === 404 || e.message?.includes('Not found')) {
        await this.createMultiVectorCollection(name, type);
        this.hasMultiVectorSchema[key] = true;
        this.initialized[key] = true;
      } else {
        throw e;
      }
    }
  }

  private async createMultiVectorCollection(
    name: string,
    type: 'documents' | 'memories' | 'global_memories'
  ): Promise<void> {
    const client = await this.getClient();

    const collectionConfig: any = {
      vectors: {
        dense: {
          size: this.dimensions,
          distance: 'Cosine',
        },
      },
      sparse_vectors: {
        bm25: {
          modifier: 'idf',
        },
      },
      hnsw_config: {
        m: 16,
        ef_construct: 100,
      },
    };

    if (this.useQuantization) {
      collectionConfig.quantization_config = {
        scalar: {
          type: 'int8',
          always_ram: true,
        },
      };
    }

    await client.createCollection(name, collectionConfig);

    // Create payload indexes for fast filtering
    await this.createPayloadIndexes(name, type);
  }

  private async createPayloadIndexes(
    name: string,
    type: 'documents' | 'memories' | 'global_memories'
  ): Promise<void> {
    const client = await this.getClient();

    if (type === 'documents') {
      await client.createPayloadIndex(name, { field_name: 'doc_type', field_schema: 'keyword' });
      await client.createPayloadIndex(name, { field_name: 'project_id', field_schema: 'keyword' });
    } else {
      // memories + global_memories
      await client.createPayloadIndex(name, { field_name: 'project_id', field_schema: 'keyword' });
      await client.createPayloadIndex(name, { field_name: 'invalidated_by', field_schema: 'integer' });
      await client.createPayloadIndex(name, { field_name: 'created_at', field_schema: 'keyword' });
      await client.createPayloadIndex(name, { field_name: 'tags', field_schema: 'keyword' });
      await client.createPayloadIndex(name, { field_name: 'type', field_schema: 'keyword' });
    }
  }

  async close(): Promise<void> {
    this.client = null;
    this.initialized = { documents: false, memories: false, globalMemories: false };
    this.hasMultiVectorSchema = { documents: false, memories: false, globalMemories: false };
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  /** Check if a collection has the multi-vector schema (BM25 + dense). */
  hasHybridSearch(type: 'documents' | 'memories' | 'global_memories' = 'documents'): boolean {
    return this.hasMultiVectorSchema[this.initKey(type)];
  }

  // ==========================================================================
  // Document Vectors — VectorStore interface (legacy, backward compat)
  // ==========================================================================

  async upsertDocumentVector(id: number, embedding: number[]): Promise<void> {
    const client = await this.getClient();
    const name = this.collectionName('documents');

    if (this.hasMultiVectorSchema.documents) {
      // Multi-vector: use named vector, minimal payload
      await client.upsert(name, {
        points: [{
          id,
          vector: { dense: embedding },
          payload: { doc_type: 'doc', project_id: this.projectId ?? '' },
        }],
      });
    } else {
      // Fallback: unnamed vector
      await client.upsert(name, {
        points: [{ id, vector: embedding, payload: { type: 'document' } }],
      });
    }
  }

  async upsertDocumentVectorsBatch(items: VectorItem[]): Promise<void> {
    if (items.length === 0) return;

    const client = await this.getClient();
    const name = this.collectionName('documents');
    const batchSize = 100;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      if (this.hasMultiVectorSchema.documents) {
        await client.upsert(name, {
          points: batch.map(item => ({
            id: item.id,
            vector: { dense: item.embedding },
            payload: { doc_type: 'doc', project_id: this.projectId ?? '' },
          })),
        });
      } else {
        await client.upsert(name, {
          points: batch.map(item => ({
            id: item.id,
            vector: item.embedding,
            payload: { type: 'document' },
          })),
        });
      }
    }
  }

  async deleteDocumentVector(id: number): Promise<void> {
    const client = await this.getClient();
    await client.delete(this.collectionName('documents'), { points: [id] });
  }

  async deleteDocumentVectorsByIds(docIds: number[]): Promise<void> {
    if (docIds.length === 0) return;
    const client = await this.getClient();
    await client.delete(this.collectionName('documents'), { points: docIds });
  }

  async searchDocuments(query: number[], limit: number, threshold: number): Promise<VectorSearchResult[]> {
    const client = await this.getClient();
    const name = this.collectionName('documents');

    if (this.hasMultiVectorSchema.documents) {
      // Dense-only search (no query text for BM25)
      const results = await client.query(name, {
        query: query,
        using: 'dense',
        limit,
        score_threshold: threshold,
        params: { hnsw_ef: this.searchEf, exact: false },
        with_payload: false,
      });
      return (results.points ?? results).map((r: any) => ({
        id: typeof r.id === 'number' ? r.id : parseInt(r.id),
        similarity: r.score,
      }));
    }

    // Fallback: unnamed vector
    const results = await client.search(name, {
      vector: query,
      limit,
      score_threshold: threshold,
      params: { hnsw_ef: this.searchEf, exact: false },
    });
    return results.map((r: any) => ({
      id: typeof r.id === 'number' ? r.id : parseInt(r.id),
      similarity: r.score,
    }));
  }

  // ==========================================================================
  // Memory Vectors — VectorStore interface (legacy, backward compat)
  // ==========================================================================

  async upsertMemoryVector(id: number, embedding: number[], projectId?: string): Promise<void> {
    const client = await this.getClient();
    const name = this.collectionName('memories');
    const pid = projectId ?? this.projectId;

    if (this.hasMultiVectorSchema.memories) {
      await client.upsert(name, {
        points: [{
          id,
          vector: { dense: embedding },
          payload: { project_id: pid, type: 'memory' },
        }],
      });
    } else {
      await client.upsert(name, {
        points: [{
          id,
          vector: embedding,
          payload: { type: 'memory', project_id: pid },
        }],
      });
    }
  }

  async deleteMemoryVector(id: number): Promise<void> {
    const client = await this.getClient();
    await client.delete(this.collectionName('memories'), { points: [id] });
  }

  async searchMemories(
    query: number[],
    limit: number,
    threshold: number,
    options?: { projectId?: string | null; includeGlobal?: boolean }
  ): Promise<VectorSearchResult[]> {
    const client = await this.getClient();
    const name = this.collectionName('memories');
    const projectId = options?.projectId ?? this.projectId;
    const includeGlobal = options?.includeGlobal ?? true;

    let filter: any = undefined;
    if (projectId) {
      if (includeGlobal) {
        filter = {
          should: [
            { key: 'project_id', match: { value: projectId } },
            { is_null: { key: 'project_id' } },
          ],
        };
      } else {
        filter = { must: [{ key: 'project_id', match: { value: projectId } }] };
      }
    } else {
      filter = { must: [{ is_null: { key: 'project_id' } }] };
    }

    if (this.hasMultiVectorSchema.memories) {
      const results = await client.query(name, {
        query: query,
        using: 'dense',
        limit,
        score_threshold: threshold,
        filter,
        params: { hnsw_ef: this.searchEf, exact: false },
        with_payload: false,
      });
      return (results.points ?? results).map((r: any) => ({
        id: typeof r.id === 'number' ? r.id : parseInt(r.id),
        similarity: r.score,
      }));
    }

    const results = await client.search(name, {
      vector: query,
      limit,
      score_threshold: threshold,
      filter,
      params: { hnsw_ef: this.searchEf, exact: false },
    });
    return results.map((r: any) => ({
      id: typeof r.id === 'number' ? r.id : parseInt(r.id),
      similarity: r.score,
    }));
  }

  // ==========================================================================
  // Global Memory Vectors — VectorStore interface (legacy, backward compat)
  // ==========================================================================

  async upsertGlobalMemoryVector(id: number, embedding: number[]): Promise<void> {
    const client = await this.getClient();
    const name = this.collectionName('global_memories');

    if (this.hasMultiVectorSchema.globalMemories) {
      await client.upsert(name, {
        points: [{
          id,
          vector: { dense: embedding },
          payload: { type: 'global_memory' },
        }],
      });
    } else {
      await client.upsert(name, {
        points: [{ id, vector: embedding, payload: { type: 'global_memory' } }],
      });
    }
  }

  async deleteGlobalMemoryVector(id: number): Promise<void> {
    const client = await this.getClient();
    await client.delete(this.collectionName('global_memories'), { points: [id] });
  }

  async searchGlobalMemories(query: number[], limit: number, threshold: number): Promise<VectorSearchResult[]> {
    const client = await this.getClient();
    const name = this.collectionName('global_memories');

    if (this.hasMultiVectorSchema.globalMemories) {
      const results = await client.query(name, {
        query: query,
        using: 'dense',
        limit,
        score_threshold: threshold,
        params: { hnsw_ef: this.searchEf, exact: false },
        with_payload: false,
      });
      return (results.points ?? results).map((r: any) => ({
        id: typeof r.id === 'number' ? r.id : parseInt(r.id),
        similarity: r.score,
      }));
    }

    const results = await client.search(name, {
      vector: query,
      limit,
      score_threshold: threshold,
      params: { hnsw_ef: this.searchEf, exact: false },
    });
    return results.map((r: any) => ({
      id: typeof r.id === 'number' ? r.id : parseInt(r.id),
      similarity: r.score,
    }));
  }

  // ==========================================================================
  // Maintenance — VectorStore interface
  // ==========================================================================

  async rebuildDocumentVectors(items: VectorItem[]): Promise<void> {
    const client = await this.getClient();
    const name = this.collectionName('documents');

    try {
      await client.delete(name, {
        filter: { must: [{ key: 'doc_type', match: { value: 'code' } }] },
      });
      await client.delete(name, {
        filter: { must: [{ key: 'doc_type', match: { value: 'doc' } }] },
      });
    } catch {
      // Collection might be empty
    }

    await this.upsertDocumentVectorsBatch(items);
  }

  async rebuildMemoryVectors(items: VectorItem[]): Promise<void> {
    const client = await this.getClient();
    const name = this.collectionName('memories');

    try {
      await client.delete(name, {
        filter: { must: [{ has_id: items.map(i => i.id) }] },
      });
    } catch {
      // Ignore
    }

    const batchSize = 100;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      if (this.hasMultiVectorSchema.memories) {
        await client.upsert(name, {
          points: batch.map(item => ({
            id: item.id,
            vector: { dense: item.embedding },
            payload: { type: 'memory' },
          })),
        });
      } else {
        await client.upsert(name, {
          points: batch.map(item => ({
            id: item.id,
            vector: item.embedding,
            payload: { type: 'memory' },
          })),
        });
      }
    }
  }

  async rebuildGlobalMemoryVectors(items: VectorItem[]): Promise<void> {
    const client = await this.getClient();
    const name = this.collectionName('global_memories');

    try {
      await client.delete(name, {
        filter: { must: [{ has_id: items.map(i => i.id) }] },
      });
    } catch {
      // Ignore
    }

    const batchSize = 100;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      if (this.hasMultiVectorSchema.globalMemories) {
        await client.upsert(name, {
          points: batch.map(item => ({
            id: item.id,
            vector: { dense: item.embedding },
            payload: { type: 'global_memory' },
          })),
        });
      } else {
        await client.upsert(name, {
          points: batch.map(item => ({
            id: item.id,
            vector: item.embedding,
            payload: { type: 'global_memory' },
          })),
        });
      }
    }
  }

  // ==========================================================================
  // NEW: Full-Payload Upserts (Approach C)
  // ==========================================================================

  /**
   * Upsert a document with full payload + BM25 text for hybrid search.
   * Called from dispatcher when Qdrant is configured.
   */
  async upsertDocumentWithPayload(
    id: number,
    embedding: number[],
    meta: DocumentUpsertMeta
  ): Promise<void> {
    const client = await this.getClient();
    const name = this.collectionName('documents');
    const docType = meta.filePath.startsWith('code:') ? 'code' : 'doc';

    await client.upsert(name, {
      points: [{
        id,
        vector: {
          dense: embedding,
          bm25: { text: meta.content, model: 'Qdrant/bm25' },
        },
        payload: {
          doc_type: docType,
          file_path: meta.filePath,
          content: meta.content,
          start_line: meta.startLine,
          end_line: meta.endLine,
          project_id: meta.projectId,
        } satisfies DocumentPayload,
      }],
    });
  }

  /**
   * Batch upsert documents with full payload + BM25 text.
   */
  async upsertDocumentsBatchWithPayload(
    items: Array<{ id: number; embedding: number[]; meta: DocumentUpsertMeta }>
  ): Promise<void> {
    if (items.length === 0) return;

    const client = await this.getClient();
    const name = this.collectionName('documents');
    const batchSize = 100;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await client.upsert(name, {
        points: batch.map(item => {
          const docType = item.meta.filePath.startsWith('code:') ? 'code' : 'doc';
          return {
            id: item.id,
            vector: {
              dense: item.embedding,
              bm25: { text: item.meta.content, model: 'Qdrant/bm25' },
            },
            payload: {
              doc_type: docType,
              file_path: item.meta.filePath,
              content: item.meta.content,
              start_line: item.meta.startLine,
              end_line: item.meta.endLine,
              project_id: item.meta.projectId,
            } satisfies DocumentPayload,
          };
        }),
      });
    }
  }

  /**
   * Upsert a memory with full payload + BM25 text for hybrid search.
   */
  async upsertMemoryWithPayload(
    id: number,
    embedding: number[],
    meta: MemoryUpsertMeta
  ): Promise<void> {
    const client = await this.getClient();
    const name = this.collectionName('memories');

    await client.upsert(name, {
      points: [{
        id,
        vector: {
          dense: embedding,
          bm25: { text: meta.content, model: 'Qdrant/bm25' },
        },
        payload: {
          content: meta.content,
          tags: meta.tags,
          source: meta.source ?? null,
          type: meta.type ?? null,
          project_id: meta.projectId ?? null,
          created_at: meta.createdAt,
          valid_from: meta.validFrom ?? null,
          valid_until: meta.validUntil ?? null,
          invalidated_by: null,
          access_count: 0,
          last_accessed: null,
          quality_score: null,
        } satisfies MemoryPayload,
      }],
    });
  }

  /**
   * Upsert a global memory with full payload + BM25 text.
   */
  async upsertGlobalMemoryWithPayload(
    id: number,
    embedding: number[],
    meta: MemoryUpsertMeta
  ): Promise<void> {
    const client = await this.getClient();
    const name = this.collectionName('global_memories');

    await client.upsert(name, {
      points: [{
        id,
        vector: {
          dense: embedding,
          bm25: { text: meta.content, model: 'Qdrant/bm25' },
        },
        payload: {
          content: meta.content,
          tags: meta.tags,
          source: meta.source ?? null,
          type: meta.type ?? null,
          project_id: null,
          created_at: meta.createdAt,
          valid_from: meta.validFrom ?? null,
          valid_until: meta.validUntil ?? null,
          invalidated_by: null,
          access_count: 0,
          last_accessed: null,
          quality_score: null,
        } satisfies MemoryPayload,
      }],
    });
  }

  /**
   * Batch upsert memories with full payload + BM25 text.
   */
  async upsertMemoriesBatchWithPayload(
    items: Array<{ id: number; embedding: number[]; meta: MemoryUpsertMeta }>
  ): Promise<void> {
    if (items.length === 0) return;

    const client = await this.getClient();
    const name = this.collectionName('memories');
    const batchSize = 100;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await client.upsert(name, {
        points: batch.map(item => ({
          id: item.id,
          vector: {
            dense: item.embedding,
            bm25: { text: item.meta.content, model: 'Qdrant/bm25' },
          },
          payload: {
            content: item.meta.content,
            tags: item.meta.tags,
            source: item.meta.source ?? null,
            type: item.meta.type ?? null,
            project_id: item.meta.projectId ?? null,
            created_at: item.meta.createdAt,
            valid_from: item.meta.validFrom ?? null,
            valid_until: item.meta.validUntil ?? null,
            invalidated_by: item.meta.invalidatedBy ?? null,
            access_count: item.meta.accessCount ?? 0,
            last_accessed: item.meta.lastAccessed ?? null,
            quality_score: item.meta.qualityScore ?? null,
          } satisfies MemoryPayload,
        })),
      });
    }
  }

  /**
   * Batch upsert global memories with full payload + BM25 text.
   */
  async upsertGlobalMemoriesBatchWithPayload(
    items: Array<{ id: number; embedding: number[]; meta: MemoryUpsertMeta }>
  ): Promise<void> {
    if (items.length === 0) return;

    const client = await this.getClient();
    const name = this.collectionName('global_memories');
    const batchSize = 100;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await client.upsert(name, {
        points: batch.map(item => ({
          id: item.id,
          vector: {
            dense: item.embedding,
            bm25: { text: item.meta.content, model: 'Qdrant/bm25' },
          },
          payload: {
            content: item.meta.content,
            tags: item.meta.tags,
            source: item.meta.source ?? null,
            type: item.meta.type ?? null,
            project_id: null,
            created_at: item.meta.createdAt,
            valid_from: item.meta.validFrom ?? null,
            valid_until: item.meta.validUntil ?? null,
            invalidated_by: item.meta.invalidatedBy ?? null,
            access_count: item.meta.accessCount ?? 0,
            last_accessed: item.meta.lastAccessed ?? null,
            quality_score: item.meta.qualityScore ?? null,
          } satisfies MemoryPayload,
        })),
      });
    }
  }

  // ==========================================================================
  // NEW: Hybrid Search Methods (Approach C — BM25 + Dense + RRF)
  // ==========================================================================

  /**
   * Hybrid search for documents using BM25 + dense vectors + RRF fusion.
   * Returns full document data from Qdrant payload (no PG round-trip needed).
   */
  async hybridSearchDocuments(
    query: string,
    queryEmbedding: number[],
    limit: number,
    threshold: number,
    options?: { codeOnly?: boolean; docsOnly?: boolean; projectId?: string }
  ): Promise<QdrantDocumentResult[]> {
    const client = await this.getClient();
    const name = this.collectionName('documents');

    // Build filter
    const must: any[] = [];
    if (options?.codeOnly) must.push({ key: 'doc_type', match: { value: 'code' } });
    if (options?.docsOnly) must.push({ key: 'doc_type', match: { value: 'doc' } });
    if (options?.projectId) must.push({ key: 'project_id', match: { value: options.projectId } });

    const filter = must.length > 0 ? { must } : undefined;

    const results = await client.query(name, {
      prefetch: [
        {
          query: { text: query, model: 'Qdrant/bm25' },
          using: 'bm25',
          limit: limit * 3,
        },
        {
          query: queryEmbedding,
          using: 'dense',
          limit: limit * 3,
          params: { hnsw_ef: this.searchEf, exact: false },
        },
      ],
      query: { fusion: 'rrf' },
      filter,
      score_threshold: threshold,
      with_payload: true,
      limit,
    });

    const points = results.points ?? results;
    return points.map((p: any) => ({
      id: typeof p.id === 'number' ? p.id : parseInt(p.id),
      file_path: p.payload?.file_path ?? '',
      content: p.payload?.content ?? '',
      start_line: p.payload?.start_line ?? 0,
      end_line: p.payload?.end_line ?? 0,
      similarity: p.score,
      bm25Score: 0,      // RRF doesn't expose individual scores
      vectorScore: 0,
    }));
  }

  /**
   * Hybrid search for memories using BM25 + dense vectors + RRF fusion.
   * Returns full memory data from Qdrant payload.
   */
  async hybridSearchMemories(
    query: string,
    queryEmbedding: number[],
    limit: number,
    threshold: number,
    options?: {
      projectId?: string | null;
      includeGlobal?: boolean;
      tags?: string[];
      since?: Date;
      asOfDate?: Date;
      includeExpired?: boolean;
      createdBefore?: Date;
    }
  ): Promise<QdrantMemoryResult[]> {
    const client = await this.getClient();
    const name = this.collectionName('memories');
    const projectId = options?.projectId ?? this.projectId;
    const now = options?.asOfDate ?? new Date();

    const must: any[] = [];
    const should: any[] = [];

    // Soft-delete filter
    must.push({ is_null: { key: 'invalidated_by' } });

    // Project scoping
    if (projectId) {
      if (options?.includeGlobal !== false) {
        should.push({ key: 'project_id', match: { value: projectId } });
        should.push({ is_null: { key: 'project_id' } });
      } else {
        must.push({ key: 'project_id', match: { value: projectId } });
      }
    }

    // Temporal validity (unless includeExpired)
    if (!options?.includeExpired) {
      must.push({
        should: [
          { is_null: { key: 'valid_from' } },
          { key: 'valid_from', range: { lte: now.toISOString() } },
        ],
      });
      must.push({
        should: [
          { is_null: { key: 'valid_until' } },
          { key: 'valid_until', range: { gt: now.toISOString() } },
        ],
      });
    }

    // Since filter
    if (options?.since) {
      must.push({ key: 'created_at', range: { gte: options.since.toISOString() } });
    }

    // Created-before filter (for point-in-time queries)
    if (options?.createdBefore) {
      must.push({ key: 'created_at', range: { lte: options.createdBefore.toISOString() } });
    }

    // Tag filter
    if (options?.tags?.length) {
      for (const tag of options.tags) {
        must.push({ key: 'tags', match: { value: tag } });
      }
    }

    const filter: any = {};
    if (must.length) filter.must = must;
    if (should.length) filter.should = should;

    const results = await client.query(name, {
      prefetch: [
        {
          query: { text: query, model: 'Qdrant/bm25' },
          using: 'bm25',
          limit: limit * 3,
        },
        {
          query: queryEmbedding,
          using: 'dense',
          limit: limit * 3,
          params: { hnsw_ef: this.searchEf, exact: false },
        },
      ],
      query: { fusion: 'rrf' },
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      score_threshold: threshold,
      with_payload: true,
      limit,
    });

    const points = results.points ?? results;
    return points.map((p: any) => this.payloadToMemory(p));
  }

  /**
   * Hybrid search for global memories using BM25 + dense + RRF.
   */
  async hybridSearchGlobalMemories(
    query: string,
    queryEmbedding: number[],
    limit: number,
    threshold: number,
    options?: {
      tags?: string[];
      since?: Date;
      includeExpired?: boolean;
    }
  ): Promise<QdrantMemoryResult[]> {
    const client = await this.getClient();
    const name = this.collectionName('global_memories');

    const must: any[] = [];

    // Soft-delete
    must.push({ is_null: { key: 'invalidated_by' } });

    // Temporal validity
    if (!options?.includeExpired) {
      const now = new Date();
      must.push({
        should: [
          { is_null: { key: 'valid_from' } },
          { key: 'valid_from', range: { lte: now.toISOString() } },
        ],
      });
      must.push({
        should: [
          { is_null: { key: 'valid_until' } },
          { key: 'valid_until', range: { gt: now.toISOString() } },
        ],
      });
    }

    if (options?.since) {
      must.push({ key: 'created_at', range: { gte: options.since.toISOString() } });
    }

    if (options?.tags?.length) {
      for (const tag of options.tags) {
        must.push({ key: 'tags', match: { value: tag } });
      }
    }

    const filter = must.length > 0 ? { must } : undefined;

    const results = await client.query(name, {
      prefetch: [
        {
          query: { text: query, model: 'Qdrant/bm25' },
          using: 'bm25',
          limit: limit * 3,
        },
        {
          query: queryEmbedding,
          using: 'dense',
          limit: limit * 3,
          params: { hnsw_ef: this.searchEf, exact: false },
        },
      ],
      query: { fusion: 'rrf' },
      filter,
      score_threshold: threshold,
      with_payload: true,
      limit,
    });

    const points = results.points ?? results;
    return points.map((p: any) => this.payloadToMemory(p));
  }

  /**
   * Dense-only similarity search (for dedup checks — no BM25 needed).
   */
  async findSimilarVector(
    collection: 'memories' | 'global_memories',
    embedding: number[],
    limit: number,
    threshold: number,
    filter?: any
  ): Promise<VectorSearchResult[]> {
    const client = await this.getClient();
    const name = this.collectionName(collection);

    if (this.hasMultiVectorSchema[this.initKey(collection)]) {
      const results = await client.query(name, {
        query: embedding,
        using: 'dense',
        filter,
        score_threshold: threshold,
        limit,
        with_payload: false,
      });
      const points = results.points ?? results;
      return points.map((r: any) => ({
        id: typeof r.id === 'number' ? r.id : parseInt(r.id),
        similarity: r.score,
      }));
    }

    // Fallback: unnamed vector
    const results = await client.search(name, {
      vector: embedding,
      filter,
      score_threshold: threshold,
      limit,
      with_payload: false,
    });
    return results.map((r: any) => ({
      id: typeof r.id === 'number' ? r.id : parseInt(r.id),
      similarity: r.score,
    }));
  }

  /**
   * Dense-only search with payload (for dedup — returns content).
   */
  async findSimilarWithContent(
    collection: 'memories' | 'global_memories',
    embedding: number[],
    limit: number,
    threshold: number
  ): Promise<Array<{ id: number; content: string; similarity: number }>> {
    const client = await this.getClient();
    const name = this.collectionName(collection);

    if (this.hasMultiVectorSchema[this.initKey(collection)]) {
      const results = await client.query(name, {
        query: embedding,
        using: 'dense',
        score_threshold: threshold,
        limit,
        with_payload: ['content'],
      });
      const points = results.points ?? results;
      return points.map((r: any) => ({
        id: typeof r.id === 'number' ? r.id : parseInt(r.id),
        content: r.payload?.content ?? '',
        similarity: r.score,
      }));
    }

    // Fallback: no content in old schema
    return [];
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /** Convert a Qdrant point with memory payload to a Memory + similarity. */
  private payloadToMemory(point: any): QdrantMemoryResult {
    const p = point.payload ?? {};
    return {
      id: typeof point.id === 'number' ? point.id : parseInt(point.id),
      content: p.content ?? '',
      tags: Array.isArray(p.tags) ? p.tags : [],
      source: p.source ?? null,
      type: (p.type as MemoryType) ?? null,
      quality_score: p.quality_score ?? null,
      quality_factors: null,
      access_count: p.access_count ?? 0,
      last_accessed: p.last_accessed ?? null,
      valid_from: p.valid_from ?? null,
      valid_until: p.valid_until ?? null,
      created_at: p.created_at ?? '',
      similarity: point.score,
    };
  }
}

/**
 * Create Qdrant vector store from storage config.
 */
export function createQdrantVectorStore(config: StorageConfig): QdrantVectorStore {
  const qdrantConfig = config.qdrant ?? {};
  return new QdrantVectorStore({
    url: qdrantConfig.url,
    apiKey: qdrantConfig.api_key,
    collectionPrefix: qdrantConfig.collection_prefix,
  });
}
