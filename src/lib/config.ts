import fs from 'fs';
import path from 'path';
import os from 'os';

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
  embedding_local_batch_size?: number;  // Batch size for local embeddings (default: 16)
  embedding_local_concurrency?: number;  // Concurrent batches for local embeddings (default: 4)
  embedding_worker_pool_enabled?: boolean;  // Use worker thread pool for local embeddings (default: true)
  embedding_worker_pool_size?: number;  // Worker pool size (default: auto based on CPU cores)
  embedding_worker_pool_max?: number;  // Max worker pool size cap (default: 8)
  embedding_cache_size?: number;  // Embedding LRU cache size (default: 500)
  chunk_size: number;
  chunk_overlap: number;
  // GPU acceleration settings
  gpu_enabled?: boolean;  // Enable GPU acceleration (auto-detect by default)
  gpu_device?: 'cuda' | 'directml' | 'coreml' | 'webgpu' | 'cpu';  // Preferred GPU backend
  // Knowledge graph settings
  graph_auto_link?: boolean;  // Auto-link new memories to similar ones (default: true)
  graph_link_threshold?: number;  // Similarity threshold for auto-linking (default: 0.7)
  graph_auto_export?: boolean;  // Auto-export graph to Obsidian on changes (default: false)
  graph_export_format?: 'obsidian' | 'json';  // Export format (default: obsidian)
  graph_export_path?: string;  // Custom export path (default: .succ/brain/graph)
  // Quality scoring feature toggles (mode/model/api under llm.quality.*)
  quality_scoring_enabled?: boolean;  // Enable quality scoring for memories (default: true)
  quality_scoring_threshold?: number;  // Minimum quality score to keep (0-1, default: 0)
  // Sensitive info filter settings
  sensitive_filter_enabled?: boolean;  // Enable sensitive info detection (default: true)
  sensitive_auto_redact?: boolean;  // Auto-redact sensitive info without prompting (default: false)
  // Consolidation settings
  consolidation_llm_default?: boolean;  // Use LLM merge by default in consolidate (default: true)
  // Dead-end tracking settings
  dead_end_boost?: number;  // Similarity boost for dead-end memories in recall results (default: 0.15, 0 to disable)
  // Remember settings
  remember_extract_default?: boolean;  // Use LLM extraction by default in remember (default: true)
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
  includeCoAuthoredBy?: boolean;  // Include commit guidelines in session-start hook (default: true)
  preCommitReview?: boolean;      // Run succ-diff-reviewer agent before git commit (default: false)
  communicationAutoAdapt?: boolean;  // Allow Claude to auto-update communication preferences in soul.md (default: true)
  communicationTrackHistory?: boolean;  // Log communication style changes to brain vault for Obsidian graph (default: false)
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
  api_key?: string;              // ONE key for everything (overridden per-task if needed)
  api_url?: string;              // Default endpoint (default: http://localhost:11434/v1)
  type?: 'claude' | 'api';      // Default LLM type (default: 'api')
  model?: string;                // Default model
  max_tokens?: number;           // Default max tokens (default: 2000)
  temperature?: number;          // Default temperature (default: 0.3)
  transport?: 'process' | 'ws' | 'http';  // Claude transport mode

  // Claude-specific overrides
  claude?: {
    model?: string;
    transport?: 'process' | 'ws';
  };

  // Per-task overrides — each inherits from top-level llm.*
  embeddings?: {
    mode?: 'local' | 'api';     // Default: 'local' (ONNX)
    model?: string;
    api_url?: string;           // Override endpoint for embeddings
    api_key?: string;           // Override key for embeddings
    batch_size?: number;        // Batch size for API (default: 32)
    dimensions?: number;        // Override embedding dimensions
  };
  analyze?: {
    mode?: 'claude' | 'api';    // Default: 'claude'
    model?: string;
    api_url?: string;
    api_key?: string;
    temperature?: number;
    max_tokens?: number;
    concurrency?: number;       // Concurrent API calls (default: 3)
  };
  quality?: {
    mode?: 'local' | 'api';     // Default: 'local' (ONNX)
    model?: string;
    api_url?: string;
    api_key?: string;
  };
  chat?: {
    mode?: 'claude' | 'api';    // Default: 'claude'
    model?: string;
    api_url?: string;
    api_key?: string;
    max_tokens?: number;
    temperature?: number;
  };
  sleep?: {
    enabled?: boolean;           // Enable sleep agent (default: false)
    mode?: 'api';               // Always 'api' (claude = ToS issues)
    model?: string;
    api_url?: string;
    api_key?: string;
    max_tokens?: number;
    temperature?: number;
  };
  skills?: {
    mode?: 'claude' | 'api';    // Default: from llm.type
    model?: string;
    api_url?: string;
    api_key?: string;
  };
}

export interface SkillsConfig {
  enabled?: boolean;  // Enable skills discovery (default: true)
  local_paths?: string[];  // Paths to scan for local skills (default: ['.claude/commands'])
  skyll?: {
    enabled?: boolean;  // Enable Skyll API (default: true)
    endpoint?: string;  // Skyll API endpoint (default: 'https://api.skyll.app')
    api_key?: string;  // Skyll API key (optional, or use SKYLL_API_KEY env var)
    cache_ttl?: number;  // Cache TTL in seconds (default: 604800 = 7 days)
    only_when_no_local?: boolean;  // Only use Skyll when no local matches (default: true)
    rate_limit?: number;  // Max requests per hour (default: 30)
  };
  auto_suggest?: {
    enabled?: boolean;  // Enable auto-suggest (default: true)
    on_user_prompt?: boolean;  // Suggest on user prompt (default: true)
    // LLM config now comes from llm.skills.* (mode, model, api_url, api_key)
    min_confidence?: number;  // Min confidence for suggestions (default: 0.7)
    max_suggestions?: number;  // Max suggestions to show (default: 2)
    cooldown_prompts?: number;  // Cooldown between suggestions (default: 3)
    min_prompt_length?: number;  // Min prompt length to trigger (default: 20)
  };
  track_usage?: boolean;  // Track skill usage (default: true)
}

export interface CompactBriefingConfig {
  enabled?: boolean;  // Enable compact briefing (default: true)
  format?: 'structured' | 'prose' | 'minimal';  // Output format (default: 'structured')
  // LLM config removed — was dead code (never read). Uses llm.* if needed.
  include_learnings?: boolean;  // Include extracted learnings (default: true)
  include_memories?: boolean;  // Include relevant memories (default: true)
  max_memories?: number;  // Max relevant memories to include (default: 3)
  timeout_ms?: number;  // API timeout in ms (default: 15000)
}

export interface DaemonConfig {
  enabled?: boolean;  // Enable daemon (default: true)
  port_range_start?: number;  // Starting port to try (default: 37842)
  watch?: {
    auto_start?: boolean;  // Auto-start watch service (default: false)
    patterns?: string[];  // Patterns to watch (default: ['**/*.md'])
    include_code?: boolean;  // Also watch code files (default: false)
    debounce_ms?: number;  // Debounce interval (default: 500)
  };
  analyze?: {
    auto_start?: boolean;  // Auto-start analyze service (default: false)
    interval_minutes?: number;  // Analysis interval (default: 30)
    mode?: 'claude' | 'api';  // Analysis mode (default: 'claude')
  };
}

export interface RetentionPolicyConfig {
  enabled?: boolean;  // Enable retention cleanup (default: false - manual only)
  decay_rate?: number;  // Decay rate for recency factor (default: 0.01, at 100 days factor ≈ 0.5)
  access_weight?: number;  // Weight per access for boost calculation (default: 0.1)
  max_access_boost?: number;  // Maximum access boost multiplier (default: 2.0)
  keep_threshold?: number;  // Effective score threshold to keep (default: 0.3)
  delete_threshold?: number;  // Effective score threshold to delete (default: 0.15)
  default_quality_score?: number;  // Default quality for memories without score (default: 0.5)
  auto_cleanup_interval_days?: number;  // Days between auto-cleanup runs (default: 7)
  use_temporal_decay?: boolean;  // Use exponential decay from temporal.ts instead of hyperbolic (default: true)
}

