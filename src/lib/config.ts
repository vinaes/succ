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
  openrouter_api_key?: string;
  embedding_model: string;
  embedding_mode: 'local' | 'openrouter' | 'custom';
  embedding_api_url?: string;  // For custom API (llama.cpp, LM Studio, Ollama, etc.)
  embedding_api_key?: string;  // Optional API key for custom endpoint
  embedding_batch_size?: number;  // Batch size for custom API (default 32, llama.cpp works well with larger batches)
  embedding_dimensions?: number;  // Override embedding dimensions for custom models
  embedding_local_batch_size?: number;  // Batch size for local embeddings (default: 16)
  embedding_local_concurrency?: number;  // Concurrent batches for local embeddings (default: 4)
  embedding_worker_pool_enabled?: boolean;  // Use worker thread pool for local embeddings (default: true)
  embedding_worker_pool_size?: number;  // Worker pool size (default: auto based on CPU cores)
  embedding_cache_size?: number;  // Embedding LRU cache size (default: 500)
  chunk_size: number;
  chunk_overlap: number;
  // GPU acceleration settings
  gpu_enabled?: boolean;  // Enable GPU acceleration (auto-detect by default)
  gpu_device?: 'cuda' | 'directml' | 'webgpu' | 'cpu';  // Preferred GPU backend
  // Knowledge graph settings
  graph_auto_link?: boolean;  // Auto-link new memories to similar ones (default: true)
  graph_link_threshold?: number;  // Similarity threshold for auto-linking (default: 0.7)
  graph_auto_export?: boolean;  // Auto-export graph to Obsidian on changes (default: false)
  graph_export_format?: 'obsidian' | 'json';  // Export format (default: obsidian)
  graph_export_path?: string;  // Custom export path (default: .succ/brain/graph)
  // Analyze mode settings (for succ analyze)
  analyze_mode?: 'claude' | 'openrouter' | 'local';  // claude = Claude CLI (default), openrouter = OpenRouter API, local = local LLM
  analyze_api_url?: string;  // Local LLM API URL (e.g., http://localhost:11434/v1 for Ollama)
  analyze_api_key?: string;  // Optional API key for local LLM
  analyze_model?: string;  // Model name for local/openrouter (e.g., qwen2.5-coder:32b, deepseek-coder-v2)
  analyze_temperature?: number;  // Temperature for generation (default: 0.3)
  analyze_max_tokens?: number;  // Max tokens per response (default: 4096)
  // Quality scoring settings
  quality_scoring_enabled?: boolean;  // Enable quality scoring for memories (default: true)
  quality_scoring_mode?: 'local' | 'custom' | 'openrouter';  // local = ONNX, custom = Ollama/LM Studio, openrouter = API
  quality_scoring_model?: string;  // Model for LLM-based scoring (custom/openrouter modes)
  quality_scoring_api_url?: string;  // API URL for custom mode
  quality_scoring_api_key?: string;  // API key for custom mode
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
  // Unified LLM settings (used by all LLM-powered features)
  llm?: LLMConfig;
  // Chat LLM settings (for interactive chats: succ chat, onboarding)
  chat_llm?: ChatLLMConfig;
  // Sleep agent - secondary LLM for background operations
  sleep_agent?: SleepAgentConfig;
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
 * Chat LLM Config - separate config for interactive chats
 *
 * Used by succ chat and interactive onboarding.
 * Default: Claude CLI with Sonnet (best quality for interactive use)
 */
export interface ChatLLMConfig {
  backend?: 'claude' | 'local' | 'openrouter';  // Default: 'claude' with sonnet
  model?: string;  // Model name (e.g., 'sonnet' for claude, 'qwen2.5:7b' for local)
  local_endpoint?: string;  // Local LLM endpoint (default: from llm.local_endpoint)
  max_tokens?: number;  // Max tokens (default: 4000)
  temperature?: number;  // Temperature (default: 0.7)
}

export interface LLMConfig {
  backend?: 'claude' | 'local' | 'openrouter';  // Default: 'local' (to avoid Claude CLI ToS issues)
  model?: string;  // Model name: 'haiku' for claude, 'qwen2.5:7b' for local, etc.
  local_endpoint?: string;  // Local LLM endpoint (default: 'http://localhost:11434/v1/chat/completions')
  openrouter_model?: string;  // Model for OpenRouter (default: 'anthropic/claude-3-haiku')
  max_tokens?: number;  // Max tokens per response (default: 2000)
  temperature?: number;  // Temperature for generation (default: 0.3)
}

/**
 * Sleep Agent Config - secondary LLM for background/idle operations
 *
 * When enabled, background operations (idle reflection, memory consolidation,
 * precompute context) use this LLM instead of the primary llm.* config.
 *
 * Use cases:
 * - Primary: Claude CLI (quality) + Sleep: Ollama (free, background)
 * - Primary: OpenRouter (fast) + Sleep: Local (free, no rate limits)
 */
