/**
 * Storage abstraction types for multi-backend support.
 *
 * Supports:
 * - SQLite + sqlite-vec (default)
 * - PostgreSQL + pgvector
 * - SQLite/PostgreSQL + Qdrant (hybrid)
 */

// ============================================================================
// Configuration Types
// ============================================================================

export type SqlBackend = 'sqlite' | 'postgresql';
export type VectorBackend = 'builtin' | 'qdrant';

export interface SqliteConfig {
  /** Override default path for local database */
  path?: string;
  /** Override default path for global database */
  global_path?: string;
  /** Enable WAL mode (default: true for global, false for local) */
  wal_mode?: boolean;
  /** Busy timeout in ms (default: 5000) */
  busy_timeout?: number;
}

export interface PostgresConfig {
  /** Full connection string (overrides individual params) */
  connection_string?: string;
  /** Host (default: localhost) */
  host?: string;
  /** Port (default: 5432) */
  port?: number;
  /** Database name */
  database?: string;
  /** Username */
  user?: string;
  /** Password */
  password?: string;
  /** Enable SSL. true = SSL with cert validation, { rejectUnauthorized: false } to skip validation */
  ssl?: boolean | { rejectUnauthorized?: boolean; ca?: string };
  /** Connection pool size (default: 10) */
  pool_size?: number;
}

export interface QdrantConfig {
  /** Qdrant server URL (default: http://localhost:6333) */
  url?: string;
  /** API key for authentication */
  api_key?: string;
  /** Collection name prefix (default: succ_) */
  collection_prefix?: string;
}

export interface StorageConfig {
  /** SQL backend: sqlite or postgresql (default: sqlite) */
  backend?: SqlBackend;
  /** Vector backend: builtin or qdrant (default: builtin) */
  vector?: VectorBackend;
  /** SQLite-specific configuration */
  sqlite?: SqliteConfig;
  /** PostgreSQL-specific configuration */
  postgresql?: PostgresConfig;
  /** Qdrant-specific configuration (when vector: 'qdrant') */
  qdrant?: QdrantConfig;
}

// ============================================================================
// Entity Types
// ============================================================================

export interface Document {
  id: number;
  file_path: string;
  chunk_index: number;
  content: string;
  start_line: number;
  end_line: number;
  embedding: number[];
  created_at: string;
  updated_at: string;
}

export interface DocumentInput {
  filePath: string;
  chunkIndex: number;
  content: string;
  startLine: number;
  endLine: number;
  embedding: number[];
  symbolName?: string;
  symbolType?: string;
  signature?: string;
}

export type DocumentBatch = DocumentInput;

export interface DocumentBatchWithHash extends DocumentBatch {
  hash: string;
}

export interface RecentDocumentRecord {
  file_path: string;
  content: string;
  start_line: number;
  end_line: number;
}