export interface TemporalConfig {
  enabled?: boolean;  // Enable temporal scoring (default: true)
  // Scoring weights (must sum to 1.0)
  semantic_weight?: number;  // Weight for semantic similarity (default: 0.8)
  recency_weight?: number;  // Weight for time decay (default: 0.2)
  // Decay parameters
  decay_half_life_hours?: number;  // Hours until score decays to 50% (default: 168 = 7 days)
  decay_floor?: number;  // Minimum decay factor (default: 0.1)
  // Access boost
  access_boost_enabled?: boolean;  // Enable access frequency boost (default: true)
  access_boost_factor?: number;  // Score boost per access (default: 0.05)
  max_access_boost?: number;  // Maximum access boost (default: 0.3)
  // Validity filtering
  filter_expired?: boolean;  // Filter out expired facts (default: true)
}

export interface ReadinessGateConfig {
  enabled?: boolean;  // Enable readiness gate for search results (default: false)
  thresholds?: {
    proceed?: number;  // Confidence threshold for "proceed" (default: 0.7)
    warn?: number;     // Confidence threshold for "warn" (default: 0.4)
  };
  expected_results?: number;  // Expected result count for coverage calc (default: 5)
}

export interface GraphLLMRelationsConfig {
  enabled?: boolean;  // Enable LLM relation extraction (default: false)
  auto_on_save?: boolean;  // Auto-enrich links after memory save (default: false)
  batch_size?: number;  // Batch size for LLM calls (default: 5)
}

export interface GraphContextualProximityConfig {
  enabled?: boolean;  // Enable contextual proximity (default: false)
  min_cooccurrence?: number;  // Min shared sources to create link (default: 2)
}

export interface GraphCommunityDetectionConfig {
  enabled?: boolean;  // Enable community detection (default: false)
  max_iterations?: number;  // Label propagation max iterations (default: 100)
  min_community_size?: number;  // Min members to form a community (default: 2)
}

export interface GraphCentralityConfig {
  enabled?: boolean;  // Enable centrality boost in recall (default: false)
  boost_weight?: number;  // Weight of centrality boost (default: 0.1)
  cache_ttl_hours?: number;  // Centrality cache TTL in hours (default: 24)
}

export interface WebSearchConfig {
  enabled?: boolean;                  // Enable web search tools (default: true)
  quick_search_model?: string;        // Model for succ_quick_search (default: 'perplexity/sonar'). Alternatives: 'x-ai/grok-3-mini:online', 'openai/gpt-4o-mini:online', 'google/gemini-2.0-flash-001:online'
  quick_search_max_tokens?: number;   // Max tokens for quick search (default: 2000)
  quick_search_timeout_ms?: number;   // Timeout for quick search in ms (default: 15000)
  model?: string;                     // Model for succ_web_search (default: 'perplexity/sonar-pro'). Alternatives: 'x-ai/grok-3:online', 'google/gemini-2.5-pro-preview:online'. Any OpenRouter model with :online suffix works
  deep_research_model?: string;       // Model for succ_deep_research (default: 'perplexity/sonar-deep-research'). Only Perplexity supports multi-step deep research natively
  max_tokens?: number;                // Max tokens for web search response (default: 4000)
  deep_research_max_tokens?: number;  // Max tokens for deep research (default: 8000)
  timeout_ms?: number;                // Timeout for web search in ms (default: 30000)
  deep_research_timeout_ms?: number;  // Timeout for deep research in ms (default: 120000)
  temperature?: number;               // Temperature (default: 0.1 — low for factual search)
  save_to_memory?: boolean;           // Auto-save search results to memory (default: true)
  daily_budget_usd?: number;          // Daily spending limit in USD (default: 0 = unlimited)
}

export interface RetrievalConfig {
  bm25_alpha?: number;  // BM25/vector balance: 0=pure BM25, 1=pure vector (default: 0.4)
  default_top_k?: number;  // Default number of results for recall (default: 10)
  temporal_auto_skip?: boolean;  // Auto-disable decay when all results <24h old (default: true)
  preference_quality_boost?: boolean;  // Lower quality threshold for preference facts (default: true)
  quality_boost_enabled?: boolean;  // Boost ranking by quality_score at retrieval time (default: false)
  quality_boost_weight?: number;  // Weight for quality boost: 0=no effect, 1=full effect (default: 0.15)
  mmr_enabled?: boolean;  // Maximal Marginal Relevance diversity reranking (default: false)
  mmr_lambda?: number;  // MMR balance: 1=pure relevance, 0=pure diversity (default: 0.8)
  query_expansion_enabled?: boolean;  // LLM-based query expansion for richer recall (default: false)
  query_expansion_mode?: 'claude' | 'api';  // LLM backend for expansion (default: from llm.type)
}

export interface ObserverConfig {
  enabled?: boolean;  // Enable mid-conversation observer (default: true)
  min_tokens?: number;  // Extract after N new tokens (default: 15000)
  max_minutes?: number;  // Or after N minutes, whichever first (default: 10)
}

export interface ErrorReportingConfig {
  enabled?: boolean;              // Enable fault logging (default: true)
  level?: 'error' | 'warn' | 'info' | 'debug';  // Minimum level to log (default: 'warn')
  max_file_size_mb?: number;      // Rotation threshold in MB (default: 5)
  webhook_url?: string;           // POST errors to this URL
  webhook_headers?: Record<string, string>;  // Custom headers for webhook
  sentry_dsn?: string;            // Sentry-compatible DSN (GlitchTip, self-hosted Sentry, etc.)
  sentry_environment?: string;    // Sentry environment tag (default: 'production')
  sentry_sample_rate?: number;    // Sentry sample rate 0-1 (default: 1.0)
}

export interface BPETokenizerConfig {
  enabled?: boolean;  // Enable BPE tokenizer (default: false)
  vocab_size?: number;  // Target vocabulary size (default: 5000)
  min_frequency?: number;  // Minimum pair frequency to merge (default: 2)
  retrain_interval?: 'hourly' | 'daily';  // When to retrain (default: 'hourly')
}

export interface IdleWatcherConfig {
  enabled?: boolean;  // Enable idle watcher (default: true)
  idle_minutes?: number;  // Minutes of inactivity before reflection (default: 2)
  check_interval?: number;  // Seconds between activity checks (default: 30)
  min_conversation_length?: number;  // Minimum transcript entries before reflecting (default: 5)
  reflection_cooldown_minutes?: number;  // Minutes between reflections for same session (default: 30)
}

export interface IdleReflectionConfig {
  enabled?: boolean;  // Enable idle reflection (default: true)
  // Operations to perform during idle time
  operations?: {
    memory_consolidation?: boolean;  // Merge similar memories, remove duplicates (default: true)
    graph_refinement?: boolean;  // Auto-link memories by similarity (default: true)
    graph_enrichment?: boolean;  // LLM enrich + proximity + communities + centrality (default: true)
    session_summary?: boolean;  // Extract key facts from session transcript (default: true)
    precompute_context?: boolean;  // Prepare context for next session-start (default: false)
    write_reflection?: boolean;  // Write human-like reflection text (default: true)
    retention_cleanup?: boolean;  // Delete decayed memories below threshold (default: true if retention.enabled)
  };
  // Thresholds for operations
  thresholds?: {
    similarity_for_merge?: number;  // Cosine similarity to consider memories duplicates (default: 0.92)
    auto_link_threshold?: number;  // Similarity threshold for graph auto-linking (default: 0.75)
    min_quality_for_summary?: number;  // Min quality score for facts extracted from session (default: 0.5)
  };
  // Safety guards for consolidation
  consolidation_guards?: {
    min_memory_age_days?: number;  // Don't consolidate memories younger than N days (default: 7)
    min_corpus_size?: number;  // Don't consolidate if total memories < N (default: 20)
    require_llm_merge?: boolean;  // Always use LLM for merge action, never destructive delete (default: true)
  };
  // Primary agent (always Claude via CLI)
  agent_model?: 'haiku' | 'sonnet' | 'opus';  // Claude model for reflection (default: 'haiku')
  // Optional secondary sleep agent (runs in parallel for heavy lifting)
  // Uses llm.sleep.* for mode/model/api_url/api_key
  sleep_agent?: {
    enabled?: boolean;  // Enable secondary sleep agent (default: false — uses llm.sleep.enabled)
    // Which operations to offload to sleep agent
    handle_operations?: {
      memory_consolidation?: boolean;  // Offload memory merge/dedup (default: true)
      session_summary?: boolean;  // Offload fact extraction (default: true)
      precompute_context?: boolean;  // Offload context preparation (default: true)
    };
  };
  // Processing limits
  max_memories_to_process?: number;  // Max memories to consolidate per idle (default: 50)
  timeout_seconds?: number;  // Max time for idle operations (default: 25)
}

