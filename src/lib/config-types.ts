/**
 * Type definitions for succ configuration
 *
 * All interfaces and type aliases extracted from config.ts
 */

export interface GateConfig {
  type: string;
  command: string;
  required?: boolean;
  timeout_ms?: number;
}

export interface SubdirGateConfig {
  gates?: GateConfig[];
  disable?: string[];
}

export interface CommandSafetyGuardConfig {
  /** Guard mode: 'deny' blocks, 'ask' prompts user, 'off' disables (default: 'deny') */
  mode?: 'deny' | 'ask' | 'off';
  /** Commands to always allow even if they match dangerous patterns */
  allowlist?: string[];
  /** Custom regex patterns to block (user-defined blacklist) */
  customPatterns?: CommandSafetyPattern[];
}

export interface CommandSafetyPattern {
  /** Regex pattern string to match against the command */
  pattern: string;
  /** Why this command is blocked */
  reason?: string;
  /** Regex flags (e.g. 'i' for case-insensitive) */
  flags?: string;
}

export interface QualityGatesConfig {
  auto_detect?: boolean;
  gates?: GateConfig[];
  disable?: string[];
  subdirs?: Record<string, SubdirGateConfig>;
}

export interface SuccConfig {
  // Runtime embedding tuning (not LLM config — stays at top level)
  embedding_local_batch_size?: number; // Batch size for local embeddings (default: 16)
  embedding_local_concurrency?: number; // Concurrent batches for local embeddings (default: 4)
  embedding_worker_pool_enabled?: boolean; // Use worker thread pool for local embeddings (default: true)
  embedding_worker_pool_size?: number; // Worker pool size (default: auto based on CPU cores)
  embedding_worker_pool_max?: number; // Max worker pool size cap (default: 8)
  embedding_cache_size?: number; // Embedding LRU cache size (default: 500)
  chunk_size: number;
  chunk_overlap: number;
  // GPU acceleration settings
  gpu_enabled?: boolean; // Enable GPU acceleration (auto-detect by default)
  gpu_device?: 'cuda' | 'directml' | 'coreml' | 'webgpu' | 'cpu'; // Preferred GPU backend
  // Knowledge graph settings
  graph_auto_link?: boolean; // Auto-link new memories to similar ones (default: true)
  graph_link_threshold?: number; // Similarity threshold for auto-linking (default: 0.7)
  graph_auto_export?: boolean; // Auto-export graph to Obsidian on changes (default: false)
  graph_export_format?: 'obsidian' | 'json'; // Export format (default: obsidian)
  graph_export_path?: string; // Custom export path (default: .succ/brain/graph)
  // Quality scoring feature toggles (mode/model/api under llm.quality.*)
  quality_scoring_enabled?: boolean; // Enable quality scoring for memories (default: true)
  quality_scoring_threshold?: number; // Minimum quality score to keep (0-1, default: 0)
  // Sensitive info filter settings
  sensitive_filter_enabled?: boolean; // Enable sensitive info detection (default: true)
  sensitive_auto_redact?: boolean; // Auto-redact sensitive info without prompting (default: false)
  // Consolidation settings
  consolidation_llm_default?: boolean; // Use LLM merge by default in consolidate (default: true)
  // Dead-end tracking settings
  dead_end_boost?: number; // Similarity boost for dead-end memories in recall results (default: 0.15, 0 to disable)
  // Remember settings
  remember_extract_default?: boolean; // Use LLM extraction by default in remember (default: true)
  // Idle reflection settings (sleep-time compute)
  idle_reflection?: IdleReflectionConfig;
  // Idle watcher settings (smart activity-based reflections)
  idle_watcher?: IdleWatcherConfig;
  // BPE tokenizer settings (optional enhancement to Ronin segmentation)
  bpe?: BPETokenizerConfig;
  // Retention policy settings (auto-cleanup with decay)
  retention?: RetentionPolicyConfig;
  // Temporal awareness settings (time-weighted scoring)
  temporal?: TemporalConfig;
  // Daemon settings (unified service)
  daemon?: DaemonConfig;
  // Compact briefing settings (context after /compact)
  compact_briefing?: CompactBriefingConfig;
  // Commit format settings
  includeCoAuthoredBy?: boolean; // Include commit guidelines in session-start hook (default: true)
  preCommitReview?: boolean; // Run succ-diff-reviewer agent before git commit (default: false)
  communicationAutoAdapt?: boolean; // Allow Claude to auto-update communication preferences in soul.md (default: true)
  communicationTrackHistory?: boolean; // Log communication style changes to brain vault for Obsidian graph (default: false)
  // Command safety guard (PreToolUse hook) — blocks dangerous git/filesystem operations
  commandSafetyGuard?: CommandSafetyGuardConfig;
  // Skills discovery and suggestion settings
  skills?: SkillsConfig;
  // Unified LLM settings — ALL LLM/embedding/analyze config lives here
  llm?: LLMConfig;
  // Storage backend settings (SQLite, PostgreSQL, Qdrant)
  storage?: StorageConfig;
  // Quality gate settings for PRD pipeline
  quality_gates?: QualityGatesConfig;
  // Readiness gate: confidence assessment for search results
  readiness_gate?: ReadinessGateConfig;
  // Graph enrichment: LLM relation extraction
  graph_llm_relations?: GraphLLMRelationsConfig;
  // Graph enrichment: contextual proximity linking
  graph_contextual_proximity?: GraphContextualProximityConfig;
  // Graph enrichment: community detection
  graph_community_detection?: GraphCommunityDetectionConfig;
  // Graph enrichment: centrality scoring
  graph_centrality?: GraphCentralityConfig;
  // md.succ.ai URL (HTML→Markdown API for succ_fetch tool)
  md_api_url?: string;
  // Web search settings (Perplexity Sonar via OpenRouter)
  web_search?: WebSearchConfig;
  // Retrieval tuning (hybrid search parameters)
  retrieval?: RetrievalConfig;
  // Mid-conversation observer settings
  observer?: ObserverConfig;
  // Error reporting (brain-faults.log + webhook + sentry)
  error_reporting?: ErrorReportingConfig;
}

