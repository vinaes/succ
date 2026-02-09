/**
 * Storage abstraction layer for succ.
 *
 * This module provides a unified async interface for database operations,
 * routing through the StorageDispatcher to the configured backend:
 * - SQLite (default) with sqlite-vec for vectors
 * - PostgreSQL with pgvector for vectors
 * - Optional Qdrant for vector search (with any SQL backend)
 *
 * ALL data functions are async and route through the dispatcher.
 * Connection/lifecycle functions remain sync re-exports.
 */

import { getConfig, getDbPath, getGlobalDbPath } from '../config.js';
import { getStorageDispatcher } from './dispatcher.js';
import type { MemoryType, LinkRelation } from './types.js';

// ===========================================================================
// Types — canonical abstract types from storage/types.ts
// ===========================================================================
export * from './types.js';

// Types only defined in db modules (not in storage/types.ts)
export type { MemoryBatchInput, MemoryBatchResult } from '../db/memories.js';

// ===========================================================================
// Connection — lifecycle only (close/cleanup)
// NOTE: getDb/getGlobalDb intentionally NOT exported here.
// All data access must go through the dispatcher.
// If you need raw SQLite access, import from db/connection.js directly.
// ===========================================================================
export { closeDb, closeGlobalDb } from '../db/connection.js';

// ===========================================================================
// Dispatcher — lifecycle and info helpers
// ===========================================================================
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

// Backend implementations (available for direct use if needed)
export { PostgresBackend, createPostgresBackend } from './backends/postgresql.js';
export { QdrantVectorStore, createQdrantVectorStore } from './vector/qdrant.js';
export type { VectorStore } from './vector/interface.js';

// ===========================================================================
// Storage Config (sync utility functions)
// ===========================================================================

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

export function validateStorageConfig(): void {
  const config = getStorageConfig();

  if (config.backend === 'sqlite' && config.sqlite) {
    if (config.sqlite.busy_timeout !== undefined && config.sqlite.busy_timeout < 0) {
      throw new Error('storage.sqlite.busy_timeout must be a positive number');
    }
  }

  if (config.backend === 'postgresql') {
    if (!config.postgresql.connection_string && !config.postgresql.database) {
      throw new Error(
        'PostgreSQL backend requires either connection_string or database in storage.postgresql config'
      );
    }
  }

  if (config.vector === 'qdrant') {
    if (config.qdrant.url && !config.qdrant.url.startsWith('http')) {
      throw new Error('storage.qdrant.url must be a valid HTTP(S) URL');
    }
  }
}

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

// ===========================================================================
// Document Operations — async wrappers routing through dispatcher
// ===========================================================================

export async function upsertDocument(
  filePath: string, chunkIndex: number, content: string,
  startLine: number, endLine: number, embedding: number[]
): Promise<void> {
  const d = await getStorageDispatcher();
  return d.upsertDocument(filePath, chunkIndex, content, startLine, endLine, embedding);
}

export async function upsertDocumentsBatch(documents: Array<{
  filePath: string; chunkIndex: number; content: string;
  startLine: number; endLine: number; embedding: number[];
}>): Promise<void> {
  const d = await getStorageDispatcher();
  return d.upsertDocumentsBatch(documents);
}

export async function upsertDocumentsBatchWithHashes(documents: Array<{
  filePath: string; chunkIndex: number; content: string;
  startLine: number; endLine: number; embedding: number[]; hash: string;
}>): Promise<void> {
  const d = await getStorageDispatcher();
  return d.upsertDocumentsBatchWithHashes(documents);
}

export async function deleteDocumentsByPath(filePath: string): Promise<void> {
  const d = await getStorageDispatcher();
  return d.deleteDocumentsByPath(filePath);
}

export async function searchDocuments(
  queryEmbedding: number[], limit?: number, threshold?: number
): Promise<Array<{ file_path: string; content: string; start_line: number; end_line: number; similarity: number }>> {
  const d = await getStorageDispatcher();
  return d.searchDocuments(queryEmbedding, limit, threshold);
}

export async function getRecentDocuments(limit?: number): Promise<Array<{
  file_path: string; content: string; start_line: number; end_line: number;
}>> {
  const d = await getStorageDispatcher();
  return d.getRecentDocuments(limit);
}

