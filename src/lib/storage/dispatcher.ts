/**
 * Storage Dispatcher - Routes database operations to the configured backend.
 *
 * This module provides a unified interface that automatically routes database
 * operations to either:
 * - SQLite (default, uses db.ts functions directly)
 * - PostgreSQL (uses backends/postgresql.ts)
 *
 * Additionally supports Qdrant for vector search when configured.
 *
 * Usage:
 *   import { getStorageDispatcher } from './storage/dispatcher.js';
 *   const storage = await getStorageDispatcher();
 *   await storage.saveMemory(...);
 */

import { getConfig } from '../config.js';
import type { PostgresBackend } from './backends/postgresql.js';
import type { QdrantVectorStore } from './vector/qdrant.js';
import type {
  MemoryType,
  LinkRelation,
  StorageConfig,
} from './types.js';

// Dispatcher state
let _backend: 'sqlite' | 'postgresql' = 'sqlite';
let _vectorBackend: 'builtin' | 'qdrant' = 'builtin';
let _postgresBackend: PostgresBackend | null = null;
let _qdrantStore: QdrantVectorStore | null = null;
let _initialized = false;

/**
 * Get the current storage configuration.
 */
export function getStorageConfig(): StorageConfig {
  const config = getConfig();
  return {
    backend: config.storage?.backend ?? 'sqlite',
    vector: config.storage?.vector ?? 'builtin',
    sqlite: config.storage?.sqlite,
    postgresql: config.storage?.postgresql,
    qdrant: config.storage?.qdrant,
  };
}

/**
 * Initialize the storage dispatcher based on configuration.
 * This is called lazily on first use.
 */
export async function initStorageDispatcher(): Promise<void> {
  if (_initialized) return;

  const config = getStorageConfig();
  _backend = config.backend ?? 'sqlite';
  _vectorBackend = config.vector ?? 'builtin';

  // Initialize PostgreSQL backend if configured
  if (_backend === 'postgresql') {
    const { createPostgresBackend } = await import('./backends/postgresql.js');
    _postgresBackend = createPostgresBackend(config);
    // Initialize schema
    await _postgresBackend.getDocumentStats(); // This triggers schema init
  }

  // Initialize Qdrant if configured
  if (_vectorBackend === 'qdrant') {
    const { createQdrantVectorStore } = await import('./vector/qdrant.js');
    _qdrantStore = createQdrantVectorStore(config);
    await _qdrantStore.init(384); // Standard embedding dimension
  }

  _initialized = true;
}

/**
 * Get current backend type.
 */
export function getBackendType(): 'sqlite' | 'postgresql' {
  return _backend;
}

/**
 * Get current vector backend type.
 */
export function getVectorBackendType(): 'builtin' | 'qdrant' {
  return _vectorBackend;
}

/**
 * Check if using PostgreSQL backend.
 */
export function isPostgresBackend(): boolean {
  return _backend === 'postgresql';
}

/**
 * Check if using Qdrant for vectors.
 */
export function isQdrantVectors(): boolean {
  return _vectorBackend === 'qdrant';
}

/**
 * Get PostgreSQL backend instance (if initialized).
 */
export function getPostgresBackend(): PostgresBackend | null {
  return _postgresBackend;
}

/**
 * Get Qdrant vector store instance (if initialized).
 */
export function getQdrantStore(): QdrantVectorStore | null {
  return _qdrantStore;
}

/**
 * Close all connections.
 */
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
}

// =============================================================================
// Storage Dispatcher Interface
// =============================================================================

/**
 * Main storage dispatcher class that routes operations to the correct backend.
 *
 * Note: This class uses `any` types for return values to avoid type conflicts
 * between db.ts types and storage/types.ts types. The actual implementations
 * are type-safe, but the dispatcher needs to be flexible.
 */
export class StorageDispatcher {
  private backend: 'sqlite' | 'postgresql';
  private vectorBackend: 'builtin' | 'qdrant';
  private postgres: PostgresBackend | null;
  private qdrant: QdrantVectorStore | null;

  // Lazy-loaded SQLite functions
  private _sqliteFns: typeof import('../db.js') | null = null;

  constructor() {
    this.backend = _backend;
    this.vectorBackend = _vectorBackend;
    this.postgres = _postgresBackend;
    this.qdrant = _qdrantStore;
  }

  private async getSqliteFns(): Promise<typeof import('../db.js')> {
    if (!this._sqliteFns) {
      this._sqliteFns = await import('../db.js');
    }
    return this._sqliteFns;
  }

  // ===========================================================================
  // Document Operations
  // ===========================================================================