/**
 * Storage Config - multi-backend database support
 *
 * Supports SQLite (default), PostgreSQL, and optional Qdrant for vectors.
 * Default: SQLite with sqlite-vec (current behavior, no config needed)
 */
export interface StorageConfig {
  /** SQL backend: 'sqlite' (default) or 'postgresql' */
  backend?: 'sqlite' | 'postgresql';
  /** Vector backend: 'builtin' (sqlite-vec/pgvector) or 'qdrant' */
  vector?: 'builtin' | 'qdrant';
  /** SQLite-specific settings */
  sqlite?: {
    /** Override default path for local database */
    path?: string;
    /** Override default path for global database */
    global_path?: string;
    /** Enable WAL mode (default: true for global, false for local) */
    wal_mode?: boolean;
    /** Busy timeout in ms (default: 5000) */
    busy_timeout?: number;
  };
  /** PostgreSQL-specific settings */
  postgresql?: {
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
  };
  /** Qdrant-specific settings (when vector: 'qdrant') */
  qdrant?: {
    /** Qdrant server URL (default: http://localhost:6333) */
    url?: string;
    /** API key for authentication */
    api_key?: string;
    /** Collection name prefix (default: succ_) */
    collection_prefix?: string;
  };
}

/**
 * Unified LLM Config — ALL LLM-related settings live here.
 *
 * Resolution chain (per task):
 *   api_key:  llm.{task}.api_key  →  llm.api_key  →  API_KEY env  →  undefined
 *   api_url:  llm.{task}.api_url  →  llm.api_url  →  "http://localhost:11434/v1"
 *   model:    llm.{task}.model    →  llm.model    →  default per mode
 *   mode:     llm.{task}.mode     →  llm.type     →  default per subsystem
 *
 * Modes:
 *   'local'  = built-in ONNX (embeddings + quality scoring only)
 *   'api'    = any OpenAI-compatible HTTP endpoint (Ollama, OpenRouter, nano-gpt, etc.)
 *   'claude' = Claude CLI subprocess (where applicable)
 *
 * OpenRouter headers (HTTP-Referer, X-Title) are auto-sent when api_url contains 'openrouter.ai'.
 */