export async function getStats(): Promise<{ total_documents: number; total_files: number; last_indexed: string | null }> {
  const d = await getStorageDispatcher();
  return d.getStats();
}

export async function clearDocuments(): Promise<void> {
  const d = await getStorageDispatcher();
  return d.clearDocuments();
}

export async function clearCodeDocuments(): Promise<void> {
  const d = await getStorageDispatcher();
  return d.clearCodeDocuments();
}

export async function getStoredEmbeddingDimension(): Promise<number | null> {
  const d = await getStorageDispatcher();
  return d.getStoredEmbeddingDimension();
}

// ===========================================================================
// File Hashes
// ===========================================================================

export async function getFileHash(filePath: string): Promise<string | null> {
  const d = await getStorageDispatcher();
  return d.getFileHash(filePath);
}

export async function setFileHash(filePath: string, hash: string): Promise<void> {
  const d = await getStorageDispatcher();
  return d.setFileHash(filePath, hash);
}

export async function deleteFileHash(filePath: string): Promise<void> {
  const d = await getStorageDispatcher();
  return d.deleteFileHash(filePath);
}

export async function getAllFileHashes(): Promise<Map<string, string>> {
  const d = await getStorageDispatcher();
  return d.getAllFileHashes();
}

export async function getAllFileHashesWithTimestamps(): Promise<Array<{ file_path: string; content_hash: string; indexed_at: string }>> {
  const d = await getStorageDispatcher();
  return d.getAllFileHashesWithTimestamps();
}

export interface IndexFreshnessResult {
  stale: string[];     // DB file_path values (with code: prefix if applicable)
  deleted: string[];   // DB file_path values
  total: number;
}

/**
 * Check which indexed files are stale (modified or deleted since indexing).
 * Uses mtime-first optimization: only reads+hashes files whose mtime > indexed_at.
 */
export async function getStaleFiles(projectRoot: string): Promise<IndexFreshnessResult> {
  const { createHash } = await import('crypto');
  const { readFileSync, statSync } = await import('fs');
  const { resolve, sep } = await import('path');

  const entries = await getAllFileHashesWithTimestamps();
  const stale: string[] = [];
  const deleted: string[] = [];

  for (const entry of entries) {
    // Code-indexed files have "code:" prefix — strip it for disk path
    const isCode = entry.file_path.startsWith('code:');
    const relativePath = isCode ? entry.file_path.slice(5) : entry.file_path;

    // Normalize path separators for current OS
    const normalized = relativePath.split(/[\\/]/).join(sep);
    const fullPath = resolve(projectRoot, normalized);

    try {
      const stat = statSync(fullPath);
      // Compare mtime against indexed_at — only hash if file is newer
      const indexedAt = new Date(entry.indexed_at).getTime();
      if (stat.mtimeMs > indexedAt) {
        // File was modified after indexing — verify with hash
        const content = readFileSync(fullPath, 'utf-8');
        const currentHash = createHash('md5').update(content).digest('hex');
        if (currentHash !== entry.content_hash) {
          stale.push(entry.file_path);
        }
      }
    } catch {
      // File doesn't exist on disk
      deleted.push(entry.file_path);
    }
  }

  return { stale, deleted, total: entries.length };
}

/**
 * Convenience wrapper returning counts (used by status displays).
 */
export async function getStaleFileCount(projectRoot: string): Promise<{ stale: number; deleted: number; total: number }> {
  const result = await getStaleFiles(projectRoot);
  return { stale: result.stale.length, deleted: result.deleted.length, total: result.total };
}

// ===========================================================================
// Local Memories
// ===========================================================================

export async function findSimilarMemory(
  embedding: number[], threshold?: number
): Promise<{ id: number; content: string; similarity: number } | null> {
  const d = await getStorageDispatcher();
  return d.findSimilarMemory(embedding, threshold);
}

