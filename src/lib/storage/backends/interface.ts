/**
 * StorageBackend interface for abstracting SQL database operations.
 *
 * Implementations:
 * - SQLite (better-sqlite3)
 * - PostgreSQL (pg)
 *
 * Note: Vector operations are handled by VectorStore interface separately.
 * This interface focuses on SQL/relational operations.
 */

import type Database from 'better-sqlite3';
import type {
  Document,
  DocumentBatch,
  DocumentBatchWithHash,
  Memory,
  MemoryInput,
  MemorySearchResult,
  GlobalMemory,
  GlobalMemorySearchResult,
  SaveMemoryResult,
  MemoryLink,
  MemoryLinkInput,
  MemoryWithLinks,
  ConnectedMemory,
  GraphStats,
  TokenStatRecord,
  TokenStatsAggregated,
  MemoryForRetention,
  MemoryType,
  LinkRelation,
  QualityScoreData,
  WebSearchHistoryInput,
  WebSearchHistoryRecord,
  WebSearchHistoryFilter,
  WebSearchHistorySummary,
} from '../types.js';

/**
 * StorageBackend interface for SQL database operations.
 *
 * Design notes:
 * - Methods are sync for SQLite compatibility (better-sqlite3 is sync)
 * - PostgreSQL implementation will wrap async pg in sync-compatible interface
 * - Vector search is delegated to VectorStore interface
 */
export interface StorageBackend {
  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Initialize the database (create tables, run migrations).
   */
  init(): void;

  /**
   * Close database connections.
   */
  close(): void;

  /**
   * Get the raw database instance (for advanced use).
   * Returns better-sqlite3 Database for SQLite, or Pool for PostgreSQL.
   */
  getRawDb(): Database.Database | unknown;

  /**
   * Get the global database instance (for cross-project memories).
   */
  getRawGlobalDb(): Database.Database | unknown;

  // ============================================================================
  // Documents
  // ============================================================================

  /**
   * Insert or update a document.
   * @returns The document ID
   */
  upsertDocument(
    filePath: string,
    chunkIndex: number,
    content: string,
    startLine: number,
    endLine: number,
    embeddingBlob: Buffer,
    symbolName?: string,
    symbolType?: string,
    signature?: string,
  ): number;

  /**
   * Batch upsert documents in a single transaction.
   */
  upsertDocumentsBatch(documents: DocumentBatch[], toBlob: (embedding: number[]) => Buffer): void;

  /**
   * Batch upsert documents with file hashes in a single transaction.
   */
  upsertDocumentsBatchWithHashes(
    documents: DocumentBatchWithHash[],
    toBlob: (embedding: number[]) => Buffer
  ): void;

  /**
   * Delete all documents for a given file path.
   * @returns Array of deleted document IDs (for vector cleanup)
   */
  deleteDocumentsByPath(filePath: string): number[];

  /**
   * Get document IDs for a given file path.
   */
  getDocumentIdsByPath(filePath: string): number[];

  /**
   * Get documents by IDs.
   */
  getDocumentsByIds(ids: number[]): Document[];

  /**
   * Get all documents (for brute-force search fallback).
   */
  getAllDocuments(): Array<Document & { embedding: Buffer }>;

  /**
   * Get all code documents (file_path LIKE 'code:%').
   */
  getAllCodeDocuments(): Array<{
    id: number;
    file_path: string;
    content: string;
    start_line: number;
    end_line: number;
    embedding: Buffer;
  }>;

  /**
   * Get all non-code documents (file_path NOT LIKE 'code:%').
   */
  getAllDocsDocuments(): Array<{
    id: number;
    file_path: string;
    content: string;
    start_line: number;
    end_line: number;
    embedding: Buffer;
  }>;

  /**
   * Get recent documents.
   */
  getRecentDocuments(limit: number): Array<{
    file_path: string;
    chunk_index: number;
    start_line: number;
    end_line: number;
    updated_at: string;
  }>;

  /**
   * Clear all documents.
   */
  clearDocuments(): void;

  /**
   * Clear only code documents.
   */
  clearCodeDocuments(): void;

  /**
   * Get document statistics.
   */
  getDocumentStats(): {
    total_documents: number;
    total_files: number;
    last_indexed: string | null;
  };

  /**
   * Get stored embedding dimension from first document.
   */
  getStoredEmbeddingDimension(): number | null;

  // ============================================================================
  // File Hashes
  // ============================================================================