export interface SleepAgentConfig {
  enabled?: boolean;  // Enable sleep agent (default: false)
  backend?: 'local' | 'openrouter';  // Backend for sleep agent (claude not recommended - ToS)
  model?: string;  // Model name (e.g., 'qwen2.5:7b' for local, 'anthropic/claude-3-haiku' for openrouter)
  local_endpoint?: string;  // Local LLM endpoint (default: from llm.local_endpoint)
  max_tokens?: number;  // Max tokens (default: from llm.max_tokens)
  temperature?: number;  // Temperature (default: from llm.temperature)
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
    llm_backend?: 'claude' | 'local' | 'openrouter';  // LLM backend (default: 'claude')
    llm_model?: string;  // Model for Claude backend (default: 'haiku')
    local_endpoint?: string;  // Local LLM endpoint (default: 'http://localhost:11434/v1/chat/completions')
    local_model?: string;  // Model for local backend (default: 'qwen2.5:7b')
    openrouter_model?: string;  // Model for OpenRouter (default: 'anthropic/claude-3-haiku')
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
  mode?: 'local' | 'openrouter' | 'custom';  // Generation mode: local (Claude CLI), openrouter (API), custom (Ollama/LM Studio)
  model?: string;  // Model name: 'haiku'/'sonnet'/'opus' for local, 'anthropic/claude-3-haiku' for openrouter, etc.
  api_url?: string;  // Custom API URL (for custom mode, e.g., http://localhost:11434/v1)
  api_key?: string;  // Custom API key (for custom mode or openrouter override)
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
    mode?: 'claude' | 'openrouter' | 'local';  // Analysis mode (default: 'claude')
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
  quick_search_model?: string;        // Model for succ_quick_search (default: 'perplexity/sonar')
  quick_search_max_tokens?: number;   // Max tokens for quick search (default: 2000)
  quick_search_timeout_ms?: number;   // Timeout for quick search in ms (default: 15000)
  model?: string;                     // Model for succ_web_search (default: 'perplexity/sonar-pro')
  deep_research_model?: string;       // Model for succ_deep_research (default: 'perplexity/sonar-deep-research')
  max_tokens?: number;                // Max tokens for web search response (default: 4000)
  deep_research_max_tokens?: number;  // Max tokens for deep research (default: 8000)
  timeout_ms?: number;                // Timeout for web search in ms (default: 30000)
  deep_research_timeout_ms?: number;  // Timeout for deep research in ms (default: 120000)
  temperature?: number;               // Temperature (default: 0.1 — low for factual search)
  save_to_memory?: boolean;           // Auto-save search results to memory (default: false)
  daily_budget_usd?: number;          // Daily spending limit in USD (default: 0 = unlimited)
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
  sleep_agent?: {
    enabled?: boolean;  // Enable secondary sleep agent (default: false)
    mode?: 'local' | 'openrouter';  // local = Ollama/LM Studio, openrouter = API
    model?: string;  // Model name: 'qwen2.5:7b' for local, 'deepseek/deepseek-chat' for openrouter
    api_url?: string;  // API URL for local mode (e.g., 'http://localhost:11434/v1')
    api_key?: string;  // API key for openrouter (uses openrouter_api_key if not set)
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

// Model names for different modes
export const LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';  // 384 dimensions
export const OPENROUTER_MODEL = 'openai/text-embedding-3-small';

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

// Default sleep agent config
export const DEFAULT_SLEEP_AGENT_CONFIG = {
  enabled: false,
  mode: 'local' as const,
  model: '',
  api_url: '',
  api_key: '',
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
  mode: 'local',  // Default to local Claude CLI (safe fallback)
  model: 'haiku',  // Model name depends on mode
  api_url: '',  // Only needed for custom mode
  api_key: '',  // Only needed for custom mode or openrouter override
  include_learnings: true,
  include_memories: true,
  max_memories: 3,
  timeout_ms: 15000,  // 15s default timeout
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

const DEFAULT_CONFIG: Omit<SuccConfig, 'openrouter_api_key'> = {
  embedding_model: LOCAL_MODEL,
  embedding_mode: 'local',  // Local by default (no API key needed)
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

  // Try environment variable first
  const apiKey = process.env.OPENROUTER_API_KEY;

  // Read global config file
  let fileConfig: Partial<SuccConfig> = {};

  if (fs.existsSync(globalConfigPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));
    } catch {
      // Ignore parse errors
    }
  }

  // Read project config (deep merge for nested objects like storage, bpe)
  if (activeProjectPath) {
    try {
      const projectConfig = JSON.parse(fs.readFileSync(activeProjectPath, 'utf-8'));
      // Deep merge nested objects so project config extends (not replaces) global
      for (const [key, value] of Object.entries(projectConfig)) {
        if (value && typeof value === 'object' && !Array.isArray(value) &&
            fileConfig[key as keyof typeof fileConfig] && typeof fileConfig[key as keyof typeof fileConfig] === 'object' &&
            !Array.isArray(fileConfig[key as keyof typeof fileConfig])) {
          // Deep merge: global + project for nested objects (storage, bpe, etc.)
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

  const finalApiKey = apiKey || fileConfig.openrouter_api_key;

  // Determine embedding mode
  let embeddingMode = fileConfig.embedding_mode || DEFAULT_CONFIG.embedding_mode;

  // Determine model based on mode (unless explicitly set)
  let embeddingModel = fileConfig.embedding_model;
  if (!embeddingModel) {
    if (embeddingMode === 'local') {
      embeddingModel = LOCAL_MODEL;
    } else if (embeddingMode === 'openrouter') {
      embeddingModel = OPENROUTER_MODEL;
    } else {
      // Custom mode - user must specify model or we use a sensible default
      embeddingModel = 'text-embedding-3-small';
    }
  }

  // Validate mode requirements
  if (embeddingMode === 'openrouter' && !finalApiKey) {
    throw new Error(
      'OpenRouter API key required. Set OPENROUTER_API_KEY env var or add to ~/.succ/config.json\n' +
      'Or use embedding_mode: "local" (default, no API key needed)'
    );
  }

  if (embeddingMode === 'custom' && !fileConfig.embedding_api_url) {
    throw new Error(
      'Custom API URL required. Set embedding_api_url in config (e.g., "http://localhost:1234/v1/embeddings")'
    );
  }

  const result: SuccConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    embedding_model: embeddingModel,
    openrouter_api_key: finalApiKey,
    embedding_mode: embeddingMode,
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
 * Check if OpenRouter API key is available
 */
export function hasOpenRouterKey(): boolean {
  if (process.env.OPENROUTER_API_KEY) return true;

  const globalConfigPath = path.join(os.homedir(), '.succ', 'config.json');
  if (fs.existsSync(globalConfigPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));
      if (config.openrouter_api_key) return true;
    } catch {
      // Ignore
    }
  }

  return false;
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
    save_to_memory: userConfig.save_to_memory ?? false,
    daily_budget_usd: userConfig.daily_budget_usd ?? 0,
  };
}

export function getIdleReflectionConfig(): Required<IdleReflectionConfig> {
  const config = getConfig();
  const userConfig = config.idle_reflection || {};
  const userSleepAgent = userConfig.sleep_agent || {};

  // For openrouter mode, fall back to global openrouter_api_key if not set
  const sleepAgentApiKey = userSleepAgent.api_key ||
    (userSleepAgent.mode === 'openrouter' ? config.openrouter_api_key : '') ||
    DEFAULT_SLEEP_AGENT_CONFIG.api_key;

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
  // global=true + project=undefined → true (global opt-in honored)
  // global=true + project=false → false (project can restrict)
  // global=undefined + project=true → false (project alone can't enable)
  // global=false + project=true → false (global didn't opt-in)
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
      enabled: userSleepAgent.enabled ?? DEFAULT_SLEEP_AGENT_CONFIG.enabled,
      mode: userSleepAgent.mode ?? DEFAULT_SLEEP_AGENT_CONFIG.mode,
      model: userSleepAgent.model ?? DEFAULT_SLEEP_AGENT_CONFIG.model,
      api_url: userSleepAgent.api_url ?? DEFAULT_SLEEP_AGENT_CONFIG.api_url,
      api_key: sleepAgentApiKey,
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
    mode: userConfig.mode ?? DEFAULT_COMPACT_BRIEFING_CONFIG.mode,
    model: userConfig.model ?? DEFAULT_COMPACT_BRIEFING_CONFIG.model,
    api_url: userConfig.api_url ?? DEFAULT_COMPACT_BRIEFING_CONFIG.api_url,
    api_key: userConfig.api_key ?? DEFAULT_COMPACT_BRIEFING_CONFIG.api_key,
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
  const config = getIdleReflectionConfig();
  const ops = config.operations;
  const sleepAgent = config.sleep_agent;
  const sleepOps = sleepAgent.handle_operations;
  const sleepEnabled = sleepAgent.enabled && !!sleepAgent.model;

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
    openrouter_api_key?: string;
  };
  // Embedding settings
  embedding: {
    mode: 'local' | 'openrouter' | 'custom';
    model: string;
    api_url?: string;
    api_key?: string;
    batch_size: number;
    dimensions?: number;
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
  // Analyze settings
  analyze: {
    mode: 'claude' | 'openrouter' | 'local';
    model?: string;
    api_url?: string;
    api_key?: string;
    temperature: number;
    max_tokens: number;
  };
  // Quality scoring settings
  quality: {
    enabled: boolean;
    mode: 'local' | 'custom' | 'openrouter';
    model?: string;
    api_url?: string;
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
      mode: 'local' | 'openrouter';
      model?: string;
    };
  };
  // Idle watcher settings
  idle_watcher: {
    enabled: boolean;
    idle_minutes: number;
    check_interval: number;
    min_conversation_length: number;
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

  return {
    sources: {
      global: fs.existsSync(globalConfigPath) ? globalConfigPath : '(not found)',
      project: projectConfig,
      env: envVars,
      openrouter_api_key: config.openrouter_api_key ? mask(config.openrouter_api_key) : undefined,
    },
    embedding: {
      mode: config.embedding_mode,
      model: config.embedding_model,
      api_url: config.embedding_mode === 'custom' ? config.embedding_api_url : undefined,
      api_key: config.embedding_mode === 'custom' ? mask(config.embedding_api_key) : undefined,
      batch_size: config.embedding_batch_size ?? 32,
      dimensions: config.embedding_dimensions,
    },
    chunking: {
      chunk_size: config.chunk_size,
      chunk_overlap: config.chunk_overlap,
    },
    gpu: {
      enabled: config.gpu_enabled ?? true,
      device: config.gpu_device,
    },
    analyze: {
      mode: config.analyze_mode ?? 'claude',
      model: config.analyze_model,
      api_url: config.analyze_mode === 'local' ? config.analyze_api_url : undefined,
      api_key: config.analyze_mode !== 'claude' ? mask(config.analyze_api_key) : undefined,
      temperature: config.analyze_temperature ?? 0.3,
      max_tokens: config.analyze_max_tokens ?? 4096,
    },
    quality: {
      enabled: config.quality_scoring_enabled ?? true,
      mode: config.quality_scoring_mode ?? 'local',
      model: config.quality_scoring_model,
      api_url: config.quality_scoring_mode === 'custom' ? config.quality_scoring_api_url : undefined,
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
        mode: idleReflection.sleep_agent.mode ?? 'local',
        model: idleReflection.sleep_agent.model || undefined,
      },
    },
    idle_watcher: {
      enabled: idleWatcher.enabled,
      idle_minutes: idleWatcher.idle_minutes,
      check_interval: idleWatcher.check_interval,
      min_conversation_length: idleWatcher.min_conversation_length,
    },
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
  if (display.sources.openrouter_api_key) {
    lines.push(`  OpenRouter API Key: ${display.sources.openrouter_api_key}`);
  }
  lines.push('');

  // Embedding
  lines.push('## Embedding');
  lines.push(`  Mode: ${display.embedding.mode}`);
  lines.push(`  Model: ${display.embedding.model}`);
  if (display.embedding.api_url) {
    lines.push(`  API URL: ${display.embedding.api_url}`);
  }
  if (display.embedding.api_key) {
    lines.push(`  API Key: ${display.embedding.api_key}`);
  }
  lines.push(`  Batch size: ${display.embedding.batch_size}`);
  if (display.embedding.dimensions) {
    lines.push(`  Dimensions: ${display.embedding.dimensions}`);
  }
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

  // Analyze
  lines.push('## Analyze');
  lines.push(`  Mode: ${display.analyze.mode}`);
  if (display.analyze.model) {
    lines.push(`  Model: ${display.analyze.model}`);
  }
  if (display.analyze.api_url) {
    lines.push(`  API URL: ${display.analyze.api_url}`);
  }
  if (display.analyze.api_key) {
    lines.push(`  API Key: ${display.analyze.api_key}`);
  }
  lines.push(`  Temperature: ${display.analyze.temperature}`);
  lines.push(`  Max tokens: ${display.analyze.max_tokens}`);
  lines.push('');

  // Quality
  lines.push('## Quality Scoring');
  lines.push(`  Enabled: ${display.quality.enabled}`);
  lines.push(`  Mode: ${display.quality.mode}`);
  if (display.quality.model) {
    lines.push(`  Model: ${display.quality.model}`);
  }
  if (display.quality.api_url) {
    lines.push(`  API URL: ${display.quality.api_url}`);
  }
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
    lines.push(`  Sleep agent: ${display.idle_reflection.sleep_agent.mode} (${display.idle_reflection.sleep_agent.model || 'not configured'})`);
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
  chat_llm?: {
    backend?: 'local' | 'openrouter';
    model?: string;
    local_endpoint?: string;
    max_tokens?: number;
    temperature?: number;
  };
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