export async function saveMemory(
  content: string, embedding: number[], tags?: string[], source?: string,
  options?: {
    type?: MemoryType;
    deduplicate?: boolean;
    qualityScore?: { score: number; factors: Record<string, number> } | number;
    qualityFactors?: Record<string, number>;
    validFrom?: string | Date;
    validUntil?: string | Date;
    autoLink?: boolean;
  }
): Promise<{ id: number; isDuplicate: boolean; existingId?: number; similarity?: number; linksCreated?: number }> {
  const d = await getStorageDispatcher();

  // Adapt qualityScore: consumers pass { score, factors }, dispatcher wants separate params
  let qs: number | undefined;
  let qf: Record<string, number> | undefined;
  if (options?.qualityScore && typeof options.qualityScore === 'object') {
    qs = options.qualityScore.score;
    qf = options.qualityScore.factors;
  } else if (typeof options?.qualityScore === 'number') {
    qs = options.qualityScore;
    qf = options?.qualityFactors;
  }

  // Convert Date to string for validity
  const validFrom = options?.validFrom instanceof Date ? options.validFrom.toISOString() : options?.validFrom;
  const validUntil = options?.validUntil instanceof Date ? options.validUntil.toISOString() : options?.validUntil;

  const result = await d.saveMemory(content, embedding, tags ?? [], source, {
    type: options?.type,
    deduplicate: options?.deduplicate,
    qualityScore: qs,
    qualityFactors: qf,
    validFrom,
    validUntil,
  });

  // Convert dispatcher result to backward-compatible format
  return {
    id: result.id,
    isDuplicate: !result.created,
    existingId: result.duplicate?.id,
    similarity: result.duplicate?.similarity,
    linksCreated: 0,
  };
}

export async function saveMemoriesBatch(
  memories: any[],
  deduplicateThreshold?: number,
  options?: { autoLink?: boolean; linkThreshold?: number; deduplicate?: boolean }
): Promise<any> {
  const d = await getStorageDispatcher();
  return d.saveMemoriesBatch(memories, deduplicateThreshold, options);
}

export async function searchMemories(
  queryEmbedding: number[], limit?: number, threshold?: number,
  tags?: string[], since?: Date,
  options?: { includeExpired?: boolean; asOfDate?: Date }
): Promise<any[]> {
  const d = await getStorageDispatcher();
  return d.searchMemories(queryEmbedding, limit, threshold, tags, since, options);
}

export async function getRecentMemories(limit?: number): Promise<any[]> {
  const d = await getStorageDispatcher();
  return d.getRecentMemories(limit);
}

export async function deleteMemory(id: number): Promise<boolean> {
  const d = await getStorageDispatcher();
  return d.deleteMemory(id);
}

export async function invalidateMemory(memoryId: number, supersededById: number): Promise<boolean> {
  const d = await getStorageDispatcher();
  return d.invalidateMemory(memoryId, supersededById);
}

export async function restoreInvalidatedMemory(memoryId: number): Promise<boolean> {
  const d = await getStorageDispatcher();
  return d.restoreInvalidatedMemory(memoryId);
}

export async function getConsolidationHistory(limit?: number): Promise<any[]> {
  const d = await getStorageDispatcher();
  return d.getConsolidationHistory(limit);
}

export async function getMemoryStats(): Promise<any> {
  const d = await getStorageDispatcher();
  return d.getMemoryStats();
}

export async function deleteMemoriesOlderThan(date: Date): Promise<number> {
  const d = await getStorageDispatcher();
  return d.deleteMemoriesOlderThan(date);
}

export async function deleteMemoriesByTag(tag: string): Promise<number> {
  const d = await getStorageDispatcher();
  return d.deleteMemoriesByTag(tag);
}

export async function getMemoryById(id: number): Promise<any | null> {
  const d = await getStorageDispatcher();
  return d.getMemoryById(id);
}

export async function deleteMemoriesByIds(ids: number[]): Promise<number> {
  const d = await getStorageDispatcher();
  return d.deleteMemoriesByIds(ids);
}

export async function searchMemoriesAsOf(
  queryEmbedding: number[], asOfDate: Date, limit?: number, threshold?: number
): Promise<any[]> {
  const d = await getStorageDispatcher();
  return d.searchMemoriesAsOf(queryEmbedding, asOfDate, limit, threshold);
}

export async function incrementMemoryAccess(memoryId: number, weight?: number): Promise<void> {
  const d = await getStorageDispatcher();
  return d.incrementMemoryAccess(memoryId, weight);
}