// Default embedding model for local ONNX mode
export const LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';  // 384 dimensions

// Default readiness gate config
export const DEFAULT_READINESS_GATE_CONFIG = {
  enabled: true,
  thresholds: { proceed: 0.7, warn: 0.4 },
  expected_results: 5,
} as const;

// Default idle watcher config
export const DEFAULT_IDLE_WATCHER_CONFIG: Required<IdleWatcherConfig> = {
  enabled: true,
  idle_minutes: 2,
  check_interval: 30,
  min_conversation_length: 5,
  reflection_cooldown_minutes: 30,
};

// Default retention policy config
export const DEFAULT_RETENTION_POLICY_CONFIG: Required<RetentionPolicyConfig> = {
  enabled: false,  // Manual only by default
  decay_rate: 0.01,
  access_weight: 0.1,
  max_access_boost: 2.0,
  keep_threshold: 0.3,
  delete_threshold: 0.15,
  default_quality_score: 0.5,
  auto_cleanup_interval_days: 7,
  use_temporal_decay: true,
};

// Default sleep agent config (for idle_reflection.sleep_agent)
export const DEFAULT_SLEEP_AGENT_CONFIG = {
  enabled: false,
  handle_operations: {
    memory_consolidation: true,
    session_summary: true,
    precompute_context: true,
  },
};

// Default compact briefing config
export const DEFAULT_COMPACT_BRIEFING_CONFIG: Required<CompactBriefingConfig> = {
  enabled: true,
  format: 'structured',
  include_learnings: true,
  include_memories: true,
  max_memories: 3,
  timeout_ms: 15000,
};

// Default error reporting config
export const DEFAULT_ERROR_REPORTING_CONFIG = {
  enabled: true,
  level: 'warn' as const,
  max_file_size_mb: 5,
  webhook_url: '',
  webhook_headers: {} as Record<string, string>,
  sentry_dsn: '',
  sentry_environment: 'production',
  sentry_sample_rate: 1.0,
};

// Default idle reflection config
export const DEFAULT_IDLE_REFLECTION_CONFIG = {
  enabled: true,
  operations: {
    memory_consolidation: false,
    graph_refinement: true,
    graph_enrichment: true,
    session_summary: true,
    precompute_context: true,
    write_reflection: true,
    retention_cleanup: true,  // Enabled by default (only runs if retention.enabled=true in config)
  },
  thresholds: {
    similarity_for_merge: 0.92,
    auto_link_threshold: 0.75,
    min_quality_for_summary: 0.5,
  },
  consolidation_guards: {
    min_memory_age_days: 7,
    min_corpus_size: 20,
    require_llm_merge: true,
  },
  // Primary agent (Claude Haiku via CLI)
  agent_model: 'haiku' as const,
  // Secondary sleep agent (disabled by default)
  sleep_agent: DEFAULT_SLEEP_AGENT_CONFIG,
  max_memories_to_process: 50,
  timeout_seconds: 25,
};

const DEFAULT_CONFIG: SuccConfig = {
  chunk_size: 500,
  chunk_overlap: 50,
};

// Config cache: avoids re-reading files on every getConfig() call
let configCache: { config: SuccConfig; globalMtime: number; projectMtime: number; projectPath: string } | null = null;

/** Invalidate config cache (for tests or after config changes) */
export function invalidateConfigCache(): void {
  configCache = null;
}