  async searchDocuments(
    queryEmbedding: number[],
    limit: number = 5,
    threshold: number = 0.5
  ): Promise<Array<{ file_path: string; content: string; start_line: number; end_line: number; similarity: number }>> {
    // If using Qdrant for vectors, search there first
    if (this.vectorBackend === 'qdrant' && this.qdrant) {
      const vectorResults = await this.qdrant.searchDocuments(queryEmbedding, limit, threshold);

      if (vectorResults.length === 0) return [];

      // Fetch document metadata from SQL backend
      if (this.backend === 'postgresql' && this.postgres) {
        // For PostgreSQL, we'd need to implement getDocumentsByIds
        // For now, fall through to pgvector search
        return this.postgres.searchDocuments(queryEmbedding, limit, threshold);
      } else {
        // For SQLite, search documents directly
        const sqlite = await this.getSqliteFns();
        return sqlite.searchDocuments(queryEmbedding, limit, threshold);
      }
    }

    // Use builtin vector search
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.searchDocuments(queryEmbedding, limit, threshold);
    }

    const sqlite = await this.getSqliteFns();
    return sqlite.searchDocuments(queryEmbedding, limit, threshold);
  }

  async getStats(): Promise<{ total_documents: number; total_files: number; last_indexed: string | null }> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.getDocumentStats();
    }

    const sqlite = await this.getSqliteFns();
    return sqlite.getStats();
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
  ): Promise<{ id: number; created: boolean; duplicate?: { id: number; content: string; similarity: number } }> {
    const type = options?.type ?? 'observation';
    const deduplicate = options?.deduplicate ?? true;
    const qualityScore = options?.qualityScore;
    const qualityFactors = options?.qualityFactors;
    const validFrom = options?.validFrom;
    const validUntil = options?.validUntil;

    if (this.backend === 'postgresql' && this.postgres) {
      // Check for duplicates if requested
      if (deduplicate) {
        const results = await this.postgres.searchMemories(embedding, 1, 0.95);
        if (results.length > 0) {
          return {
            id: results[0].id,
            created: false,
            duplicate: {
              id: results[0].id,
              content: results[0].content,
              similarity: results[0].similarity,
            },
          };
        }
      }

      const id = await this.postgres.saveMemory(
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

      // Also save to Qdrant if configured
      if (this.vectorBackend === 'qdrant' && this.qdrant) {
        await this.qdrant.upsertMemoryVector(id, embedding);
      }

      return { id, created: true };
    }

    // Use SQLite
    const sqlite = await this.getSqliteFns();
    const result = sqlite.saveMemory(content, embedding, tags, source, {
      type,
      deduplicate,
      qualityScore: qualityScore != null ? { score: qualityScore, factors: qualityFactors ?? {} } : undefined,
      validFrom,
      validUntil,
    });
    return {
      id: result.id,
      created: !result.isDuplicate,
      duplicate: result.isDuplicate && result.similarity != null ? {
        id: result.id,
        content: '', // SQLite doesn't return content for duplicates
        similarity: result.similarity,
      } : undefined,
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
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.searchMemories(queryEmbedding, limit, threshold, tags, since, options);
    }

    const sqlite = await this.getSqliteFns();
    return sqlite.searchMemories(queryEmbedding, limit, threshold, tags, since, options);
  }

  async getMemoryById(id: number): Promise<any | null> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.getMemoryById(id);
    }

    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryById(id);
  }

  async deleteMemory(id: number): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres) {
      const deleted = await this.postgres.deleteMemory(id);

      // Also delete from Qdrant if configured
      if (deleted && this.vectorBackend === 'qdrant' && this.qdrant) {
        await this.qdrant.deleteMemoryVector(id);
      }

      return deleted;
    }

    const sqlite = await this.getSqliteFns();
    return sqlite.deleteMemory(id);
  }

  async getRecentMemories(limit: number = 10): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.getRecentMemories(limit);
    }

    const sqlite = await this.getSqliteFns();
    return sqlite.getRecentMemories(limit);
  }

  async getMemoryStats(): Promise<any> {
    if (this.backend === 'postgresql' && this.postgres) {
      // PostgreSQL backend has getGraphStats for link info
      const graphStats = await this.postgres.getGraphStats();
      // Return a compatible structure
      return {
        total_memories: graphStats.total_memories,
        by_type: {},
        by_quality: { high: 0, medium: 0, low: 0, unscored: graphStats.total_memories },
        recent_24h: 0,
        recent_7d: 0,
        recent_30d: 0,
        with_quality_score: 0,
        avg_quality_score: null,
        total_links: graphStats.total_links,
        avg_links_per_memory: graphStats.avg_links_per_memory,
      };
    }

    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryStats();
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
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.createMemoryLink(sourceId, targetId, relation, weight, validFrom, validUntil);
    }

    const sqlite = await this.getSqliteFns();
    return sqlite.createMemoryLink(sourceId, targetId, relation, weight, { validFrom, validUntil });
  }

  async deleteMemoryLink(sourceId: number, targetId: number, relation?: LinkRelation): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.deleteMemoryLink(sourceId, targetId, relation);
    }

    const sqlite = await this.getSqliteFns();
    return sqlite.deleteMemoryLink(sourceId, targetId, relation);
  }

  async getMemoryLinks(memoryId: number): Promise<any> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.getMemoryLinks(memoryId);
    }

    const sqlite = await this.getSqliteFns();
    return sqlite.getMemoryLinks(memoryId);
  }

  async getGraphStats(): Promise<any> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.getGraphStats();
    }

    const sqlite = await this.getSqliteFns();
    return sqlite.getGraphStats();
  }

  // ===========================================================================
  // File Hashes
  // ===========================================================================

  async getFileHash(filePath: string): Promise<string | null> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.getFileHash(filePath);
    }

    const sqlite = await this.getSqliteFns();
    return sqlite.getFileHash(filePath);
  }

  async setFileHash(filePath: string, hash: string): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.setFileHash(filePath, hash);
    }

    const sqlite = await this.getSqliteFns();
    return sqlite.setFileHash(filePath, hash);
  }

  async getAllFileHashes(): Promise<Map<string, string>> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.getAllFileHashes();
    }

    const sqlite = await this.getSqliteFns();
    return sqlite.getAllFileHashes();
  }

  // ===========================================================================
  // Token Stats
  // ===========================================================================

  async recordTokenStat(record: any): Promise<void> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.recordTokenStat(record);
    }

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
  ): Promise<{ id: number; created: boolean; duplicate?: { id: number; content: string; similarity: number } }> {
    const type = options?.type ?? 'observation';
    const deduplicate = options?.deduplicate ?? true;
    const qualityScore = options?.qualityScore;
    const qualityFactors = options?.qualityFactors;

    if (this.backend === 'postgresql' && this.postgres) {
      // Check for duplicates if requested
      if (deduplicate) {
        const results = await this.postgres.searchGlobalMemories(embedding, 1, 0.95);
        if (results.length > 0) {
          return {
            id: results[0].id,
            created: false,
            duplicate: {
              id: results[0].id,
              content: results[0].content,
              similarity: results[0].similarity,
            },
          };
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

      // Also save to Qdrant if configured
      if (this.vectorBackend === 'qdrant' && this.qdrant) {
        await this.qdrant.upsertGlobalMemoryVector(id, embedding);
      }

      return { id, created: true };
    }

    // Use SQLite global database
    const sqlite = await this.getSqliteFns();
    const result = sqlite.saveGlobalMemory(content, embedding, tags, source, undefined, {
      type,
      deduplicate,
    });
    return {
      id: result.id,
      created: !result.isDuplicate,
      duplicate: result.isDuplicate && result.similarity != null ? {
        id: result.id,
        content: '',
        similarity: result.similarity,
      } : undefined,
    };
  }

  async searchGlobalMemories(
    queryEmbedding: number[],
    limit: number = 5,
    threshold: number = 0.3,
    tags?: string[]
  ): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.searchGlobalMemories(queryEmbedding, limit, threshold, tags);
    }

    const sqlite = await this.getSqliteFns();
    return sqlite.searchGlobalMemories(queryEmbedding, limit, threshold, tags);
  }

  async getRecentGlobalMemories(limit: number = 10): Promise<any[]> {
    if (this.backend === 'postgresql' && this.postgres) {
      return this.postgres.getRecentGlobalMemories(limit);
    }

    const sqlite = await this.getSqliteFns();
    return sqlite.getRecentGlobalMemories(limit);
  }

  async deleteGlobalMemory(id: number): Promise<boolean> {
    if (this.backend === 'postgresql' && this.postgres) {
      const deleted = await this.postgres.deleteGlobalMemory(id);

      // Also delete from Qdrant if configured
      if (deleted && this.vectorBackend === 'qdrant' && this.qdrant) {
        await this.qdrant.deleteGlobalMemoryVector(id);
      }

      return deleted;
    }

    const sqlite = await this.getSqliteFns();
    return sqlite.deleteGlobalMemory(id);
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
}

// Singleton dispatcher instance
let _dispatcher: StorageDispatcher | null = null;

/**
 * Get the storage dispatcher instance.
 * Initializes on first call.
 */
export async function getStorageDispatcher(): Promise<StorageDispatcher> {
  if (!_initialized) {
    await initStorageDispatcher();
  }
  if (!_dispatcher) {
    _dispatcher = new StorageDispatcher();
  }
  return _dispatcher;
}

/**
 * Reset dispatcher (for testing).
 */
export function resetStorageDispatcher(): void {
  _dispatcher = null;
  _initialized = false;
  _postgresBackend = null;
  _qdrantStore = null;
  _backend = 'sqlite';
  _vectorBackend = 'builtin';
}
