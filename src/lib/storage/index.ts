/**
 * Storage abstraction layer for succ.
 *
 * This module provides a unified interface for database operations,
 * supporting multiple backends:
 * - SQLite (default) with sqlite-vec for vectors
 * - PostgreSQL with pgvector for vectors
 * - Optional Qdrant for vector search (with any SQL backend)
 *
 * Current implementation: Re-exports from db.ts with config validation.
 * Future: Full backend abstraction with pluggable implementations.
 */

import { getConfig } from '../config.js';

// Re-export all types from types.ts
export * from './types.js';

// Re-export everything from db.ts (current SQLite implementation)
// This maintains backward compatibility - all consumers continue to work
export {
  // Database instances
  getDb,
  getGlobalDb,
  closeDb,
  closeGlobalDb,

  // Document operations
  upsertDocument,
  upsertDocumentsBatch,
  upsertDocumentsBatchWithHashes,
  deleteDocumentsByPath,
  searchDocuments,
  clearDocuments,
  clearCodeDocuments,
  getRecentDocuments,
  getStoredEmbeddingDimension,
  getStats,

  // Hybrid search
  hybridSearchCode,
  hybridSearchDocs,

  // BM25 index management
  invalidateCodeBm25Index,
  updateCodeBm25Index,
  invalidateDocsBm25Index,

  // File hashes
  getFileHash,
  setFileHash,
  deleteFileHash,
  getAllFileHashes,

  // Local memories
  findSimilarMemory,
  saveMemory,
  searchMemories,
  hybridSearchMemories,
  getRecentMemories,
  deleteMemory,
  getMemoryStats,
  deleteMemoriesOlderThan,
  deleteMemoriesByTag,
  deleteMemoriesByIds,
  getMemoryById,
  incrementMemoryAccess,
  incrementMemoryAccessBatch,
  getAllMemoriesForRetention,

  // BM25 for memories
  invalidateMemoriesBm25Index,
  updateMemoriesBm25Index,

  // Global memories
  findSimilarGlobalMemory,
  saveGlobalMemory,
  searchGlobalMemories,
  hybridSearchGlobalMemories,
  getRecentGlobalMemories,
  deleteGlobalMemory,
  getGlobalMemoryStats,
  invalidateGlobalMemoriesBm25Index,
  updateGlobalMemoriesBm25Index,

  // Memory links (graph)
  createMemoryLink,
  deleteMemoryLink,
  getMemoryLinks,
  getMemoryWithLinks,
  findConnectedMemories,
  autoLinkSimilarMemories,
  getGraphStats,
  invalidateMemoryLink,
  getGraphStatsAsOf,
  searchMemoriesAsOf,

  // Token frequencies
  updateTokenFrequencies,
  getTokenFrequency,
  getTokenFrequencies,
  getTotalTokenCount,
  getTopTokens,
  clearTokenFrequencies,
  getTokenFrequencyStats,

  // Token stats
  recordTokenStat,
  getTokenStatsAggregated,
  getTokenStatsSummary,
  clearTokenStats,

  // Types (also export from db.ts for compatibility)
  type Document,
  type SearchResult,
  type HybridSearchResult,
  type DocumentBatch,
  type DocumentBatchWithHash,
  type Memory,
  type MemorySearchResult,
  type SaveMemoryResult,
  type QualityScoreData,
  type HybridMemoryResult,
  type GlobalMemory,
  type GlobalMemorySearchResult,
  type HybridGlobalMemoryResult,
  type MemoryLink,
  type MemoryWithLinks,
  type TokenStatRecord,
  type TokenStatsAggregated,
  type MemoryForRetention,
  type MemoryType,
  type LinkRelation,
  type TokenEventType,
  MEMORY_TYPES,
  LINK_RELATIONS,
} from '../db.js';

/**
 * Get current storage configuration.
 * Returns defaults if not configured.
 */
export function getStorageConfig() {
  const config = getConfig();
  return {
    backend: config.storage?.backend ?? 'sqlite',
    vector: config.storage?.vector ?? 'builtin',
    sqlite: config.storage?.sqlite ?? {},
    postgresql: config.storage?.postgresql ?? {},
    qdrant: config.storage?.qdrant ?? {},
  };
}

/**
 * Validate storage configuration.
 * Throws if config is invalid.
 */
export function validateStorageConfig(): void {
  const config = getStorageConfig();

  // Validate SQLite config if present
  if (config.backend === 'sqlite' && config.sqlite) {
    if (config.sqlite.busy_timeout !== undefined && config.sqlite.busy_timeout < 0) {
      throw new Error('storage.sqlite.busy_timeout must be a positive number');
    }
  }

  // Validate PostgreSQL config if specified
  if (config.backend === 'postgresql') {
    if (!config.postgresql.connection_string && !config.postgresql.database) {
      throw new Error(
        'PostgreSQL backend requires either connection_string or database in storage.postgresql config'
      );
    }
  }

  // Validate Qdrant config if specified
  if (config.vector === 'qdrant') {
    // Qdrant defaults to localhost:6333, so no required config
    // Just validate format if url is provided
    if (config.qdrant.url && !config.qdrant.url.startsWith('http')) {
      throw new Error('storage.qdrant.url must be a valid HTTP(S) URL');
    }
  }
}

// Export PostgreSQL backend (available but not default)
export { PostgresBackend, createPostgresBackend } from './backends/postgresql.js';

// Export Qdrant vector store (available but not default)
export { QdrantVectorStore, createQdrantVectorStore } from './vector/qdrant.js';

// Export VectorStore interface
export type { VectorStore } from './vector/interface.js';

// Export storage dispatcher
export {
  getStorageDispatcher,
  initStorageDispatcher,
  closeStorageDispatcher,
  resetStorageDispatcher,
  getBackendType,
  getVectorBackendType,
  isPostgresBackend,
  isQdrantVectors,
  getPostgresBackend,
  getQdrantStore,
  StorageDispatcher,
} from './dispatcher.js';

// Import these at module level since we already import getConfig
import { getDbPath, getGlobalDbPath } from '../config.js';

/**
 * Get storage backend info for status display.
 */
export function getStorageInfo(): {
  backend: string;
  vector: string;
  path?: string;
  globalPath?: string;
} {
  const config = getStorageConfig();

  if (config.backend === 'sqlite') {
    return {
      backend: 'sqlite',
      vector: config.vector === 'qdrant' ? 'qdrant' : 'sqlite-vec',
      path: getDbPath(),
      globalPath: getGlobalDbPath(),
    };
  }

  if (config.backend === 'postgresql') {
    const pgConfig = config.postgresql;
    return {
      backend: 'postgresql',
      vector: config.vector === 'qdrant' ? 'qdrant' : 'pgvector',
      path: pgConfig.connection_string || `${pgConfig.host ?? 'localhost'}:${pgConfig.port ?? 5432}/${pgConfig.database ?? 'succ'}`,
    };
  }

  return {
    backend: config.backend,
    vector: config.vector,
  };
}
