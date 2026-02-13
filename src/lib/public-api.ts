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
  setConfigOverride,
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

// --- Token stats ---
export {
  getTokenStatsAggregated,
  getTokenStatsSummary,
} from './storage/index.js';

// --- Web search ---
export { recordWebSearch, getWebSearchHistory, getWebSearchSummary } from './storage/index.js';
export { callOpenRouterSearch } from './llm.js';
export type { ChatMessage, OpenRouterSearchResponse } from './llm.js';

// --- AI readiness ---
export { calculateAIReadinessScore, formatAIReadinessScore } from './ai-readiness.js';

// --- Retention ---
export { analyzeRetention } from './retention.js';

// --- Checkpoints ---
export { createCheckpoint, listCheckpoints } from './checkpoint.js';

// --- Graph: advanced operations ---
export { enrichExistingLinks } from './graph/llm-relations.js';
export { createProximityLinks } from './graph/contextual-proximity.js';
export { detectCommunities } from './graph/community-detection.js';
export { updateCentralityCache } from './graph/centrality.js';
export { exportGraphSilent } from './graph-export.js';

// --- PRD pipeline ---
export { generatePrd } from './prd/generate.js';
export type { GenerateResult } from './prd/generate.js';
export { loadPrd, loadTasks, listPrds, findLatestPrd } from './prd/state.js';
export { runPrd } from './prd/runner.js';
export type { RunOptions, RunResult } from './prd/runner.js';
export { exportPrdToObsidian, exportAllPrds } from './prd/export.js';
export type { Prd, Task, PrdStatus, PrdIndexEntry } from './prd/types.js';

// --- Config (write) ---
export { getConfigDisplay, formatConfigDisplay } from './config.js';

// --- Debug sessions ---
export {
  generateSessionId,
  ensureDebugsDir,
  saveSession,
  loadSession,
  deleteSession,
  listSessions,
  findActiveSession,
  appendSessionLog,
  loadSessionLog,
} from './debug/state.js';
export {
  detectLanguage,
  generateLogStatement,
} from './debug/types.js';
export type {
  DebugSession,
  DebugSessionStatus,
  DebugLanguage,
  Hypothesis,
  HypothesisResult,
  InstrumentedFile,
  DebugSessionIndexEntry,
} from './debug/types.js';

// --- Tree-sitter symbols ---
export { extractSymbolsFromFile } from './tree-sitter/public.js';
export type { ExtractSymbolsOptions, ExtractSymbolsResult } from './tree-sitter/public.js';
export type { SymbolInfo, SymbolType } from './tree-sitter/types.js';

// --- Errors ---
export {
  SuccError,
  ConfigError,
  StorageError,
  ValidationError,
  NetworkError,
  NotFoundError,
  DependencyError,
  isSuccError,
} from './errors.js';

// --- Types ---
export type { MemoryBatchInput, MemoryBatchResult } from './storage/index.js';
export type { LinkRelation, MemoryType, StorageConfig, SqliteConfig, PostgresConfig, QdrantConfig } from './storage/types.js';