function getFileMtime(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export function getConfig(): SuccConfig {
  const globalConfigPath = path.join(os.homedir(), '.succ', 'config.json');

  // Find active project config path
  const projectConfigPaths = [
    path.join(process.cwd(), '.succ', 'config.json'),
    path.join(process.cwd(), '.claude', 'succ.json'),  // legacy
  ];
  let activeProjectPath = '';
  for (const p of projectConfigPaths) {
    if (fs.existsSync(p)) { activeProjectPath = p; break; }
  }

  // Check if cache is still valid (stat is cheaper than read+parse)
  if (configCache) {
    const globalMtime = getFileMtime(globalConfigPath);
    const projectMtime = activeProjectPath ? getFileMtime(activeProjectPath) : 0;
    if (globalMtime === configCache.globalMtime &&
        projectMtime === configCache.projectMtime &&
        activeProjectPath === configCache.projectPath) {
      return configCache.config;
    }
  }

  // Read global config file
  let fileConfig: Partial<SuccConfig> = {};

  if (fs.existsSync(globalConfigPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));
    } catch {
      // Ignore parse errors
    }
  }

  // Read project config (deep merge for nested objects like storage, llm, etc.)
  if (activeProjectPath) {
    try {
      const projectConfig = JSON.parse(fs.readFileSync(activeProjectPath, 'utf-8'));
      // Deep merge nested objects so project config extends (not replaces) global
      for (const [key, value] of Object.entries(projectConfig)) {
        if (value && typeof value === 'object' && !Array.isArray(value) &&
            fileConfig[key as keyof typeof fileConfig] && typeof fileConfig[key as keyof typeof fileConfig] === 'object' &&
            !Array.isArray(fileConfig[key as keyof typeof fileConfig])) {
          // Deep merge: global + project for nested objects (storage, llm, etc.)
          (fileConfig as Record<string, unknown>)[key] = {
            ...(fileConfig[key as keyof typeof fileConfig] as Record<string, unknown>),
            ...(value as Record<string, unknown>),
          };
        } else {
          // Shallow override for scalar values and arrays
          (fileConfig as Record<string, unknown>)[key] = value;
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  const result: SuccConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
  };

  // Update cache
  configCache = {
    config: result,
    globalMtime: getFileMtime(globalConfigPath),
    projectMtime: activeProjectPath ? getFileMtime(activeProjectPath) : 0,
    projectPath: activeProjectPath,
  };

  return result;
}

export function getProjectRoot(): string {
  // 1. Check env overrides: SUCC_PROJECT_ROOT (explicit), CLAUDE_PROJECT_DIR (Claude Code hooks/MCP)
  const envRoot = process.env.SUCC_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR;
  if (envRoot && (fs.existsSync(path.join(envRoot, '.succ')) || fs.existsSync(path.join(envRoot, '.git')))) {
    return envRoot;
  }

  // 2. Walk up to find a real project root
  // .git or .claude = definite project. .succ alone = project only if not $HOME
  // (bare ~/.succ is the global config dir, not a project)
  const homeDir = os.homedir();
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    const hasGit = fs.existsSync(path.join(dir, '.git'));
    const hasClaude = fs.existsSync(path.join(dir, '.claude'));
    const hasSucc = fs.existsSync(path.join(dir, '.succ'));
    if (hasGit || hasClaude || (hasSucc && path.resolve(dir) !== path.resolve(homeDir))) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  return process.cwd();
}

export function getSuccDir(): string {
  return path.join(getProjectRoot(), '.succ');
}

/**
 * Check if succ is initialized in current project
 */
export function isProjectInitialized(): boolean {
  // ~/.succ is the global config dir, not an initialized project
  if (path.resolve(getProjectRoot()) === path.resolve(os.homedir())) {
    return false;
  }
  const succDir = getSuccDir();
  return fs.existsSync(succDir) && fs.existsSync(path.join(succDir, 'succ.db'));
}

/**
 * Check if only global memory is available (no project .succ/)
 */
export function isGlobalOnlyMode(): boolean {
  return !isProjectInitialized();
}

// Legacy alias for backwards compatibility
export function getClaudeDir(): string {
  return getSuccDir();
}

export function getDbPath(): string {
  return path.join(getSuccDir(), 'succ.db');
}

export function getGlobalDbPath(): string {
  const globalDir = path.join(os.homedir(), '.succ');
  if (!fs.existsSync(globalDir)) {
    fs.mkdirSync(globalDir, { recursive: true });
  }
  return path.join(globalDir, 'global.db');
}

// Temporary config override for benchmarking
let configOverride: Partial<SuccConfig> | null = null;

export function setConfigOverride(override: Partial<SuccConfig> | null): void {
  configOverride = override;
}

export function getConfigWithOverride(): SuccConfig {
  const baseConfig = getConfig();
  if (configOverride) {
    return { ...baseConfig, ...configOverride };
  }
  return baseConfig;
}

/**
 * Get the global API key.
 * Resolution: llm.api_key → OPENROUTER_API_KEY env → undefined
 */
export function getApiKey(): string | undefined {
  const config = getConfig();
  if (config.llm?.api_key) return config.llm.api_key;
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  return undefined;
}

/**
 * Get the global API URL.
 * Resolution: llm.api_url → "http://localhost:11434/v1"
 */
export function getApiUrl(): string {
  const config = getConfig();
  return config.llm?.api_url || 'http://localhost:11434/v1';
}

/**
 * Check if an API key is available (global or env)
 */
export function hasApiKey(): boolean {
  return !!getApiKey();
}


/** Default API URL */
export const DEFAULT_API_URL = 'http://localhost:11434/v1';

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
 * Get fully resolved LLM config for a specific task.
 *
 * Resolution chain:
 *   mode:     llm.{task}.mode  → llm.type      → default per task
 *   model:    llm.{task}.model → llm.model      → default per mode
 *   api_key:  llm.{task}.api_key → llm.api_key  → env OPENROUTER_API_KEY → undefined
 *   api_url:  llm.{task}.api_url → llm.api_url  → "http://localhost:11434/v1"
 *   max_tokens: llm.{task}.max_tokens → llm.max_tokens → 2000
 *   temperature: llm.{task}.temperature → llm.temperature → 0.3
 */
export function getLLMTaskConfig(
  task: 'embeddings' | 'analyze' | 'quality' | 'chat' | 'sleep' | 'skills'
): ResolvedLLMTaskConfig {
  const config = getConfig();
  const llm = config.llm || {};
  const taskConfig = llm[task] || {};

  // Default modes per task
  const defaultModes: Record<string, 'claude' | 'api' | 'local'> = {
    embeddings: 'local',
    analyze: 'claude',
    quality: 'local',
    chat: 'claude',
    sleep: 'api',
    skills: llm.type === 'claude' ? 'claude' : 'api',
  };

  // Default models per mode
  const defaultModels: Record<string, string> = {
    claude: 'haiku',
    api: 'qwen2.5:7b',
    local: task === 'embeddings' ? LOCAL_MODEL : '',
  };

  // Tasks that only support 'local' | 'api' (no claude CLI support)
  const localOnlyTasks = new Set(['embeddings', 'quality']);
  const globalType = llm.type;
  // Skip llm.type fallback if it's 'claude' but the task doesn't support it
  const globalTypeFallback = (globalType && !(localOnlyTasks.has(task) && globalType === 'claude'))
    ? globalType
    : undefined;

  const mode = (taskConfig as Record<string, unknown>).mode as string
    || globalTypeFallback
    || defaultModes[task];

  // llm.model is the global API/Claude model — don't use it as fallback for 'local' mode
  const globalModelFallback = mode === 'local' ? undefined : llm.model;
  const model = (taskConfig as Record<string, unknown>).model as string
    || globalModelFallback
    || defaultModels[mode] || defaultModels['api'];

  const apiKey = (taskConfig as Record<string, unknown>).api_key as string | undefined
    || llm.api_key
    || process.env.OPENROUTER_API_KEY
    || undefined;

  const apiUrl = (taskConfig as Record<string, unknown>).api_url as string | undefined
    || llm.api_url
    || DEFAULT_API_URL;

  const maxTokens = ((taskConfig as Record<string, unknown>).max_tokens as number | undefined)
    ?? llm.max_tokens
    ?? (task === 'chat' ? 4000 : task === 'analyze' ? 4096 : 2000);

  const temperature = ((taskConfig as Record<string, unknown>).temperature as number | undefined)
    ?? llm.temperature
    ?? (task === 'chat' ? 0.7 : 0.3);

  // Task-specific extra fields
  const batchSize = task === 'embeddings'
    ? ((taskConfig as Record<string, unknown>).batch_size as number | undefined) ?? 32
    : undefined;

  const dimensions = task === 'embeddings'
    ? ((taskConfig as Record<string, unknown>).dimensions as number | undefined)
    : undefined;

  const concurrency = task === 'analyze'
    ? ((taskConfig as Record<string, unknown>).concurrency as number | undefined) ?? 3
    : undefined;

  return {
    mode: mode as 'claude' | 'api' | 'local',
    model,
    api_url: apiUrl,
    api_key: apiKey,
    max_tokens: maxTokens,
    temperature,
    batch_size: batchSize,
    dimensions,
    concurrency,
  };
}

/**
 * Get idle watcher configuration with defaults
 */
export function getIdleWatcherConfig(): Required<IdleWatcherConfig> {
  const config = getConfig();
  const userConfig = config.idle_watcher || {};

  return {
    enabled: userConfig.enabled ?? DEFAULT_IDLE_WATCHER_CONFIG.enabled,
    idle_minutes: userConfig.idle_minutes ?? DEFAULT_IDLE_WATCHER_CONFIG.idle_minutes,
    check_interval: userConfig.check_interval ?? DEFAULT_IDLE_WATCHER_CONFIG.check_interval,
    min_conversation_length: userConfig.min_conversation_length ?? DEFAULT_IDLE_WATCHER_CONFIG.min_conversation_length,
    reflection_cooldown_minutes: userConfig.reflection_cooldown_minutes ?? DEFAULT_IDLE_WATCHER_CONFIG.reflection_cooldown_minutes,
  };
}

/**
 * Get retention policy configuration with defaults
 */
export function getRetentionConfig(): Required<RetentionPolicyConfig> {
  const config = getConfig();
  const userConfig = config.retention || {};

  return {
    enabled: userConfig.enabled ?? DEFAULT_RETENTION_POLICY_CONFIG.enabled,
    decay_rate: userConfig.decay_rate ?? DEFAULT_RETENTION_POLICY_CONFIG.decay_rate,
    access_weight: userConfig.access_weight ?? DEFAULT_RETENTION_POLICY_CONFIG.access_weight,
    max_access_boost: userConfig.max_access_boost ?? DEFAULT_RETENTION_POLICY_CONFIG.max_access_boost,
    keep_threshold: userConfig.keep_threshold ?? DEFAULT_RETENTION_POLICY_CONFIG.keep_threshold,
    delete_threshold: userConfig.delete_threshold ?? DEFAULT_RETENTION_POLICY_CONFIG.delete_threshold,
    default_quality_score: userConfig.default_quality_score ?? DEFAULT_RETENTION_POLICY_CONFIG.default_quality_score,
    auto_cleanup_interval_days: userConfig.auto_cleanup_interval_days ?? DEFAULT_RETENTION_POLICY_CONFIG.auto_cleanup_interval_days,
    use_temporal_decay: userConfig.use_temporal_decay ?? DEFAULT_RETENTION_POLICY_CONFIG.use_temporal_decay,
  };
}

/**
 * Get web search configuration with defaults
 */
export function getWebSearchConfig(): Required<WebSearchConfig> {
  const config = getConfig();
  const userConfig = config.web_search || {};
  return {
    enabled: userConfig.enabled ?? true,
    quick_search_model: userConfig.quick_search_model ?? 'perplexity/sonar',
    quick_search_max_tokens: userConfig.quick_search_max_tokens ?? 2000,
    quick_search_timeout_ms: userConfig.quick_search_timeout_ms ?? 15000,
    model: userConfig.model ?? 'perplexity/sonar-pro',
    deep_research_model: userConfig.deep_research_model ?? 'perplexity/sonar-deep-research',
    max_tokens: userConfig.max_tokens ?? 4000,
    deep_research_max_tokens: userConfig.deep_research_max_tokens ?? 8000,
    timeout_ms: userConfig.timeout_ms ?? 30000,
    deep_research_timeout_ms: userConfig.deep_research_timeout_ms ?? 120000,
    temperature: userConfig.temperature ?? 0.1,
    save_to_memory: userConfig.save_to_memory ?? true,
    daily_budget_usd: userConfig.daily_budget_usd ?? 0,
  };
}

export function getIdleReflectionConfig(): Required<IdleReflectionConfig> {
  const config = getConfig();
  const userConfig = config.idle_reflection || {};
  const userSleepAgent = userConfig.sleep_agent || {};

  // Sleep agent enabled state: idle_reflection.sleep_agent.enabled → llm.sleep.enabled → false
  const sleepEnabled = userSleepAgent.enabled ?? config.llm?.sleep?.enabled ?? DEFAULT_SLEEP_AGENT_CONFIG.enabled;

  // Safety: memory_consolidation requires GLOBAL opt-in.
  // Project config can DISABLE (false) but cannot ENABLE (true) on its own.
  // This prevents .succ/config.json from silently enabling destructive consolidation.
  const globalConfigPath = path.join(os.homedir(), '.succ', 'config.json');
  let globalConsolidation: boolean | undefined;
  try {
    if (fs.existsSync(globalConfigPath)) {
      const globalCfg = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));
      globalConsolidation = globalCfg.idle_reflection?.operations?.memory_consolidation;
    }
  } catch { /* ignore parse errors */ }

  // Rule: global must explicitly be true, AND merged value must not be false
  const consolidationEnabled = globalConsolidation === true
    && (userConfig.operations?.memory_consolidation !== false);

  return {
    enabled: userConfig.enabled ?? DEFAULT_IDLE_REFLECTION_CONFIG.enabled,
    operations: {
      memory_consolidation: consolidationEnabled,
      graph_refinement: userConfig.operations?.graph_refinement ?? DEFAULT_IDLE_REFLECTION_CONFIG.operations.graph_refinement,
      graph_enrichment: userConfig.operations?.graph_enrichment ?? DEFAULT_IDLE_REFLECTION_CONFIG.operations.graph_enrichment,
      session_summary: userConfig.operations?.session_summary ?? DEFAULT_IDLE_REFLECTION_CONFIG.operations.session_summary,
      precompute_context: userConfig.operations?.precompute_context ?? DEFAULT_IDLE_REFLECTION_CONFIG.operations.precompute_context,
      write_reflection: userConfig.operations?.write_reflection ?? DEFAULT_IDLE_REFLECTION_CONFIG.operations.write_reflection,
      retention_cleanup: userConfig.operations?.retention_cleanup ?? DEFAULT_IDLE_REFLECTION_CONFIG.operations.retention_cleanup,
    },
    thresholds: {
      similarity_for_merge: userConfig.thresholds?.similarity_for_merge ?? DEFAULT_IDLE_REFLECTION_CONFIG.thresholds.similarity_for_merge,
      auto_link_threshold: userConfig.thresholds?.auto_link_threshold ?? DEFAULT_IDLE_REFLECTION_CONFIG.thresholds.auto_link_threshold,
      min_quality_for_summary: userConfig.thresholds?.min_quality_for_summary ?? DEFAULT_IDLE_REFLECTION_CONFIG.thresholds.min_quality_for_summary,
    },
    agent_model: userConfig.agent_model ?? DEFAULT_IDLE_REFLECTION_CONFIG.agent_model,
    sleep_agent: {
      enabled: sleepEnabled,
      handle_operations: {
        memory_consolidation: userSleepAgent.handle_operations?.memory_consolidation ?? DEFAULT_SLEEP_AGENT_CONFIG.handle_operations.memory_consolidation,
        session_summary: userSleepAgent.handle_operations?.session_summary ?? DEFAULT_SLEEP_AGENT_CONFIG.handle_operations.session_summary,
        precompute_context: userSleepAgent.handle_operations?.precompute_context ?? DEFAULT_SLEEP_AGENT_CONFIG.handle_operations.precompute_context,
      },
    },
    consolidation_guards: {
      min_memory_age_days: userConfig.consolidation_guards?.min_memory_age_days ?? DEFAULT_IDLE_REFLECTION_CONFIG.consolidation_guards.min_memory_age_days,
      min_corpus_size: userConfig.consolidation_guards?.min_corpus_size ?? DEFAULT_IDLE_REFLECTION_CONFIG.consolidation_guards.min_corpus_size,
      require_llm_merge: userConfig.consolidation_guards?.require_llm_merge ?? DEFAULT_IDLE_REFLECTION_CONFIG.consolidation_guards.require_llm_merge,
    },
    max_memories_to_process: userConfig.max_memories_to_process ?? DEFAULT_IDLE_REFLECTION_CONFIG.max_memories_to_process,
    timeout_seconds: userConfig.timeout_seconds ?? DEFAULT_IDLE_REFLECTION_CONFIG.timeout_seconds,
  };
}

