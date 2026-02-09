// ============================================================================
// Database Module - Centralized Index
// ============================================================================

// Re-export types and constants from schema
export { MEMORY_TYPES } from './schema.js';
export type { MemoryType } from './schema.js';

// Re-export basic types from types module
export type { Document, SearchResult, GraphStats } from './types.js';

// Re-export connection functions
export { getDb, getGlobalDb, closeDb, closeGlobalDb } from './connection.js';

// Re-export file hash functions
export { getFileHash, setFileHash, deleteFileHash, getAllFileHashes, getAllFileHashesWithTimestamps } from './file-hash.js';

// Re-export token frequency functions
export {
  updateTokenFrequencies,
  getTokenFrequency,
  getTokenFrequencies,
  getTotalTokenCount,
  getTopTokens,
  clearTokenFrequencies,
  getTokenFrequencyStats
} from './token-frequency.js';

// Re-export token stats functions and types
export type {
  TokenEventType,
  TokenStatRecord,
  TokenStatsAggregated
} from './token-stats.js';
export {
  recordTokenStat,
  getTokenStatsAggregated,
  getTokenStatsSummary,
  clearTokenStats
} from './token-stats.js';

// Re-export web search history functions
export {
  recordWebSearch,
  getWebSearchHistory,
  getWebSearchSummary,
  getTodayWebSearchSpend,
  clearWebSearchHistory
} from './web-search-history.js';

// Re-export retention functions and types
export type { MemoryForRetention } from './retention.js';
export {
  incrementMemoryAccess,
  incrementMemoryAccessBatch,
  getAllMemoriesForRetention
} from './retention.js';

// Re-export document functions and types
export type {
  DocumentBatch,
  DocumentBatchWithHash
} from './documents.js';
export {
  upsertDocument,
  upsertDocumentsBatch,
  upsertDocumentsBatchWithHashes,
  deleteDocumentsByPath,
  searchDocuments,
  getRecentDocuments,
  getStats,
  clearDocuments,
  clearCodeDocuments,
  getStoredEmbeddingDimension
} from './documents.js';

// Re-export memory functions and types (local memories)
export type {
  Memory,
  MemorySearchResult,
  SaveMemoryResult,
  QualityScoreData,
  MemoryBatchInput,
  MemoryBatchResult
} from './memories.js';
export {
  findSimilarMemory,
  saveMemory,
  saveMemoriesBatch,
  searchMemories,
  getRecentMemories,
  deleteMemory,
  invalidateMemory,
  restoreInvalidatedMemory,
  getConsolidationHistory,
  getMemoryStats,
  deleteMemoriesOlderThan,
  deleteMemoriesByTag,
  getMemoryById,
  deleteMemoriesByIds,
  searchMemoriesAsOf
} from './memories.js';

// Re-export global memory functions and types
export type {
  GlobalMemory,
  GlobalMemorySearchResult
} from './global-memories.js';
export {
  findSimilarGlobalMemory,
  saveGlobalMemory,
  searchGlobalMemories,
  getRecentGlobalMemories,
  deleteGlobalMemory,
  getGlobalMemoryStats
} from './global-memories.js';

// Re-export BM25 index functions
export {
  invalidateCodeBm25Index,
  invalidateDocsBm25Index,
  invalidateMemoriesBm25Index,
  invalidateGlobalMemoriesBm25Index,
  invalidateBM25Index,
  updateCodeBm25Index,
  updateMemoriesBm25Index,
  updateGlobalMemoriesBm25Index,
} from './bm25-indexes.js';

// Re-export hybrid search functions and types
export type {
  HybridSearchResult,
  HybridMemoryResult,
  HybridGlobalMemoryResult
} from './hybrid-search.js';
export {
  hybridSearchCode,
  hybridSearchDocs,
  hybridSearchMemories,
  hybridSearchGlobalMemories
} from './hybrid-search.js';

// Re-export knowledge graph functions and types
export type {
  LinkRelation,
  MemoryLink,
  MemoryWithLinks
} from './graph.js';
export {
  LINK_RELATIONS,
  createMemoryLink,
  deleteMemoryLink,
  getMemoryLinks,
  getMemoryWithLinks,
  findConnectedMemories,
  findRelatedMemoriesForLinking,
  createAutoLinks,
  autoLinkSimilarMemories,
  getGraphStats,
  invalidateMemoryLink,
  getMemoryLinksAsOf,
  findConnectedMemoriesAsOf,
  getGraphStatsAsOf,
  updateMemoryTags,
  updateMemoryLink,
  upsertCentralityScore,
  getCentralityScores
} from './graph.js';