export async function incrementMemoryAccessBatch(
  accesses: Array<{ memoryId: number; weight: number }>
): Promise<void> {
  const d = await getStorageDispatcher();
  return d.incrementMemoryAccessBatch(accesses);
}

export async function getAllMemoriesForRetention(): Promise<any[]> {
  const d = await getStorageDispatcher();
  return d.getAllMemoriesForRetention();
}

// ===========================================================================
// Global Memories
// ===========================================================================

export async function findSimilarGlobalMemory(
  embedding: number[], threshold?: number
): Promise<{ id: number; content: string; similarity: number } | null> {
  const d = await getStorageDispatcher();
  return d.findSimilarGlobalMemory(embedding, threshold);
}

export async function saveGlobalMemory(
  content: string, embedding: number[], tags?: string[], source?: string,
  projectOrOptions?: string | { type?: MemoryType; deduplicate?: boolean },
  options?: { type?: MemoryType; deduplicate?: boolean }
): Promise<{ id: number; isDuplicate: boolean; existingId?: number; similarity?: number }> {
  const d = await getStorageDispatcher();

  // Handle overloaded signature: (content, embedding, tags, source, project?, options?)
  let opts: { type?: MemoryType; deduplicate?: boolean } | undefined;
  if (typeof projectOrOptions === 'string') {
    // Called as: saveGlobalMemory(content, embedding, tags, source, projectName, options?)
    opts = options;
  } else {
    // Called as: saveGlobalMemory(content, embedding, tags, source, options?)
    opts = projectOrOptions;
  }

  const result = await d.saveGlobalMemory(content, embedding, tags ?? [], source, opts);

  // Convert dispatcher result to backward-compatible format
  return {
    id: result.id,
    isDuplicate: !result.created,
    existingId: result.duplicate?.id,
    similarity: result.duplicate?.similarity,
  };
}

export async function searchGlobalMemories(
  queryEmbedding: number[], limit?: number, threshold?: number, tags?: string[]
): Promise<any[]> {
  const d = await getStorageDispatcher();
  return d.searchGlobalMemories(queryEmbedding, limit, threshold, tags);
}

export async function getRecentGlobalMemories(limit?: number): Promise<any[]> {
  const d = await getStorageDispatcher();
  return d.getRecentGlobalMemories(limit);
}

export async function deleteGlobalMemory(id: number): Promise<boolean> {
  const d = await getStorageDispatcher();
  return d.deleteGlobalMemory(id);
}

export async function getGlobalMemoryStats(): Promise<any> {
  const d = await getStorageDispatcher();
  return d.getGlobalMemoryStats();
}

// ===========================================================================
// BM25 Index Management
// ===========================================================================

export async function invalidateCodeBm25Index(): Promise<void> {
  const d = await getStorageDispatcher();
  return d.invalidateCodeBm25Index();
}

export async function invalidateDocsBm25Index(): Promise<void> {
  const d = await getStorageDispatcher();
  return d.invalidateDocsBm25Index();
}

export async function invalidateMemoriesBm25Index(): Promise<void> {
  const d = await getStorageDispatcher();
  return d.invalidateMemoriesBm25Index();
}

export async function invalidateGlobalMemoriesBm25Index(): Promise<void> {
  const d = await getStorageDispatcher();
  return d.invalidateGlobalMemoriesBm25Index();
}

export async function invalidateBM25Index(): Promise<void> {
  const d = await getStorageDispatcher();
  return d.invalidateBM25Index();
}

export async function updateCodeBm25Index(docId: number, content: string): Promise<void> {
  const d = await getStorageDispatcher();
  return d.updateCodeBm25Index(docId, content);
}

export async function updateMemoriesBm25Index(memoryId: number, content: string): Promise<void> {
  const d = await getStorageDispatcher();
  return d.updateMemoriesBm25Index(memoryId, content);
}

export async function updateGlobalMemoriesBm25Index(memoryId: number, content: string): Promise<void> {
  const d = await getStorageDispatcher();
  return d.updateGlobalMemoriesBm25Index(memoryId, content);
}

// ===========================================================================
// Hybrid Search
// ===========================================================================