/**
 * Get compact briefing configuration with defaults
 */
export function getCompactBriefingConfig(): Required<CompactBriefingConfig> {
  const config = getConfig();
  const userConfig = config.compact_briefing || {};

  return {
    enabled: userConfig.enabled ?? DEFAULT_COMPACT_BRIEFING_CONFIG.enabled,
    format: userConfig.format ?? DEFAULT_COMPACT_BRIEFING_CONFIG.format,
    include_learnings: userConfig.include_learnings ?? DEFAULT_COMPACT_BRIEFING_CONFIG.include_learnings,
    include_memories: userConfig.include_memories ?? DEFAULT_COMPACT_BRIEFING_CONFIG.include_memories,
    max_memories: userConfig.max_memories ?? DEFAULT_COMPACT_BRIEFING_CONFIG.max_memories,
    timeout_ms: userConfig.timeout_ms ?? DEFAULT_COMPACT_BRIEFING_CONFIG.timeout_ms,
  };
}

/**
 * Get readiness gate configuration with defaults
 */
export function getReadinessGateConfig() {
  const config = getConfig();
  const userConfig = config.readiness_gate || {};
  const userThresholds = userConfig.thresholds || {};

  return {
    enabled: userConfig.enabled ?? DEFAULT_READINESS_GATE_CONFIG.enabled,
    thresholds: {
      proceed: userThresholds.proceed ?? DEFAULT_READINESS_GATE_CONFIG.thresholds.proceed,
      warn: userThresholds.warn ?? DEFAULT_READINESS_GATE_CONFIG.thresholds.warn,
    },
    expected_results: userConfig.expected_results ?? DEFAULT_READINESS_GATE_CONFIG.expected_results,
  };
}

/**
 * Determine which agent handles each operation
 * Returns 'claude' or 'sleep' for each operation
 */
export type IdleOperation = 'memory_consolidation' | 'graph_refinement' | 'graph_enrichment' | 'session_summary' | 'precompute_context' | 'write_reflection';

