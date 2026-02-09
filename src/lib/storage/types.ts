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
  /** Enable SSL */
  ssl?: boolean;
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
}

export interface DocumentBatch extends DocumentInput {}

export interface DocumentBatchWithHash extends DocumentBatch {
  hash: string;
}

export const MEMORY_TYPES = ['observation', 'decision', 'learning', 'error', 'pattern', 'dead_end'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

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
  created_at: string;
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
  similarity: number;
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
}

export interface HybridSearchResult extends SearchResult {
  bm25Score?: number;
  vectorScore?: number;
}

export interface HybridMemoryResult {
  id: number;
  content: string;
  tags: string | null;
  source: string | null;
  type: string | null;
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
  tags: string | null;
  source: string | null;
  project: string | null;
  type: string | null;
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
}

export interface MemoryLinkInput {
  sourceId: number;
  targetId: number;
  relation?: LinkRelation;
  weight?: number;
  validFrom?: string | Date;
  validUntil?: string | Date;
}

export interface MemoryWithLinks extends Memory {
  outgoing_links: Array<{
    target_id: number;
    relation: LinkRelation;
    weight: number;
    target_content: string;
  }>;
  incoming_links: Array<{
    source_id: number;
    relation: LinkRelation;
    weight: number;
    source_content: string;
  }>;
}

export interface ConnectedMemory {
  memory: Memory;
  depth: number;
  path: number[];
}

export interface GraphStats {
  total_memories: number;
  total_links: number;
  avg_links_per_memory: number;
  isolated_memories: number;
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