export interface LLMConfig {
  api_key?: string; // ONE key for everything (overridden per-task if needed)
  api_url?: string; // Default endpoint (default: http://localhost:11434/v1)
  type?: 'claude' | 'api'; // Default LLM type (default: 'api')
  model?: string; // Default model
  max_tokens?: number; // Default max tokens (default: 2000)
  temperature?: number; // Default temperature (default: 0.3)
  transport?: 'process' | 'ws' | 'http'; // Claude transport mode
  ws_idle_timeout?: number; // WS transport idle timeout in seconds (default: 300)

  // Claude-specific overrides
  claude?: {
    model?: string;
    transport?: 'process' | 'ws';
  };

  // Per-task overrides — each inherits from top-level llm.*
  embeddings?: {
    mode?: 'local' | 'api'; // Default: 'local' (ONNX)
    model?: string;
    api_url?: string; // Override endpoint for embeddings
    api_key?: string; // Override key for embeddings
    batch_size?: number; // Batch size for API (default: 32)
    dimensions?: number; // Override embedding dimensions
  };
  analyze?: {
    mode?: 'claude' | 'api'; // Default: 'claude'
    model?: string;
    api_url?: string;
    api_key?: string;
    temperature?: number;
    max_tokens?: number;
    concurrency?: number; // Concurrent API calls (default: 3)
  };
  quality?: {
    mode?: 'local' | 'api'; // Default: 'local' (ONNX)
    model?: string;
    api_url?: string;
    api_key?: string;
  };
  chat?: {
    mode?: 'claude' | 'api'; // Default: 'claude'
    model?: string;
    api_url?: string;
    api_key?: string;
    max_tokens?: number;
    temperature?: number;
  };
  sleep?: {
    enabled?: boolean; // Enable sleep agent (default: false)
    mode?: 'api'; // Always 'api' (claude = ToS issues)
    model?: string;
    api_url?: string;
    api_key?: string;
    max_tokens?: number;
    temperature?: number;
  };
  skills?: {
    mode?: 'claude' | 'api'; // Default: from llm.type
    model?: string;
    api_url?: string;
    api_key?: string;
  };
}

export interface SkillsConfig {
  enabled?: boolean; // Enable skills discovery (default: true)
  local_paths?: string[]; // Paths to scan for local skills (default: ['.claude/commands'])
  skyll?: {
    enabled?: boolean; // Enable Skyll API (default: true)
    endpoint?: string; // Skyll API endpoint (default: 'https://api.skyll.app')
    api_key?: string; // Skyll API key (optional, or use SKYLL_API_KEY env var)
    cache_ttl?: number; // Cache TTL in seconds (default: 604800 = 7 days)
    only_when_no_local?: boolean; // Only use Skyll when no local matches (default: true)
    rate_limit?: number; // Max requests per hour (default: 30)
  };
  auto_suggest?: {
    enabled?: boolean; // Enable auto-suggest (default: true)
    on_user_prompt?: boolean; // Suggest on user prompt (default: true)
    // LLM config now comes from llm.skills.* (mode, model, api_url, api_key)
    min_confidence?: number; // Min confidence for suggestions (default: 0.7)
    max_suggestions?: number; // Max suggestions to show (default: 2)
    cooldown_prompts?: number; // Cooldown between suggestions (default: 3)
    min_prompt_length?: number; // Min prompt length to trigger (default: 20)
  };
  track_usage?: boolean; // Track skill usage (default: true)
}