export async function hybridSearchCode(
  query: string, queryEmbedding: number[], limit?: number, threshold?: number, alpha?: number
): Promise<any[]> {
  const d = await getStorageDispatcher();
  return d.hybridSearchCode(query, queryEmbedding, limit, threshold, alpha);
}

export async function hybridSearchDocs(
  query: string, queryEmbedding: number[], limit?: number, threshold?: number, alpha?: number
): Promise<any[]> {
  const d = await getStorageDispatcher();
  return d.hybridSearchDocs(query, queryEmbedding, limit, threshold, alpha);
}

export async function hybridSearchMemories(
  query: string, queryEmbedding: number[], limit?: number, threshold?: number, alpha?: number
): Promise<any[]> {
  const d = await getStorageDispatcher();
  return d.hybridSearchMemories(query, queryEmbedding, limit, threshold, alpha);
}

export async function hybridSearchGlobalMemories(
  query: string, queryEmbedding: number[], limit?: number, threshold?: number,
  alpha?: number, tags?: string[], since?: Date
): Promise<any[]> {
  const d = await getStorageDispatcher();
  return d.hybridSearchGlobalMemories(query, queryEmbedding, limit, threshold, alpha, tags, since);
}

// ===========================================================================
// Memory Links (Knowledge Graph)
// ===========================================================================

export async function createMemoryLink(
  sourceId: number, targetId: number, relation?: LinkRelation,
  weight?: number,
  optionsOrValidFrom?: string | { validFrom?: string; validUntil?: string },
  validUntil?: string
): Promise<{ id: number; created: boolean }> {
  const d = await getStorageDispatcher();
  let vf: string | undefined;
  let vu: string | undefined;
  if (typeof optionsOrValidFrom === 'object') {
    vf = optionsOrValidFrom.validFrom;
    vu = optionsOrValidFrom.validUntil;
  } else {
    vf = optionsOrValidFrom;
    vu = validUntil;
  }
  return d.createMemoryLink(sourceId, targetId, relation, weight, vf, vu);
}

export async function deleteMemoryLink(
  sourceId: number, targetId: number, relation?: LinkRelation
): Promise<boolean> {
  const d = await getStorageDispatcher();
  return d.deleteMemoryLink(sourceId, targetId, relation);
}

export async function getMemoryLinks(memoryId: number): Promise<any> {
  const d = await getStorageDispatcher();
  return d.getMemoryLinks(memoryId);
}

export async function getMemoryWithLinks(
  memoryId: number, options?: { asOfDate?: Date; includeExpired?: boolean }
): Promise<any> {
  const d = await getStorageDispatcher();
  return d.getMemoryWithLinks(memoryId, options);
}

export async function findConnectedMemories(memoryId: number, maxDepth?: number): Promise<any[]> {
  const d = await getStorageDispatcher();
  return d.findConnectedMemories(memoryId, maxDepth);
}

export async function findRelatedMemoriesForLinking(
  memoryId: number, threshold?: number, maxLinks?: number
): Promise<any[]> {
  const d = await getStorageDispatcher();
  return d.findRelatedMemoriesForLinking(memoryId, threshold, maxLinks);
}

export async function createAutoLinks(
  memoryId: number, threshold?: number, maxLinks?: number
): Promise<number> {
  const d = await getStorageDispatcher();
  return d.createAutoLinks(memoryId, threshold, maxLinks);
}

export async function autoLinkSimilarMemories(threshold?: number, maxLinks?: number): Promise<number> {
  const d = await getStorageDispatcher();
  return d.autoLinkSimilarMemories(threshold, maxLinks);
}

export async function getGraphStats(): Promise<any> {
  const d = await getStorageDispatcher();
  return d.getGraphStats();
}

export async function invalidateMemoryLink(
  sourceId: number, targetId: number, relation?: LinkRelation
): Promise<boolean> {
  const d = await getStorageDispatcher();
  return d.invalidateMemoryLink(sourceId, targetId, relation);
}

export async function getMemoryLinksAsOf(memoryId: number, asOfDate: Date): Promise<any> {
  const d = await getStorageDispatcher();
  return d.getMemoryLinksAsOf(memoryId, asOfDate);
}

