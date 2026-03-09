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
export {
  hybridSearchDocs,
  hybridSearchCode,
  hybridSearchMemories,
  hybridSearchGlobalMemories,
} from './storage/index.js';
export { searchDocuments } from './storage/index.js';

// --- Memories ---
export {
  saveMemory,
  saveMemoriesBatch,
  searchMemories,
  getRecentMemories,
  getPinnedMemories,
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
export {
  getEmbedding,
  getEmbeddings,
  cosineSimilarity,
  cleanupEmbeddings,
  getEmbeddingInfo,
} from './embeddings.js';
export type { EmbeddingResponse } from './embeddings.js';

// --- Reranker ---
export { rerank, isRerankerEnabled, cleanupReranker } from './reranker.js';

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
export { getTokenStatsAggregated, getTokenStatsSummary } from './storage/index.js';

// --- Web search ---
export { recordWebSearch, getWebSearchHistory, getWebSearchSummary } from './storage/index.js';
export { callOpenRouterSearch, getLLMConfig } from './llm.js';
export type { ChatMessage, OpenRouterSearchResponse, LLMBackend } from './llm.js';

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

// --- Graph: graphology algorithms ---
export {
  getGraph,
  invalidateGraphCache,
  personalizedPageRank,
  detectLouvainCommunities,
  shortestPath,
  getArticulationPoints,
  computePageRank,
  computeBetweennessCentrality,
  whyRelated,
} from './graph/graphology-bridge.js';
export type { LouvainCommunity } from './graph/graphology-bridge.js';
export { generateCommunitySummaries } from './graph/community-summaries.js';
export type { CommunitySummaryResult } from './graph/community-summaries.js';

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
export { detectLanguage, generateLogStatement } from './debug/types.js';
export type {
  DebugSession,
  DebugSessionStatus,
  DebugLanguage,
  Hypothesis,
  HypothesisResult,
  InstrumentedFile,
  DebugSessionIndexEntry,
} from './debug/types.js';

// --- Indexing & analysis (CLI-originated but used by plugins) ---
export { analyzeFile } from '../commands/analyze-recursive.js';
export { indexCodeFile } from '../commands/index-code.js';
export type { IndexCodeFileResult } from '../commands/index-code.js';
export { reindexFiles } from '../commands/reindex.js';
export type { ReindexResult } from '../commands/reindex.js';

// --- Tree-sitter symbols ---
export { extractSymbolsFromFile } from './tree-sitter/public.js';
export type { ExtractSymbolsOptions, ExtractSymbolsResult } from './tree-sitter/public.js';
export type { SymbolInfo, SymbolType } from './tree-sitter/types.js';

// --- Web fetch (md.succ.ai) ---
export { fetchAsMarkdown } from './md-fetch.js';
export type { MdFetchResult, MdFetchOptions } from './md-fetch.js';

// --- Review context pack ---
export { generateReviewContext } from './review/context-pack.js';
export type { ReviewContextPack } from './review/context-pack.js';

// --- Diff parsing ---
export {
  parseDiffText,
  extractChangedSymbols,
  summarizeDiff,
  getFileChanges,
} from './diff-parser.js';
export type { DiffFile, DiffChunk, DiffChange, ParsedDiff } from './diff-parser.js';

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
export type {
  HybridMemoryResult,
  LinkRelation,
  MemoryType,
  SourceType,
  StorageConfig,
  SqliteConfig,
  PostgresConfig,
  QdrantConfig,
} from './storage/types.js';

// --- Temporal utilities ---
export { parseDuration } from './temporal.js';

// --- Quality scoring ---
export { scoreMemory, passesQualityThreshold } from './quality.js';
export type { QualityScore } from './quality.js';

// --- Sensitive content filter ---
export { scanSensitive } from './sensitive-filter.js';
export type { FilterResult } from './sensitive-filter.js';

// --- File-linked memory recall ---
export { getMemoriesByTag } from './storage/index.js';

// --- LLM fact extraction ---
export { extractFactsWithLLM } from './session-summary.js';
export type { ExtractedFact } from './session-summary.js';

// --- Graph cleanup pipeline ---
export { graphCleanup } from './graph/cleanup.js';
export type { CleanupOptions, CleanupResult } from './graph/cleanup.js';

// --- Git co-change analysis ---
export { analyzeCoChanges, getCoChangesForFile } from './git/co-change.js';
export type { CoChangePair, CoChangeResult, CoChangeForFile } from './git/co-change.js';

// --- Bridge edges (code ↔ knowledge) ---
export {
  extractCodePaths,
  inferBridgeRelation,
  createBridgeEdgesForMemory,
  createManualBridgeEdge,
  findMemoriesForCode,
  autoBridgeRecentMemories,
  BRIDGE_RELATIONS,
} from './graph/bridge-edges.js';
export type { BridgeRelation, BridgeEdgeResult, CodeReference } from './graph/bridge-edges.js';
export type { BridgeEdgeMetadata } from './storage/types.js';

// --- Retrieval feedback loops ---
export {
  recordRecallEvent,
  recordRecallBatch,
  getRecallStats,
  getRecallSummary,
  getBoostFactor,
  getBoostFactors,
  getNeverUsedMemories,
  cleanupRecallEvents,
} from './retrieval-feedback.js';
export type { RecallEvent, RecallStats, RecallSummary } from './retrieval-feedback.js';

// --- Auto memory consolidation ---
export { consolidateAutoMemories, getAutoMemoryStats } from './auto-memory/consolidation.js';
export type { ConsolidationResult } from './auto-memory/consolidation.js';

// --- LSP code intelligence ---
export {
  findDefinition,
  findReferences,
  getHover,
  shutdownAll as shutdownLsp,
  getStatus as getLspStatus,
  getClient as getLspClient,
} from '../lsp/manager.js';
export type { LspQueryResult } from '../lsp/manager.js';
export type { LspLocation, LspClientOptions } from '../lsp/client.js';
export { LSP_SERVERS, detectProjectLanguages } from '../lsp/servers.js';
export type { LspServerConfig, InstallStrategy } from '../lsp/servers.js';

// --- Search: PPR-enhanced retrieval ---
export { pprEnhancedRerank } from './search/ppr-retrieval.js';
export type { PPRSearchResult, PPRSearchOptions } from './search/ppr-retrieval.js';

// --- Search: HyDE (Hypothetical Document Embeddings) ---
export { generateHyDE } from './search/hyde.js';
export type { HyDEResult } from './search/hyde.js';

// --- Search: BM25 query expansion ---
export { expandQuery, expandQueryFull, looksLikeCode } from './query-expansion.js';
export type { ExpandedQuery } from './query-expansion.js';

// --- Search: Repo map ---
export { generateRepoMap } from './search/repo-map.js';
export type { RepoMapEntry, RepoMapResult } from './search/repo-map.js';

// --- Cross-repo search ---
export { discoverProjects, listProjects } from './cross-repo.js';
export type {
  CrossRepoProject,
  CrossRepoSearchResult,
  CrossRepoSearchSummary,
} from './cross-repo.js';

// --- Observability ---
export {
  recordLatency,
  withLatency,
  getLatencyStats,
  getDashboard,
  formatDashboard,
} from './observability.js';
export type { LatencyMetric, ObservabilityDashboard } from './observability.js';

// --- Diff-aware brain vault analysis ---
export { detectChangedFiles } from './diff-brain.js';
export type { DiffAnalysisResult } from './diff-brain.js';

// --- Brain vault export ---
export {
  readBrainVault,
  exportBrainAsJson,
  exportBrainAsMarkdown,
  exportBrainSnapshot,
} from './brain-export.js';
export type { BrainDoc, BrainExportResult, BrainSnapshot } from './brain-export.js';

// --- API versioning ---
export { API_VERSION, addVersionedRoutes, getApiVersionInfo } from '../daemon/routes/versioning.js';
