/**
 * Stable public API for succ integrations (plugins, extensions).
 *
 * Import via: import { ... } from 'succ/api'
 *
 * This barrel export defines the supported contract.
 * Internal module paths (dist/lib/storage/...) are NOT part of the public API.
 */

// --- Storage: init / teardown ---
export { initStorageDispatcher, closeStorageDispatcher } from './storage/dispatcher.js';

// --- Search ---
export { hybridSearchDocs, hybridSearchCode, hybridSearchMemories, hybridSearchGlobalMemories } from './storage/index.js';
export { searchDocuments } from './storage/index.js';

// --- Memories ---
export {
  saveMemory,
  saveMemoriesBatch,
  searchMemories,
  getRecentMemories,
  getMemoryById,
  deleteMemory,
  deleteMemoriesOlderThan,
  deleteMemoriesByTag,
  deleteMemoriesByIds,
  findSimilarMemory,
  searchMemoriesAsOf,
  getMemoryStats,
  incrementMemoryAccess,
  getAllMemoriesForRetention,
} from './storage/index.js';

// --- Global memories ---
export {
  saveGlobalMemory,
  searchGlobalMemories,
  getRecentGlobalMemories,
  deleteGlobalMemory,
  getGlobalMemoryStats,
  findSimilarGlobalMemory,
} from './storage/index.js';

// --- Knowledge graph ---
export {
  createMemoryLink,
  deleteMemoryLink,
  getMemoryLinks,
  getMemoryWithLinks,
  findConnectedMemories,
  findRelatedMemoriesForLinking,
  createAutoLinks,
  autoLinkSimilarMemories,
  getGraphStats,
  updateMemoryLink,
  upsertCentralityScore,
  getCentralityScores,
} from './storage/index.js';

// --- Documents (indexing) ---
export {
  upsertDocument,
  upsertDocumentsBatch,
  upsertDocumentsBatchWithHashes,
  deleteDocumentsByPath,
  getStats,
  getFileHash,
  setFileHash,
  deleteFileHash,
  getAllFileHashes,
  getStaleFiles,
} from './storage/index.js';
export type { IndexFreshnessResult } from './storage/index.js';

// --- Embeddings ---
export { getEmbedding, getEmbeddings, cosineSimilarity, cleanupEmbeddings, getEmbeddingInfo } from './embeddings.js';
export type { EmbeddingResponse } from './embeddings.js';

// --- Config ---
export {
  getConfig,
  getProjectRoot,
  getSuccDir,
  isProjectInitialized,
  isGlobalOnlyMode,
  invalidateConfigCache,
} from './config.js';
export type { SuccConfig } from './config.js';

// --- BM25 index management ---
export {
  invalidateBM25Index,
  invalidateCodeBm25Index,
  invalidateDocsBm25Index,
  invalidateMemoriesBm25Index,
  updateCodeBm25Index,
  updateMemoriesBm25Index,
} from './storage/index.js';

// --- Types ---
export type { MemoryBatchInput, MemoryBatchResult } from './db/memories.js';