export interface CompactBriefingConfig {
  enabled?: boolean; // Enable compact briefing (default: true)
  format?: 'structured' | 'prose' | 'minimal'; // Output format (default: 'structured')
  // LLM config removed — was dead code (never read). Uses llm.* if needed.
  include_learnings?: boolean; // Include extracted learnings (default: true)
  include_memories?: boolean; // Include relevant memories (default: true)
  max_memories?: number; // Max relevant memories to include (default: 3)
  timeout_ms?: number; // API timeout in ms (default: 15000)
}

export interface DaemonConfig {
  enabled?: boolean; // Enable daemon (default: true)
  port_range_start?: number; // Starting port to try (default: 37842)
  watch?: {
    auto_start?: boolean; // Auto-start watch service (default: false)
    patterns?: string[]; // Patterns to watch (default: ['**/*.md'])
    include_code?: boolean; // Also watch code files (default: false)
    debounce_ms?: number; // Debounce interval (default: 500)
  };
  analyze?: {
    auto_start?: boolean; // Auto-start analyze service (default: false)
    interval_minutes?: number; // Analysis interval (default: 30)
    mode?: 'claude' | 'api'; // Analysis mode (default: 'claude')
  };
}

export interface RetentionPolicyConfig {
  enabled?: boolean; // Enable retention cleanup (default: false - manual only)
  decay_rate?: number; // Decay rate for recency factor (default: 0.01, at 100 days factor ≈ 0.5)
  access_weight?: number; // Weight per access for boost calculation (default: 0.1)
  max_access_boost?: number; // Maximum access boost multiplier (default: 2.0)
  keep_threshold?: number; // Effective score threshold to keep (default: 0.3)
  delete_threshold?: number; // Effective score threshold to delete (default: 0.15)
  default_quality_score?: number; // Default quality for memories without score (default: 0.5)
  auto_cleanup_interval_days?: number; // Days between auto-cleanup runs (default: 7)
  use_temporal_decay?: boolean; // Use exponential decay from temporal.ts instead of hyperbolic (default: true)
}

export interface TemporalConfig {
  enabled?: boolean; // Enable temporal scoring (default: true)
  // Scoring weights (must sum to 1.0)
  semantic_weight?: number; // Weight for semantic similarity (default: 0.8)
  recency_weight?: number; // Weight for time decay (default: 0.2)
  // Decay parameters
  decay_half_life_hours?: number; // Hours until score decays to 50% (default: 168 = 7 days)
  decay_floor?: number; // Minimum decay factor (default: 0.1)
  // Access boost
  access_boost_enabled?: boolean; // Enable access frequency boost (default: true)
  access_boost_factor?: number; // Score boost per access (default: 0.05)
  max_access_boost?: number; // Maximum access boost (default: 0.3)
  // Validity filtering
  filter_expired?: boolean; // Filter out expired facts (default: true)
}

export interface ReadinessGateConfig {
  enabled?: boolean; // Enable readiness gate for search results (default: false)
  thresholds?: {
    proceed?: number; // Confidence threshold for "proceed" (default: 0.7)
    warn?: number; // Confidence threshold for "warn" (default: 0.4)
  };
  expected_results?: number; // Expected result count for coverage calc (default: 5)
}

export interface GraphLLMRelationsConfig {
  enabled?: boolean; // Enable LLM relation extraction (default: false)
  auto_on_save?: boolean; // Auto-enrich links after memory save (default: false)
  batch_size?: number; // Batch size for LLM calls (default: 5)
}

export interface GraphContextualProximityConfig {
  enabled?: boolean; // Enable contextual proximity (default: false)
  min_cooccurrence?: number; // Min shared sources to create link (default: 2)
}

export interface GraphCommunityDetectionConfig {
  enabled?: boolean; // Enable community detection (default: false)
  max_iterations?: number; // Label propagation max iterations (default: 100)
  min_community_size?: number; // Min members to form a community (default: 2)
}

