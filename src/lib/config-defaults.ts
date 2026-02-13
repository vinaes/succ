/**
 * Default configuration values for succ
 *
 * All default constants extracted from config.ts
 */

import type {
  SuccConfig,
  IdleWatcherConfig,
  RetentionPolicyConfig,
  CompactBriefingConfig,
  IdleReflectionConfig,
} from './config-types.js';

// Default embedding model for local ONNX mode
export const LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2'; // 384 dimensions

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
  enabled: false, // Manual only by default
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
export const DEFAULT_IDLE_REFLECTION_CONFIG: Required<IdleReflectionConfig> = {
  enabled: true,
  operations: {
    memory_consolidation: false,
    graph_refinement: true,
    graph_enrichment: true,
    session_summary: true,
    precompute_context: true,
    write_reflection: true,
    retention_cleanup: true, // Enabled by default (only runs if retention.enabled=true in config)
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

// Default base config
export const DEFAULT_CONFIG: SuccConfig = {
  chunk_size: 500,
  chunk_overlap: 50,
};

/** Default API URL */
export const DEFAULT_API_URL = 'http://localhost:11434/v1';