export const MEMORY_TYPES = [
  'observation',
  'decision',
  'learning',
  'error',
  'pattern',
  'dead_end',
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const SOURCE_TYPES = [
  'human',
  'agent',
  'canonical_doc',
  'imported',
  'auto_extracted',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export interface Memory {
  id: number;
  content: string;
  tags: string[];
  source: string | null;
  type: MemoryType | null;
  quality_score: number | null;
  quality_factors: Record<string, number> | null;
  access_count: number;
  last_accessed: string | null;
  valid_from: string | null;
  valid_until: string | null;
  correction_count: number;
  is_invariant: boolean;
  priority_score: number | null;
  confidence: number | null;
  source_type: SourceType | null;
  created_at: string;
}

export type MemoryRecord = Memory;

export interface WorkingMemoryRecord {
  id: number;
  content: string;
  quality_score: number | null;
  access_count: number;
  created_at: string;
  last_accessed: string | null;
  valid_from: string | null;
  valid_until: string | null;
  correction_count: number;
  is_invariant: boolean;
  type?: MemoryType | null;
  tags?: string[] | null;
  source?: string | null;
  quality_factors?: Record<string, number> | null;
  priority_score?: number | null;
}

export interface MemoryInput {
  content: string;
  embedding: number[];
  tags?: string[];
  source?: string;
  type?: MemoryType;
  qualityScore?: QualityScoreData;
  validFrom?: string | Date;
  validUntil?: string | Date;
}

export interface QualityScoreData {
  score: number;
  factors: Record<string, number>;
}

export interface SaveMemoryResult {
  id: number;
  isDuplicate: boolean;
  existingId?: number;
  linksCreated?: number;
}

export interface MemoryBatchResult {
  saved: number;
  skipped: number;
  results: Array<{
    index: number;
    isDuplicate: boolean;
    id?: number;
    reason: 'duplicate' | 'saved';
    similarity?: number;
  }>;
}

export interface MemorySearchResult extends Memory {
  similarity: number;
}

export interface GlobalMemory {
  id: number;
  content: string;
  tags: string[];
  source: string | null;
  project: string | null;
  type: MemoryType | null;
  quality_score: number | null;
  quality_factors: Record<string, number> | null;
  created_at: string;
  isGlobal: true;
}

export interface GlobalMemorySearchResult extends GlobalMemory {
  access_count?: number;
  last_accessed?: string | null;
  valid_from?: string | null;
  valid_until?: string | null;
  correction_count?: number;
  is_invariant?: boolean;
  priority_score?: number | null;
  similarity: number;
}

export interface SqliteGlobalMemoryStats {
  total_memories: number;
  oldest_memory: string | null;
  newest_memory: string | null;
  projects: string[];
}

export interface PostgresGlobalMemoryStats {
  total: number;
  by_type: Record<string, number>;
  by_quality: { high: number; medium: number; low: number; unscored: number };
}

export type GlobalMemoryStats = SqliteGlobalMemoryStats | PostgresGlobalMemoryStats;

export interface MemoryStats {
  total_memories: number;
  active_memories: number;
  invalidated_memories: number;
  oldest_memory: string | null;
  newest_memory: string | null;
  by_type: Record<string, number>;
  stale_count: number;
}

export interface ConsolidationRecord {
  mergedMemoryId: number;
  mergedContent: string;
  originalIds: number[];
  mergedAt: string;
}

// ============================================================================
// Search Result Types
// ============================================================================

export interface SearchResult {
  file_path: string;
  content: string;
  start_line: number;
  end_line: number;
  similarity: number;
  symbol_name?: string | null;
  symbol_type?: string | null;
  signature?: string | null;
}

export interface HybridSearchResult extends SearchResult {
  bm25Score?: number;
  vectorScore?: number;
}

export interface HybridMemoryResult {
  id: number;
  content: string;
  tags: string[];
  source: string | null;
  type: MemoryType | null;
  created_at: string;
  similarity: number;
  bm25Score?: number;
  vectorScore?: number;
  last_accessed?: string | null;
  access_count?: number;
  valid_from?: string | null;
  valid_until?: string | null;
}

export interface HybridGlobalMemoryResult {
  id: number;
  content: string;
  tags: string[];
  source: string | null;
  project: string | null;
  type: MemoryType | null;
  created_at: string;
  similarity: number;
  bm25Score?: number;
  vectorScore?: number;
}

// ============================================================================
// Memory Links / Graph Types
// ============================================================================

export const LINK_RELATIONS = [
  'related',
  'caused_by',
  'leads_to',
  'similar_to',
  'contradicts',
  'implements',
  'supersedes',
  'references',
  // Bridge edges: code ↔ knowledge
  'documents',
  'bug_in',
  'test_covers',
  'motivates',
] as const;

export type LinkRelation = (typeof LINK_RELATIONS)[number];

export interface MemoryLink {
  id: number;
  source_id: number;
  target_id: number;
  relation: LinkRelation;
  weight: number;
  valid_from: string | null;
  valid_until: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

/** Metadata for bridge edges (code ↔ knowledge). */
export interface BridgeEdgeMetadata {
  /** Code file path this edge references */
  code_path?: string;
  /**
   * All code paths accumulated across conflict-merges on the same
   * (source_id, target_id, relation) row. Populated by the PostgreSQL
   * upsert; code_path holds the most-recent single path for backward
   * compatibility.
   */
  code_paths?: string[];
  /** Symbol name within the file */
  symbol_name?: string;
  /** Line range [start, end] */
  line_range?: [number, number];
  /** Auto-detected or manual */
  detection: 'auto' | 'manual';
}

export interface MemoryLinkInput {
  sourceId: number;
  targetId: number;
  relation?: LinkRelation;
  weight?: number;
  validFrom?: string | Date;
  validUntil?: string | Date;
  metadata?: Record<string, unknown>;
}

export interface MemoryWithLinks extends Memory {
  outgoing_links: Array<{
    target_id: number;
    relation: LinkRelation;
    weight: number;
    target_content?: string;
    valid_from?: string | null;
    valid_until?: string | null;
  }>;
  incoming_links: Array<{
    source_id: number;
    relation: LinkRelation;
    weight: number;
    source_content?: string;
    valid_from?: string | null;
    valid_until?: string | null;
  }>;
}

export interface ConnectedMemory {
  memory: MemoryRecord;
  depth: number;
  path: number[];
}

export interface LinkInfo {
  outgoing: MemoryLink[];
  incoming: MemoryLink[];
}

export interface LinkCandidate {
  id: number;
  similarity: number;
}

export interface GraphStats {
  total_memories: number;
  total_links: number;
  avg_links_per_memory: number;
  isolated_memories: number;
  relations: Record<string, number>;
}

export interface GraphStatsAsOf {
  total_memories: number;
  total_links: number;
  avg_links_per_memory: number;
  relations: Record<string, number>;
}

// ============================================================================
// Token Stats Types
// ============================================================================

export type TokenEventType = 'recall' | 'search' | 'search_code' | 'session_summary';

export interface TokenStatRecord {
  event_type: TokenEventType;
  query?: string;
  returned_tokens: number;
  full_source_tokens: number;
  savings_tokens: number;
  files_count?: number;
  chunks_count?: number;
  model?: string;
  estimated_cost?: number;
}

export interface TokenStatsAggregated {
  event_type: TokenEventType;
  total_calls: number;
  total_returned_tokens: number;
  total_full_source_tokens: number;
  total_savings_tokens: number;
  total_estimated_cost: number;
  avg_returned_tokens: number;
  avg_savings_tokens: number;
  avg_savings_percent: number;
}

export interface TokenStatsByEvent {
  event_type: string;
  query_count: number;
  total_returned_tokens: number;
  total_full_source_tokens: number;
  total_savings_tokens: number;
  total_estimated_cost: number;
}

export interface TokenStatsSummaryLegacy {
  total_queries: number;
  total_returned_tokens: number;
  total_full_source_tokens: number;
  total_savings_tokens: number;
  total_estimated_cost: number;
}

export interface TokenStatsSummaryNormalized {
  total_calls: number;
  total_returned_tokens: number;
  total_full_source_tokens: number;
  total_savings_tokens: number;
  total_estimated_cost: number;
  savings_percent: number;
  by_event_type: TokenStatsByEvent[];
}

export type TokenStatsSummary = TokenStatsSummaryLegacy | TokenStatsSummaryNormalized;

// ============================================================================
// Retention Types
// ============================================================================

export interface MemoryForRetention {
  id: number;
  content: string;
  quality_score: number | null;
  access_count: number;
  created_at: string;
  last_accessed: string | null;
}

// ============================================================================
// Web Search History Types
// ============================================================================

export type WebSearchToolName = 'succ_quick_search' | 'succ_web_search' | 'succ_deep_research';

export interface WebSearchHistoryRecord {
  id: number;
  tool_name: WebSearchToolName;
  model: string;
  query: string;
  prompt_tokens: number;
  completion_tokens: number;
  estimated_cost_usd: number;
  citations_count: number;
  has_reasoning: boolean;
  response_length_chars: number;
  created_at: string;
}

export interface WebSearchHistoryInput {
  tool_name: WebSearchToolName;
  model: string;
  query: string;
  prompt_tokens: number;
  completion_tokens: number;
  estimated_cost_usd: number;
  citations_count: number;
  has_reasoning: boolean;
  response_length_chars: number;
}

export interface WebSearchHistoryFilter {
  tool_name?: WebSearchToolName;
  model?: string;
  query_text?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
}

export interface WebSearchHistorySummary {
  total_searches: number;
  total_cost_usd: number;
  by_tool: Record<string, { count: number; cost: number }>;
  today_searches: number;
  today_cost_usd: number;
}

// ============================================================================
// Vector Search Types (for VectorStore interface)
// ============================================================================

export interface VectorSearchResult {
  id: number;
  similarity: number;
}

export interface VectorItem {
  id: number;
  embedding: number[];
}