export interface GraphCentralityConfig {
  enabled?: boolean; // Enable centrality boost in recall (default: false)
  boost_weight?: number; // Weight of centrality boost (default: 0.1)
  cache_ttl_hours?: number; // Centrality cache TTL in hours (default: 24)
}

export interface WebSearchConfig {
  enabled?: boolean; // Enable web search tools (default: true)
  quick_search_model?: string; // Model for succ_quick_search (default: 'perplexity/sonar'). Alternatives: 'x-ai/grok-3-mini:online', 'openai/gpt-4o-mini:online', 'google/gemini-2.0-flash-001:online'
  quick_search_max_tokens?: number; // Max tokens for quick search (default: 2000)
  quick_search_timeout_ms?: number; // Timeout for quick search in ms (default: 15000)
  model?: string; // Model for succ_web_search (default: 'perplexity/sonar-pro'). Alternatives: 'x-ai/grok-3:online', 'google/gemini-2.5-pro-preview:online'. Any OpenRouter model with :online suffix works
  deep_research_model?: string; // Model for succ_deep_research (default: 'perplexity/sonar-deep-research'). Only Perplexity supports multi-step deep research natively
  max_tokens?: number; // Max tokens for web search response (default: 4000)
  deep_research_max_tokens?: number; // Max tokens for deep research (default: 8000)
  timeout_ms?: number; // Timeout for web search in ms (default: 30000)
  deep_research_timeout_ms?: number; // Timeout for deep research in ms (default: 120000)
  temperature?: number; // Temperature (default: 0.1 — low for factual search)
  save_to_memory?: boolean; // Auto-save search results to memory (default: true)
  daily_budget_usd?: number; // Daily spending limit in USD (default: 0 = unlimited)
}

export interface RetrievalConfig {
  bm25_alpha?: number; // BM25/vector balance: 0=pure BM25, 1=pure vector (default: 0.4)
  default_top_k?: number; // Default number of results for recall (default: 10)
  temporal_auto_skip?: boolean; // Auto-disable decay when all results <24h old (default: true)
  preference_quality_boost?: boolean; // Lower quality threshold for preference facts (default: true)
  quality_boost_enabled?: boolean; // Boost ranking by quality_score at retrieval time (default: false)
  quality_boost_weight?: number; // Weight for quality boost: 0=no effect, 1=full effect (default: 0.15)
  mmr_enabled?: boolean; // Maximal Marginal Relevance diversity reranking (default: false)
  mmr_lambda?: number; // MMR balance: 1=pure relevance, 0=pure diversity (default: 0.8)
  query_expansion_enabled?: boolean; // LLM-based query expansion for richer recall (default: false)
  query_expansion_mode?: 'claude' | 'api'; // LLM backend for expansion (default: from llm.type)
}

export interface ObserverConfig {
  enabled?: boolean; // Enable mid-conversation observer (default: true)
  min_tokens?: number; // Extract after N new tokens (default: 15000)
  max_minutes?: number; // Or after N minutes, whichever first (default: 10)
}

export interface ErrorReportingConfig {
  enabled?: boolean; // Enable fault logging (default: true)
  level?: 'error' | 'warn' | 'info' | 'debug'; // Minimum level to log (default: 'warn')
  max_file_size_mb?: number; // Rotation threshold in MB (default: 5)
  webhook_url?: string; // POST errors to this URL
  webhook_headers?: Record<string, string>; // Custom headers for webhook
  sentry_dsn?: string; // Sentry-compatible DSN (GlitchTip, self-hosted Sentry, etc.)
  sentry_environment?: string; // Sentry environment tag (default: 'production')
  sentry_sample_rate?: number; // Sentry sample rate 0-1 (default: 1.0)
}

export interface BPETokenizerConfig {
  enabled?: boolean; // Enable BPE tokenizer (default: false)
  vocab_size?: number; // Target vocabulary size (default: 5000)
  min_frequency?: number; // Minimum pair frequency to merge (default: 2)
  retrain_interval?: 'hourly' | 'daily'; // When to retrain (default: 'hourly')
}