  getFileHash(filePath: string): string | null;
  setFileHash(filePath: string, hash: string): void;
  deleteFileHash(filePath: string): void;
  getAllFileHashes(): Map<string, string>;
  getAllFileHashesWithTimestamps(): Array<{ file_path: string; content_hash: string; indexed_at: string }>;

  // ============================================================================
  // Local Memories
  // ============================================================================

  /**
   * Save a memory.
   */
  saveMemory(
    content: string,
    embeddingBlob: Buffer,
    tags: string[],
    source: string | undefined,
    type: MemoryType,
    qualityScore: number | undefined,
    qualityFactors: Record<string, number> | undefined,
    validFrom: string | undefined,
    validUntil: string | undefined
  ): number;

  /**
   * Find similar memory by embedding (for deduplication).
   */
  findSimilarMemoryByEmbedding(
    embedding: number[],
    threshold: number,
    cosineSimilarity: (a: number[], b: number[]) => number,
    bufferToFloatArray: (buffer: Buffer) => number[]
  ): { id: number; content: string; similarity: number } | null;

  /**
   * Get memory by ID.
   */
  getMemoryById(id: number): Memory | null;

  /**
   * Get recent memories.
   */
  getRecentMemories(limit: number): Memory[];

  /**
   * Get all memories with embeddings (for vector search fallback).
   */
  getAllMemoriesWithEmbeddings(): Array<{
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    type: string | null;
    created_at: string;
    embedding: Buffer;
    last_accessed: string | null;
    access_count: number;
    valid_from: string | null;
    valid_until: string | null;
  }>;

  /**
   * Get memories by IDs.
   */
  getMemoriesByIds(ids: number[]): Memory[];

  /**
   * Delete a memory by ID.
   * @returns true if deleted
   */
  deleteMemory(id: number): boolean;

  /**
   * Delete memories older than date.
   * @returns number of deleted memories
   */
  deleteMemoriesOlderThan(date: Date): number;

  /**
   * Delete memories by tag.
   * @returns number of deleted memories
   */
  deleteMemoriesByTag(tag: string): number;

  /**
   * Delete memories by IDs.
   * @returns number of deleted memories
   */
  deleteMemoriesByIds(ids: number[]): number;

  /**
   * Get memory statistics.
   */
  getMemoryStats(): {
    total_memories: number;
    by_type: Record<string, number>;
    by_quality: { high: number; medium: number; low: number; unscored: number };
    recent_24h: number;
    recent_7d: number;
    recent_30d: number;
    with_quality_score: number;
    avg_quality_score: number | null;
    total_links: number;
    avg_links_per_memory: number;
  };

  /**
   * Increment memory access count.
   */
  incrementMemoryAccess(memoryId: number, weight: number): void;

  /**
   * Batch increment memory access counts.
   */
  incrementMemoryAccessBatch(accesses: Array<{ memoryId: number; weight: number }>): void;

  /**
   * Get all memories for retention analysis.
   */
  getAllMemoriesForRetention(): MemoryForRetention[];

  // ============================================================================
  // Global Memories
  // ============================================================================

  /**
   * Save a global memory.
   */
  saveGlobalMemory(
    content: string,
    embeddingBlob: Buffer,
    tags: string[],
    source: string | undefined,
    project: string | undefined,
    type: MemoryType
  ): number;

  /**
   * Find similar global memory (for deduplication).
   */
  findSimilarGlobalMemoryByEmbedding(
    embedding: number[],
    threshold: number,
    cosineSimilarity: (a: number[], b: number[]) => number,
    bufferToFloatArray: (buffer: Buffer) => number[]
  ): { id: number; content: string; similarity: number } | null;

  /**
   * Get all global memories with embeddings.
   */
  getAllGlobalMemoriesWithEmbeddings(): Array<{
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    project: string | null;
    type: string | null;
    created_at: string;
    embedding: Buffer;
  }>;

  /**
   * Get recent global memories.
   */
  getRecentGlobalMemories(limit: number): GlobalMemory[];

  /**
   * Delete a global memory.
   */
  deleteGlobalMemory(id: number): boolean;

  /**
   * Get global memory statistics.
   */
  getGlobalMemoryStats(): {
    total_memories: number;
    by_project: Record<string, number>;
    by_type: Record<string, number>;
    by_quality: { high: number; medium: number; low: number; unscored: number };
    recent_24h: number;
    recent_7d: number;
    with_quality_score: number;
    avg_quality_score: number | null;
  };