export interface OperationAssignment {
  operation: IdleOperation;
  agent: 'claude' | 'sleep';
  enabled: boolean;
}

export function getOperationAssignments(): OperationAssignment[] {
  const idleConfig = getIdleReflectionConfig();
  const sleepTaskCfg = getLLMTaskConfig('sleep');
  const ops = idleConfig.operations;
  const sleepAgent = idleConfig.sleep_agent;
  const sleepOps = sleepAgent.handle_operations;
  const sleepEnabled = sleepAgent.enabled && !!sleepTaskCfg.model;

  const assignments: OperationAssignment[] = [
    {
      operation: 'memory_consolidation',
      // Offload to sleep agent if enabled and configured to handle it
      agent: sleepEnabled && sleepOps?.memory_consolidation ? 'sleep' : 'claude',
      enabled: ops?.memory_consolidation ?? true,
    },
    {
      operation: 'graph_refinement',
      // Graph refinement always stays with Claude (needs succ CLI access)
      agent: 'claude',
      enabled: ops?.graph_refinement ?? true,
    },
    {
      operation: 'graph_enrichment',
      // Graph enrichment stays with Claude (needs DB access for LLM enrich + proximity + communities + centrality)
      agent: 'claude',
      enabled: ops?.graph_enrichment ?? true,
    },
    {
      operation: 'session_summary',
      agent: sleepEnabled && sleepOps?.session_summary ? 'sleep' : 'claude',
      enabled: ops?.session_summary ?? true,
    },
    {
      operation: 'precompute_context',
      agent: sleepEnabled && sleepOps?.precompute_context ? 'sleep' : 'claude',
      enabled: ops?.precompute_context ?? false,
    },
    {
      operation: 'write_reflection',
      // Reflection text always stays with Claude (writes to reflections.md)
      agent: 'claude',
      enabled: ops?.write_reflection ?? true,
    },
  ];

  return assignments;
}

/**
 * Get operations assigned to a specific agent
 */
export function getAgentOperations(agent: 'claude' | 'sleep'): IdleOperation[] {
  return getOperationAssignments()
    .filter(a => a.agent === agent && a.enabled)
    .map(a => a.operation);
}

/**
 * Mask sensitive values (API keys, etc.)
 */