export interface IdleWatcherConfig {
  enabled?: boolean; // Enable idle watcher (default: true)
  idle_minutes?: number; // Minutes of inactivity before reflection (default: 2)
  check_interval?: number; // Seconds between activity checks (default: 30)
  min_conversation_length?: number; // Minimum transcript entries before reflecting (default: 5)
  reflection_cooldown_minutes?: number; // Minutes between reflections for same session (default: 30)
}

export interface IdleReflectionConfig {
  enabled?: boolean; // Enable idle reflection (default: true)
  // Operations to perform during idle time
  operations?: {
    memory_consolidation?: boolean; // Merge similar memories, remove duplicates (default: true)
    graph_refinement?: boolean; // Auto-link memories by similarity (default: true)
    graph_enrichment?: boolean; // LLM enrich + proximity + communities + centrality (default: true)
    session_summary?: boolean; // Extract key facts from session transcript (default: true)
    precompute_context?: boolean; // Prepare context for next session-start (default: false)
    write_reflection?: boolean; // Write human-like reflection text (default: true)
    retention_cleanup?: boolean; // Delete decayed memories below threshold (default: true if retention.enabled)
  };
  // Thresholds for operations
  thresholds?: {
    similarity_for_merge?: number; // Cosine similarity to consider memories duplicates (default: 0.92)
    auto_link_threshold?: number; // Similarity threshold for graph auto-linking (default: 0.75)
    min_quality_for_summary?: number; // Min quality score for facts extracted from session (default: 0.5)
  };
  // Safety guards for consolidation
  consolidation_guards?: {
    min_memory_age_days?: number; // Don't consolidate memories younger than N days (default: 7)
    min_corpus_size?: number; // Don't consolidate if total memories < N (default: 20)
    require_llm_merge?: boolean; // Always use LLM for merge action, never destructive delete (default: true)
  };
  // Primary agent (always Claude via CLI)
  agent_model?: 'haiku' | 'sonnet' | 'opus'; // Claude model for reflection (default: 'haiku')
  // Optional secondary sleep agent (runs in parallel for heavy lifting)
  // Uses llm.sleep.* for mode/model/api_url/api_key
  sleep_agent?: {
    enabled?: boolean; // Enable secondary sleep agent (default: false — uses llm.sleep.enabled)
    // Which operations to offload to sleep agent
    handle_operations?: {
      memory_consolidation?: boolean; // Offload memory merge/dedup (default: true)
      session_summary?: boolean; // Offload fact extraction (default: true)
      precompute_context?: boolean; // Offload context preparation (default: true)
    };
  };
  // Processing limits
  max_memories_to_process?: number; // Max memories to consolidate per idle (default: 50)
  timeout_seconds?: number; // Max time for idle operations (default: 25)
}

/**
 * Resolved config for a specific LLM task.
 * All fields are resolved through the chain: task → global llm.* → env → defaults.
 */
export interface ResolvedLLMTaskConfig {
  mode: 'claude' | 'api' | 'local';
  model: string;
  api_url: string;
  api_key: string | undefined;
  max_tokens: number;
  temperature: number;
  /** Embeddings: batch size for API calls */
  batch_size?: number;
  /** Embeddings: expected dimensions */
  dimensions?: number;
  /** Analyze: concurrency for multi-pass agents */
  concurrency?: number;
}

/**
 * Configuration display structure for formatted output
 */