  // ============================================================================
  // Memory Links (Graph)
  // ============================================================================

  /**
   * Create a memory link.
   */
  createMemoryLink(
    sourceId: number,
    targetId: number,
    relation: LinkRelation,
    weight: number,
    validFrom: string | undefined,
    validUntil: string | undefined
  ): { id: number; created: boolean };

  /**
   * Delete a memory link.
   */
  deleteMemoryLink(sourceId: number, targetId: number, relation?: LinkRelation): boolean;

  /**
   * Get links for a memory.
   */
  getMemoryLinks(memoryId: number): {
    outgoing: MemoryLink[];
    incoming: MemoryLink[];
  };

  /**
   * Get memory with all its links.
   */
  getMemoryWithLinks(
    memoryId: number,
    asOfDate?: Date,
    includeExpired?: boolean
  ): MemoryWithLinks | null;

  /**
   * Find connected memories via BFS.
   */
  findConnectedMemories(
    memoryId: number,
    maxDepth: number
  ): ConnectedMemory[];

  /**
   * Auto-link similar memories.
   */
  autoLinkSimilarMemories(
    threshold: number,
    maxLinks: number,
    cosineSimilarity: (a: number[], b: number[]) => number,
    bufferToFloatArray: (buffer: Buffer) => number[]
  ): number;

  /**
   * Get graph statistics.
   */
  getGraphStats(): GraphStats;

  /**
   * Invalidate (soft delete) a memory link.
   */
  invalidateMemoryLink(
    sourceId: number,
    targetId: number,
    relation?: LinkRelation
  ): boolean;

  /**
   * Get graph statistics as of a specific date.
   */
  getGraphStatsAsOf(asOfDate: Date): GraphStats;

  // ============================================================================
  // Graph Enrichment
  // ============================================================================

  /**
   * Update tags for a memory.
   */
  updateMemoryTags(memoryId: number, tags: string[]): void;

  /**
   * Update a memory link's relation, weight, and enrichment flag.
   */
  updateMemoryLink(linkId: number, updates: { relation?: string; weight?: number; llmEnriched?: boolean }): void;

  /**
   * Upsert centrality score cache for a memory.
   */
  upsertCentralityScore(memoryId: number, degree: number, normalizedDegree: number): void;

  /**
   * Get centrality scores for a batch of memory IDs.
   */
  getCentralityScores(memoryIds: number[]): Map<number, number>;

  // ============================================================================
  // Token Frequencies
  // ============================================================================

  updateTokenFrequencies(tokens: string[]): void;
  getTokenFrequency(token: string): number;
  getTokenFrequencies(tokens: string[]): Map<string, number>;
  getTotalTokenCount(): number;
  getTopTokens(limit: number): Array<{ token: string; frequency: number }>;
  clearTokenFrequencies(): void;
  getTokenFrequencyStats(): {
    unique_tokens: number;
    total_frequency: number;
    avg_frequency: number;
  };

  // ============================================================================
  // Token Stats
  // ============================================================================

  recordTokenStat(record: TokenStatRecord): void;
  getTokenStatsAggregated(): TokenStatsAggregated[];
  getTokenStatsSummary(): {
    total_calls: number;
    total_returned_tokens: number;
    total_full_source_tokens: number;
    total_savings_tokens: number;
    total_estimated_cost: number;
    savings_percent: number;
    by_event_type: TokenStatsAggregated[];
  };
  clearTokenStats(): void;

  // ============================================================================
  // Web Search History
  // ============================================================================

  recordWebSearch(record: WebSearchHistoryInput): number;
  getWebSearchHistory(filter: WebSearchHistoryFilter): WebSearchHistoryRecord[];
  getWebSearchSummary(): WebSearchHistorySummary;
  getTodayWebSearchSpend(): number;
  clearWebSearchHistory(): void;

  // ============================================================================
  // BM25 Index Storage
  // ============================================================================

  getBm25Index(key: string): string | null;
  setBm25Index(key: string, serialized: string): void;
  deleteBm25Index(key: string): void;

  // ============================================================================
  // Metadata
  // ============================================================================

  getMetadata(key: string): string | null;
  setMetadata(key: string, value: string): void;

  // ============================================================================
  // Transactions
  // ============================================================================

  /**
   * Execute a function within a transaction.
   * For SQLite, wraps in database.transaction().
   * For PostgreSQL, wraps in BEGIN/COMMIT/ROLLBACK.
   */
  transaction<T>(fn: () => T): T;
}