function maskSensitive(value: string | undefined): string {
  if (!value) return '(not set)';
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

/**
 * Get full configuration with all defaults applied
 * Returns a structured object showing current effective values
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

export function getConfigDisplay(maskSecrets: boolean = true): ConfigDisplay {
  const config = getConfig();
  const idleReflection = getIdleReflectionConfig();
  const idleWatcher = getIdleWatcherConfig();

  // Determine sources
  const globalConfigPath = path.join(os.homedir(), '.succ', 'config.json');
  const projectConfigPaths = [
    path.join(process.cwd(), '.succ', 'config.json'),
    path.join(process.cwd(), '.claude', 'succ.json'),
  ];
  let projectConfig: string | null = null;
  for (const p of projectConfigPaths) {
    if (fs.existsSync(p)) {
      projectConfig = p;
      break;
    }
  }

  const envVars: string[] = [];
  if (process.env.OPENROUTER_API_KEY) envVars.push('OPENROUTER_API_KEY');

  const mask = (val: string | undefined) => maskSecrets ? maskSensitive(val) : (val || '(not set)');

  // Resolve per-task configs
  const embCfg = getLLMTaskConfig('embeddings');
  const anlCfg = getLLMTaskConfig('analyze');
  const qCfg = getLLMTaskConfig('quality');
  const chatCfg = getLLMTaskConfig('chat');
  const sleepCfg = getLLMTaskConfig('sleep');
  const skillsCfg = getLLMTaskConfig('skills');

  const globalApiKey = getApiKey();
  const globalApiUrl = getApiUrl();

  return {
    sources: {
      global: fs.existsSync(globalConfigPath) ? globalConfigPath : '(not found)',
      project: projectConfig,
      env: envVars,
      api_key: globalApiKey ? mask(globalApiKey) : undefined,
    },
    llm: {
      type: config.llm?.type || 'api',
      model: config.llm?.model || 'qwen2.5:7b',
      api_url: globalApiUrl,
      api_key: globalApiKey ? mask(globalApiKey) : undefined,
      max_tokens: config.llm?.max_tokens ?? 2000,
      temperature: config.llm?.temperature ?? 0.3,
      transport: config.llm?.claude?.transport || config.llm?.transport,
      embeddings: { mode: embCfg.mode, model: embCfg.model, api_url: embCfg.mode === 'api' ? embCfg.api_url : undefined },
      analyze: {
        mode: anlCfg.mode, model: anlCfg.model,
        api_url: anlCfg.mode === 'api' ? anlCfg.api_url : undefined,
        concurrency: (config.llm?.analyze as Record<string, unknown> | undefined)?.concurrency as number ?? 3,
      },
      quality: { mode: qCfg.mode, model: qCfg.model, api_url: qCfg.mode === 'api' ? qCfg.api_url : undefined },
      chat: { mode: chatCfg.mode, model: chatCfg.model, max_tokens: chatCfg.max_tokens, temperature: chatCfg.temperature },
      sleep: { enabled: config.llm?.sleep?.enabled ?? false, mode: sleepCfg.mode, model: sleepCfg.model },
      skills: { mode: skillsCfg.mode, model: skillsCfg.model },
    },
    chunking: {
      chunk_size: config.chunk_size,
      chunk_overlap: config.chunk_overlap,
    },
    gpu: {
      enabled: config.gpu_enabled ?? true,
      device: config.gpu_device,
    },
    quality: {
      enabled: config.quality_scoring_enabled ?? true,
      threshold: config.quality_scoring_threshold ?? 0,
    },
    sensitive: {
      enabled: config.sensitive_filter_enabled ?? true,
      auto_redact: config.sensitive_auto_redact ?? false,
    },
    graph: {
      auto_link: config.graph_auto_link ?? true,
      link_threshold: config.graph_link_threshold ?? 0.7,
      auto_export: config.graph_auto_export ?? false,
      export_format: config.graph_export_format ?? 'obsidian',
      export_path: config.graph_export_path,
    },
    idle_reflection: {
      enabled: idleReflection.enabled,
      agent_model: idleReflection.agent_model,
      operations: {
        memory_consolidation: idleReflection.operations.memory_consolidation ?? false,
        graph_refinement: idleReflection.operations.graph_refinement ?? true,
        graph_enrichment: idleReflection.operations.graph_enrichment ?? true,
        session_summary: idleReflection.operations.session_summary ?? true,
        precompute_context: idleReflection.operations.precompute_context ?? false,
        write_reflection: idleReflection.operations.write_reflection ?? true,
        retention_cleanup: idleReflection.operations.retention_cleanup ?? true,
      },
      thresholds: {
        similarity_for_merge: idleReflection.thresholds.similarity_for_merge ?? 0.92,
      },
      consolidation_guards: {
        min_memory_age_days: idleReflection.consolidation_guards.min_memory_age_days ?? 7,
        min_corpus_size: idleReflection.consolidation_guards.min_corpus_size ?? 20,
        require_llm_merge: idleReflection.consolidation_guards.require_llm_merge ?? true,
      },
      sleep_agent: {
        enabled: idleReflection.sleep_agent.enabled ?? false,
      },
    },
    idle_watcher: {
      enabled: idleWatcher.enabled,
      idle_minutes: idleWatcher.idle_minutes,
      check_interval: idleWatcher.check_interval,
      min_conversation_length: idleWatcher.min_conversation_length,
    },
    retrieval: (() => {
      const rc = getRetrievalConfig();
      return {
        bm25_alpha: rc.bm25_alpha,
        default_top_k: rc.default_top_k,
        temporal_auto_skip: rc.temporal_auto_skip,
        quality_boost_enabled: rc.quality_boost_enabled,
        quality_boost_weight: rc.quality_boost_weight,
        mmr_enabled: rc.mmr_enabled,
        mmr_lambda: rc.mmr_lambda,
        query_expansion_enabled: rc.query_expansion_enabled,
        query_expansion_mode: rc.query_expansion_mode,
      };
    })(),
    web_search: (() => {
      const ws = getWebSearchConfig();
      return {
        enabled: ws.enabled,
        quick_search_model: ws.quick_search_model,
        model: ws.model,
        deep_research_model: ws.deep_research_model,
        max_tokens: ws.max_tokens,
        deep_research_timeout_ms: ws.deep_research_timeout_ms,
        temperature: ws.temperature,
        save_to_memory: ws.save_to_memory,
        daily_budget_usd: ws.daily_budget_usd,
      };
    })(),
    error_reporting: (() => {
      const er = getErrorReportingConfig();
      return {
        enabled: er.enabled,
        level: er.level,
        max_file_size_mb: er.max_file_size_mb,
        webhook_url: er.webhook_url,
        sentry_dsn: er.sentry_dsn,
      };
    })(),
  };
}

/**
 * Format config display as readable text
 */
export function formatConfigDisplay(display: ConfigDisplay): string {
  const lines: string[] = [];

  lines.push('=== succ Configuration ===\n');

  // Sources
  lines.push('## Sources');
  lines.push(`  Global config: ${display.sources.global}`);
  lines.push(`  Project config: ${display.sources.project || '(none)'}`);
  if (display.sources.env.length > 0) {
    lines.push(`  Environment: ${display.sources.env.join(', ')}`);
  }
  if (display.sources.api_key) {
    lines.push(`  API Key: ${display.sources.api_key}`);
  }
  lines.push('');

  // LLM (unified)
  lines.push('## LLM');
  lines.push(`  Type: ${display.llm.type}`);
  lines.push(`  Model: ${display.llm.model}`);
  lines.push(`  API URL: ${display.llm.api_url}`);
  if (display.llm.api_key) {
    lines.push(`  API Key: ${display.llm.api_key}`);
  }
  if (display.llm.transport) {
    lines.push(`  Transport: ${display.llm.transport}`);
  }
  lines.push(`  Max tokens: ${display.llm.max_tokens}`);
  lines.push(`  Temperature: ${display.llm.temperature}`);
  // Per-task
  lines.push('  Embeddings:');
  lines.push(`    Mode: ${display.llm.embeddings.mode}, Model: ${display.llm.embeddings.model}`);
  if (display.llm.embeddings.api_url) lines.push(`    API URL: ${display.llm.embeddings.api_url}`);
  lines.push('  Analyze:');
  lines.push(`    Mode: ${display.llm.analyze.mode}, Model: ${display.llm.analyze.model}, Concurrency: ${display.llm.analyze.concurrency}`);
  if (display.llm.analyze.api_url) lines.push(`    API URL: ${display.llm.analyze.api_url}`);
  lines.push('  Quality:');
  lines.push(`    Mode: ${display.llm.quality.mode}, Model: ${display.llm.quality.model}`);
  if (display.llm.quality.api_url) lines.push(`    API URL: ${display.llm.quality.api_url}`);
  lines.push('  Chat:');
  lines.push(`    Mode: ${display.llm.chat.mode}, Model: ${display.llm.chat.model}, Temp: ${display.llm.chat.temperature}`);
  lines.push('  Sleep:');
  lines.push(`    Enabled: ${display.llm.sleep.enabled}, Mode: ${display.llm.sleep.mode}, Model: ${display.llm.sleep.model}`);
  lines.push('  Skills:');
  lines.push(`    Mode: ${display.llm.skills.mode}, Model: ${display.llm.skills.model}`);
  lines.push('');

  // Chunking
  lines.push('## Chunking');
  lines.push(`  Chunk size: ${display.chunking.chunk_size}`);
  lines.push(`  Chunk overlap: ${display.chunking.chunk_overlap}`);
  lines.push('');

  // GPU
  lines.push('## GPU');
  lines.push(`  Enabled: ${display.gpu.enabled}`);
  if (display.gpu.device) {
    lines.push(`  Device: ${display.gpu.device}`);
  }
  lines.push('');

  // Quality
  lines.push('## Quality Scoring');
  lines.push(`  Enabled: ${display.quality.enabled}`);
  lines.push(`  Threshold: ${display.quality.threshold}`);
  lines.push('');

  // Sensitive
  lines.push('## Sensitive Filter');
  lines.push(`  Enabled: ${display.sensitive.enabled}`);
  lines.push(`  Auto-redact: ${display.sensitive.auto_redact}`);
  lines.push('');

  // Graph
  lines.push('## Knowledge Graph');
  lines.push(`  Auto-link: ${display.graph.auto_link}`);
  lines.push(`  Link threshold: ${display.graph.link_threshold}`);
  lines.push(`  Auto-export: ${display.graph.auto_export}`);
  lines.push(`  Export format: ${display.graph.export_format}`);
  if (display.graph.export_path) {
    lines.push(`  Export path: ${display.graph.export_path}`);
  }
  lines.push('');

  // Idle Reflection
  lines.push('## Idle Reflection');
  lines.push(`  Enabled: ${display.idle_reflection.enabled}`);
  lines.push(`  Agent model: ${display.idle_reflection.agent_model}`);
  lines.push('  Operations:');
  const ops = display.idle_reflection.operations;
  lines.push(`    - Memory consolidation: ${ops.memory_consolidation}`);
  lines.push(`    - Graph refinement: ${ops.graph_refinement}`);
  lines.push(`    - Graph enrichment: ${ops.graph_enrichment}`);
  lines.push(`    - Session summary: ${ops.session_summary}`);
  lines.push(`    - Precompute context: ${ops.precompute_context}`);
  lines.push(`    - Write reflection: ${ops.write_reflection}`);
  lines.push(`    - Retention cleanup: ${ops.retention_cleanup}`);
  if (display.idle_reflection.sleep_agent.enabled) {
    lines.push(`  Sleep agent: enabled`);
  }
  lines.push('  Consolidation guards:');
  const guards = display.idle_reflection.consolidation_guards;
  lines.push(`    - Min memory age: ${guards.min_memory_age_days} days`);
  lines.push(`    - Min corpus size: ${guards.min_corpus_size}`);
  lines.push(`    - Require LLM merge: ${guards.require_llm_merge}`);
  lines.push(`    - Similarity threshold: ${display.idle_reflection.thresholds.similarity_for_merge}`);
  lines.push('');

  // Idle Watcher
  lines.push('## Idle Watcher');
  lines.push(`  Enabled: ${display.idle_watcher.enabled}`);
  lines.push(`  Idle minutes: ${display.idle_watcher.idle_minutes}`);
  lines.push(`  Check interval: ${display.idle_watcher.check_interval}s`);
  lines.push(`  Min conversation length: ${display.idle_watcher.min_conversation_length}`);
  lines.push('');

  // Retrieval
  lines.push('## Retrieval');
  lines.push(`  BM25 alpha: ${display.retrieval.bm25_alpha}`);
  lines.push(`  Default top-k: ${display.retrieval.default_top_k}`);
  lines.push(`  Temporal auto-skip: ${display.retrieval.temporal_auto_skip}`);
  lines.push(`  Quality boost: ${display.retrieval.quality_boost_enabled} (weight: ${display.retrieval.quality_boost_weight})`);
  lines.push(`  MMR diversity: ${display.retrieval.mmr_enabled} (lambda: ${display.retrieval.mmr_lambda})`);
  lines.push(`  Query expansion: ${display.retrieval.query_expansion_enabled} (mode: ${display.retrieval.query_expansion_mode})`);
  lines.push('');

  // Web Search
  lines.push('## Web Search (Perplexity Sonar via OpenRouter)');
  lines.push(`  Enabled: ${display.web_search.enabled}`);
  lines.push(`  Quick Search Model: ${display.web_search.quick_search_model}`);
  lines.push(`  Search Model: ${display.web_search.model}`);
  lines.push(`  Deep Research Model: ${display.web_search.deep_research_model}`);
  lines.push(`  Max tokens: ${display.web_search.max_tokens}`);
  lines.push(`  Deep Research timeout: ${display.web_search.deep_research_timeout_ms}ms`);
  lines.push(`  Temperature: ${display.web_search.temperature}`);
  lines.push(`  Save to memory: ${display.web_search.save_to_memory}`);
  lines.push(`  Daily budget: ${display.web_search.daily_budget_usd > 0 ? `$${display.web_search.daily_budget_usd}` : 'unlimited'}`);
  lines.push('');

  // Error Reporting
  lines.push('## Error Reporting');
  lines.push(`  Enabled: ${display.error_reporting.enabled}`);
  lines.push(`  Level: ${display.error_reporting.level}`);
  lines.push(`  Max file size: ${display.error_reporting.max_file_size_mb}MB`);
  if (display.error_reporting.webhook_url) {
    lines.push(`  Webhook URL: ${display.error_reporting.webhook_url}`);
  }
  if (display.error_reporting.sentry_dsn) {
    lines.push(`  Sentry DSN: ${display.error_reporting.sentry_dsn}`);
  }

  return lines.join('\n');
}

/**
 * Check if a process is running by PID
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface DaemonStatus {
  name: string;
  running: boolean;
  pid?: number;
  pidFile?: string;
  logFile?: string;
}

// ============================================================================
// Global Config Helpers (for onboarding state)
// ============================================================================

export interface GlobalConfig {
  onboarding_completed?: boolean;
  onboarding_completed_at?: string;
  onboarding_mode?: 'wizard' | 'ai-chat' | 'skipped';
  llm?: LLMConfig;
  [key: string]: unknown;
}

/**
 * Get path to global config file
 */
export function getGlobalConfigPath(): string {
  return path.join(os.homedir(), '.succ', 'config.json');
}

/**
 * Load global config from ~/.succ/config.json
 */
export function loadGlobalConfig(): GlobalConfig {
  const configPath = getGlobalConfigPath();
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Save updates to global config (merges with existing)
 */
export function saveGlobalConfig(updates: Partial<GlobalConfig>): void {
  const configPath = getGlobalConfigPath();
  const configDir = path.dirname(configPath);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const existing = loadGlobalConfig();
  const merged = { ...existing, ...updates };
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');
}

/**
 * Check if onboarding has been completed globally
 */
export function isOnboardingCompleted(): boolean {
  const config = loadGlobalConfig();
  return config.onboarding_completed === true;
}

/**
 * Mark onboarding as completed with mode and timestamp
 */
export function markOnboardingCompleted(mode: 'wizard' | 'ai-chat' | 'skipped'): void {
  saveGlobalConfig({
    onboarding_completed: true,
    onboarding_completed_at: new Date().toISOString(),
    onboarding_mode: mode,
  });
}

/**
 * Get status of all succ daemons (watch, analyze)
 */
export async function getDaemonStatuses(): Promise<DaemonStatus[]> {
  const succDir = getSuccDir();
  const statuses: DaemonStatus[] = [];
  const tmpDir = path.join(succDir, '.tmp');

  // Daemon API server (PID in .tmp/)
  const daemonPidFile = path.join(tmpDir, 'daemon.pid');
  const daemonPortFile = path.join(tmpDir, 'daemon.port');
  const daemonLogFile = path.join(succDir, 'daemon.log');
  let daemonRunning = false;
  let daemonPort: number | null = null;

  if (fs.existsSync(daemonPidFile)) {
    const pid = parseInt(fs.readFileSync(daemonPidFile, 'utf-8').trim(), 10);
    daemonRunning = isProcessRunning(pid);
    if (fs.existsSync(daemonPortFile)) {
      daemonPort = parseInt(fs.readFileSync(daemonPortFile, 'utf-8').trim(), 10);
    }
    statuses.push({
      name: 'daemon',
      running: daemonRunning,
      pid,
      pidFile: daemonPidFile,
      logFile: fs.existsSync(daemonLogFile) ? daemonLogFile : undefined,
    });
  } else {
    statuses.push({ name: 'daemon', running: false });
  }

  // Watch & Analyze are services inside the daemon — query via HTTP
  let services: { watch?: { active?: boolean }; analyze?: { active?: boolean; running?: boolean } } | null = null;
  if (daemonRunning && daemonPort) {
    try {
      const http = await import('http');
      services = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${daemonPort}/api/services`, { timeout: 2000 }, (res) => {
          let data = '';
          res.on('data', (chunk: string) => { data += chunk; });
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
    } catch { /* daemon unreachable */ }
  }

  statuses.push({
    name: 'watch',
    running: services?.watch?.active ?? false,
  });

  statuses.push({
    name: 'analyze',
    running: services?.analyze?.active ?? services?.analyze?.running ?? false,
  });

  // Idle watcher (from hooks)
  const watcherActiveFile = path.join(tmpDir, 'watcher-active.txt');
  if (fs.existsSync(watcherActiveFile)) {
    statuses.push({
      name: 'idle-watcher',
      running: true,
      pidFile: watcherActiveFile,
    });
  } else {
    statuses.push({ name: 'idle-watcher', running: false });
  }

  return statuses;
}

/**
 * Get retrieval config with defaults.
 * Used by hybrid search and recall tools.
 */
export function getRetrievalConfig(): Required<RetrievalConfig> {
  const config = getConfig();
  const userConfig = config.retrieval || {};
  return {
    bm25_alpha: userConfig.bm25_alpha ?? 0.4,
    default_top_k: userConfig.default_top_k ?? 10,
    temporal_auto_skip: userConfig.temporal_auto_skip ?? true,
    preference_quality_boost: userConfig.preference_quality_boost ?? true,
    quality_boost_enabled: userConfig.quality_boost_enabled ?? false,
    quality_boost_weight: userConfig.quality_boost_weight ?? 0.15,
    mmr_enabled: userConfig.mmr_enabled ?? false,
    mmr_lambda: userConfig.mmr_lambda ?? 0.8,
    query_expansion_enabled: userConfig.query_expansion_enabled ?? false,
    query_expansion_mode: userConfig.query_expansion_mode ?? (getConfig().llm?.type || 'api'),
  };
}

/**
 * Get observer config with defaults.
 * Used by daemon mid-conversation extraction.
 */
export function getObserverConfig(): Required<ObserverConfig> {
  const config = getConfig();
  const userConfig = config.observer || {};
  return {
    enabled: userConfig.enabled ?? true,
    min_tokens: userConfig.min_tokens ?? 15000,
    max_minutes: userConfig.max_minutes ?? 10,
  };
}

/**
 * Get error reporting config with defaults.
 * Used by fault-logger for local file, webhook, and sentry channels.
 */
export function getErrorReportingConfig() {
  const config = getConfig();
  const user = config.error_reporting || {};
  return {
    enabled: user.enabled ?? DEFAULT_ERROR_REPORTING_CONFIG.enabled,
    level: user.level ?? DEFAULT_ERROR_REPORTING_CONFIG.level,
    max_file_size_mb: user.max_file_size_mb ?? DEFAULT_ERROR_REPORTING_CONFIG.max_file_size_mb,
    webhook_url: user.webhook_url ?? DEFAULT_ERROR_REPORTING_CONFIG.webhook_url,
    webhook_headers: user.webhook_headers ?? DEFAULT_ERROR_REPORTING_CONFIG.webhook_headers,
    sentry_dsn: user.sentry_dsn ?? DEFAULT_ERROR_REPORTING_CONFIG.sentry_dsn,
    sentry_environment: user.sentry_environment ?? DEFAULT_ERROR_REPORTING_CONFIG.sentry_environment,
    sentry_sample_rate: user.sentry_sample_rate ?? DEFAULT_ERROR_REPORTING_CONFIG.sentry_sample_rate,
  };
}