export async function findConnectedMemoriesAsOf(
  memoryId: number, asOfDate: Date, maxDepth?: number
): Promise<any[]> {
  const d = await getStorageDispatcher();
  return d.findConnectedMemoriesAsOf(memoryId, asOfDate, maxDepth);
}

export async function getGraphStatsAsOf(asOfDate: Date): Promise<any> {
  const d = await getStorageDispatcher();
  return d.getGraphStatsAsOf(asOfDate);
}

// ===========================================================================
// Token Frequency
// ===========================================================================

export async function updateTokenFrequencies(tokens: string[]): Promise<void> {
  const d = await getStorageDispatcher();
  return d.updateTokenFrequencies(tokens);
}

export async function getTokenFrequency(token: string): Promise<number> {
  const d = await getStorageDispatcher();
  return d.getTokenFrequency(token);
}

export async function getTokenFrequencies(tokens: string[]): Promise<Map<string, number>> {
  const d = await getStorageDispatcher();
  return d.getTokenFrequencies(tokens);
}

export async function getTotalTokenCount(): Promise<number> {
  const d = await getStorageDispatcher();
  return d.getTotalTokenCount();
}

export async function getTopTokens(limit?: number): Promise<Array<{ token: string; frequency: number }>> {
  const d = await getStorageDispatcher();
  return d.getTopTokens(limit);
}

export async function clearTokenFrequencies(): Promise<void> {
  const d = await getStorageDispatcher();
  return d.clearTokenFrequencies();
}

export async function getTokenFrequencyStats(): Promise<{
  unique_tokens: number; total_occurrences: number; avg_frequency: number;
}> {
  const d = await getStorageDispatcher();
  return d.getTokenFrequencyStats();
}

// ===========================================================================
// Token Stats
// ===========================================================================

export async function recordTokenStat(record: any): Promise<void> {
  const d = await getStorageDispatcher();
  return d.recordTokenStat(record);
}

export async function getTokenStatsAggregated(): Promise<any[]> {
  const d = await getStorageDispatcher();
  return d.getTokenStatsAggregated();
}

export async function getTokenStatsSummary(): Promise<any> {
  const d = await getStorageDispatcher();
  return d.getTokenStatsSummary();
}

export async function clearTokenStats(): Promise<void> {
  const d = await getStorageDispatcher();
  return d.clearTokenStats();
}

// ===========================================================================
// Qdrant Backfill
// ===========================================================================

export async function backfillQdrant(
  target?: 'memories' | 'global_memories' | 'documents' | 'all',
  options?: { onProgress?: (msg: string) => void; dryRun?: boolean }
): Promise<{ memories: number; globalMemories: number; documents: number }> {
  const d = await getStorageDispatcher();
  return d.backfillQdrant(target, options);
}

// ===========================================================================
// Skills
// ===========================================================================

export async function upsertSkill(skill: {
  name: string; description: string; source: 'local' | 'skyll';
  path?: string; content?: string; skyllId?: string; cacheExpires?: string;
}): Promise<number> {
  const d = await getStorageDispatcher();
  return d.upsertSkill(skill);
}

export async function getAllSkills(): Promise<Array<{
  id: number; name: string; description: string; source: string;
  path?: string; content?: string; skyllId?: string; usageCount: number; lastUsed?: string;
}>> {
  const d = await getStorageDispatcher();
  return d.getAllSkills();
}

export async function searchSkillsDb(query: string, limit?: number): Promise<Array<{
  id: number; name: string; description: string; source: string;
  path?: string; usageCount: number;
}>> {
  const d = await getStorageDispatcher();
  return d.searchSkills(query, limit);
}

export async function getSkillByName(name: string): Promise<{
  id: number; name: string; description: string; source: string;
  path?: string; content?: string; skyllId?: string;
} | null> {
  const d = await getStorageDispatcher();
  return d.getSkillByName(name);
}

export async function trackSkillUsageDb(name: string): Promise<void> {
  const d = await getStorageDispatcher();
  return d.trackSkillUsage(name);
}

export async function deleteSkill(name: string): Promise<boolean> {
  const d = await getStorageDispatcher();
  return d.deleteSkill(name);
}