export interface ConfigDisplay {
  // Sources
  sources: {
    global: string;
    project: string | null;
    env: string[];
    api_key?: string;
  };
  // Unified LLM settings
  llm: {
    type: string;
    model: string;
    api_url: string;
    api_key?: string;
    max_tokens: number;
    temperature: number;
    transport?: string;
    // Per-task configs
    embeddings: { mode: string; model: string; api_url?: string };
    analyze: { mode: string; model: string; api_url?: string; concurrency: number };
    quality: { mode: string; model: string; api_url?: string };
    chat: { mode: string; model: string; max_tokens: number; temperature: number };
    sleep: { enabled: boolean; mode: string; model: string };
    skills: { mode: string; model: string };
  };
  // Storage backend settings
  storage: {
    backend: string;
    vector: string;
    sqlite?: { path?: string; global_path?: string; wal_mode?: boolean };
    postgresql?: {
      host?: string;
      port?: number;
      database?: string;
      ssl?: boolean;
      pool_size?: number;
      connection_string?: string;
    };
    qdrant?: { url?: string; collection_prefix?: string; api_key?: string };
  };
  // Chunking settings
  chunking: {
    chunk_size: number;
    chunk_overlap: number;
  };
  // GPU settings
  gpu: {
    enabled: boolean;
    device?: string;
  };
  // Quality scoring feature settings
  quality: {
    enabled: boolean;
    threshold: number;
  };
  // Sensitive filter settings
  sensitive: {
    enabled: boolean;
    auto_redact: boolean;
  };
  // Knowledge graph settings
  graph: {
    auto_link: boolean;
    link_threshold: number;
    auto_export: boolean;
    export_format: 'obsidian' | 'json';
    export_path?: string;
  };
  // Idle reflection settings
  idle_reflection: {
    enabled: boolean;
    agent_model: 'haiku' | 'sonnet' | 'opus';
    operations: {
      memory_consolidation: boolean;
      graph_refinement: boolean;
      graph_enrichment: boolean;
      session_summary: boolean;
      precompute_context: boolean;
      write_reflection: boolean;
      retention_cleanup: boolean;
    };
    thresholds: {
      similarity_for_merge: number;
    };
    consolidation_guards: {
      min_memory_age_days: number;
      min_corpus_size: number;
      require_llm_merge: boolean;
    };
    sleep_agent: {
      enabled: boolean;
    };
  };
  // Idle watcher settings
  idle_watcher: {
    enabled: boolean;
    idle_minutes: number;
    check_interval: number;
    min_conversation_length: number;
  };
  // Retrieval settings
  retrieval: {
    bm25_alpha: number;
    default_top_k: number;
    temporal_auto_skip: boolean;
    quality_boost_enabled: boolean;
    quality_boost_weight: number;
    mmr_enabled: boolean;
    mmr_lambda: number;
    query_expansion_enabled: boolean;
    query_expansion_mode: string;
  };
  // Web search settings
  web_search: {
    enabled: boolean;
    quick_search_model: string;
    model: string;
    deep_research_model: string;
    max_tokens: number;
    deep_research_timeout_ms: number;
    temperature: number;
    save_to_memory: boolean;
    daily_budget_usd: number;
  };
  // Error reporting settings
  error_reporting: {
    enabled: boolean;
    level: string;
    max_file_size_mb: number;
    webhook_url: string;
    sentry_dsn: string;
  };
}

/**
 * Daemon status information
 */
export interface DaemonStatus {
  name: string;
  running: boolean;
  pid?: number;
  pidFile?: string;
  logFile?: string;
}

/**
 * Global config structure (for onboarding state)
 */
export interface GlobalConfig {
  onboarding_completed?: boolean;
  onboarding_completed_at?: string;
  onboarding_mode?: 'wizard' | 'ai-chat' | 'skipped';
  llm?: LLMConfig;
  [key: string]: unknown;
}

/**
 * Idle operation types
 */
export type IdleOperation =
  | 'memory_consolidation'
  | 'graph_refinement'
  | 'graph_enrichment'
  | 'session_summary'
  | 'precompute_context'
  | 'write_reflection';

/**
 * Operation assignment structure
 */
export interface OperationAssignment {
  operation: IdleOperation;
  agent: 'claude' | 'sleep';
  enabled: boolean;
}