export async function clearExpiredSkyllCache(): Promise<number> {
  const d = await getStorageDispatcher();
  return d.clearExpiredSkyllCache();
}

export async function getCachedSkyllSkill(skyllId: string): Promise<{
  id: number; name: string; description: string; content?: string;
} | null> {
  const d = await getStorageDispatcher();
  return d.getCachedSkyllSkill(skyllId);
}

export async function getSkyllCacheStats(): Promise<{ cachedSkills: number }> {
  const d = await getStorageDispatcher();
  return d.getSkyllCacheStats();
}

// ===========================================================================
// Bulk Export (for checkpoint, graph-export)
// ===========================================================================

export async function getAllMemoriesForExport(): Promise<Array<{
  id: number; content: string; tags: string[]; source: string | null;
  embedding: number[] | null; type: string | null;
  quality_score: number | null; quality_factors: Record<string, number> | null;
  access_count: number; last_accessed: string | null; created_at: string;
  invalidated_by: number | null;
}>> {
  const d = await getStorageDispatcher();
  return d.getAllMemoriesForExport();
}

export async function getAllDocumentsForExport(): Promise<Array<{
  id: number; file_path: string; chunk_index: number; content: string;
  start_line: number; end_line: number; embedding: number[] | null; created_at: string;
}>> {
  const d = await getStorageDispatcher();
  return d.getAllDocumentsForExport();
}

export async function getAllMemoryLinksForExport(): Promise<Array<{
  id: number; source_id: number; target_id: number;
  relation: string; weight: number; created_at: string;
}>> {
  const d = await getStorageDispatcher();
  return d.getAllMemoryLinksForExport();
}

// ===========================================================================
// Learning Deltas
// ===========================================================================

export async function appendLearningDelta(delta: {
  timestamp: string; source: string;
  memoriesBefore: number; memoriesAfter: number; newMemories: number;
  typesAdded: Record<string, number>; avgQualityOfNew?: number | null;
}): Promise<void> {
  const d = await getStorageDispatcher();
  return d.appendLearningDelta(delta);
}

export async function appendRawLearningDelta(text: string): Promise<void> {
  const d = await getStorageDispatcher();
  return d.appendRawLearningDelta(text);
}

export async function getLearningDeltas(options?: {
  limit?: number; since?: string;
}): Promise<Array<{
  id: number; timestamp: string; source: string;
  memories_before: number; memories_after: number; new_memories: number;
  types_added: string | null; avg_quality: number | null; created_at: string;
}>> {
  const d = await getStorageDispatcher();
  return d.getLearningDeltas(options);
}

// ===========================================================================
// AI Readiness Stats
// ===========================================================================

export async function getCodeFileCount(): Promise<number> {
  const d = await getStorageDispatcher();
  return d.getCodeFileCount();
}

export async function getDocsFileCount(): Promise<number> {
  const d = await getStorageDispatcher();
  return d.getDocsFileCount();
}

export async function getAverageMemoryQuality(): Promise<{ avg: number | null; count: number }> {
  const d = await getStorageDispatcher();
  return d.getAverageMemoryQuality();
}

// ===========================================================================
// Filtered Memory Export (for agents-md-generator)
// ===========================================================================

export async function getMemoriesForAgentsExport(options: {
  types: string[]; minQuality: number; limit: number;
}): Promise<Array<{
  id: number; content: string; type: string | null; tags: string[];
  source: string | null; quality_score: number | null; created_at: string;
}>> {
  const d = await getStorageDispatcher();
  return d.getMemoriesForAgentsExport(options);
}

// ===========================================================================
// Consolidation Helpers
// ===========================================================================

export async function getAllMemoriesWithEmbeddings(options?: {
  types?: string[]; excludeInvalidated?: boolean;
}): Promise<Array<{
  id: number; content: string; tags: string[]; source: string | null;
  embedding: number[] | null; type: string | null;
  quality_score: number | null; created_at: string;
  invalidated_by: number | null;
}>> {
  const d = await getStorageDispatcher();
  return d.getAllMemoriesWithEmbeddings(options);
}

export async function deleteMemoryLinksForMemory(memoryId: number): Promise<number> {
  const d = await getStorageDispatcher();
  return d.deleteMemoryLinksForMemory(memoryId);
}
