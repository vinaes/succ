import fs from 'fs';
import path from 'path';
import os from 'os';

export interface SuccConfig {
  openrouter_api_key?: string;
  embedding_model: string;
  embedding_mode: 'local' | 'openrouter' | 'custom';
  embedding_api_url?: string;  // For custom API (llama.cpp, LM Studio, Ollama, etc.)
  embedding_api_key?: string;  // Optional API key for custom endpoint
  embedding_batch_size?: number;  // Batch size for custom API (default 32, llama.cpp works well with larger batches)
  embedding_dimensions?: number;  // Override embedding dimensions for custom models
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
}

export interface IdleReflectionConfig {
  enabled?: boolean;  // Enable idle reflection (default: true)
  // Operations to perform during idle time
  operations?: {
    memory_consolidation?: boolean;  // Merge similar memories, remove duplicates (default: true)
    graph_refinement?: boolean;  // Auto-link memories by similarity (default: true)
    session_summary?: boolean;  // Extract key facts from session transcript (default: true)
    precompute_context?: boolean;  // Prepare context for next session-start (default: false)
    write_reflection?: boolean;  // Write human-like reflection text (default: true)
    retention_cleanup?: boolean;  // Delete decayed memories below threshold (default: true if retention.enabled)
  };
  // Thresholds for operations
  thresholds?: {
    similarity_for_merge?: number;  // Cosine similarity to consider memories duplicates (default: 0.85)
    auto_link_threshold?: number;  // Similarity threshold for graph auto-linking (default: 0.75)
    min_quality_for_summary?: number;  // Min quality score for facts extracted from session (default: 0.5)
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

// Default idle watcher config
export const DEFAULT_IDLE_WATCHER_CONFIG: Required<IdleWatcherConfig> = {
  enabled: true,
  idle_minutes: 2,
  check_interval: 30,
  min_conversation_length: 5,
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

// Default idle reflection config
export const DEFAULT_IDLE_REFLECTION_CONFIG = {
  enabled: true,
  operations: {
    memory_consolidation: true,
    graph_refinement: true,
    session_summary: true,
    precompute_context: true,
    write_reflection: true,
    retention_cleanup: true,  // Enabled by default (only runs if retention.enabled=true in config)
  },
  thresholds: {
    similarity_for_merge: 0.85,
    auto_link_threshold: 0.75,
    min_quality_for_summary: 0.5,
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

export function getConfig(): SuccConfig {
  // Try environment variable first
  const apiKey = process.env.OPENROUTER_API_KEY;

  // Try global config file
  const globalConfigPath = path.join(os.homedir(), '.succ', 'config.json');
  let fileConfig: Partial<SuccConfig> = {};

  if (fs.existsSync(globalConfigPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));
    } catch {
      // Ignore parse errors
    }
  }

  // Try project config (check .succ first, then legacy .claude)
  const projectConfigPaths = [
    path.join(process.cwd(), '.succ', 'config.json'),
    path.join(process.cwd(), '.claude', 'succ.json'),  // legacy
  ];
  for (const projectConfigPath of projectConfigPaths) {
    if (fs.existsSync(projectConfigPath)) {
      try {
        const projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
        fileConfig = { ...fileConfig, ...projectConfig };
        break;
      } catch {
        // Ignore parse errors
      }
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

  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    embedding_model: embeddingModel,
    openrouter_api_key: finalApiKey,
    embedding_mode: embeddingMode,
  };
}

export function getProjectRoot(): string {
  // Walk up to find .git or .succ (legacy: .claude)
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git')) ||
        fs.existsSync(path.join(dir, '.succ')) ||
        fs.existsSync(path.join(dir, '.claude'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export function getSuccDir(): string {
  return path.join(getProjectRoot(), '.succ');
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
  };
}

/**
 * Get idle reflection configuration with defaults
 */
export function getIdleReflectionConfig(): Required<IdleReflectionConfig> {
  const config = getConfig();
  const userConfig = config.idle_reflection || {};
  const userSleepAgent = userConfig.sleep_agent || {};

  // For openrouter mode, fall back to global openrouter_api_key if not set
  const sleepAgentApiKey = userSleepAgent.api_key ||
    (userSleepAgent.mode === 'openrouter' ? config.openrouter_api_key : '') ||
    DEFAULT_SLEEP_AGENT_CONFIG.api_key;

  return {
    enabled: userConfig.enabled ?? DEFAULT_IDLE_REFLECTION_CONFIG.enabled,
    operations: {
      memory_consolidation: userConfig.operations?.memory_consolidation ?? DEFAULT_IDLE_REFLECTION_CONFIG.operations.memory_consolidation,
      graph_refinement: userConfig.operations?.graph_refinement ?? DEFAULT_IDLE_REFLECTION_CONFIG.operations.graph_refinement,
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
    max_memories_to_process: userConfig.max_memories_to_process ?? DEFAULT_IDLE_REFLECTION_CONFIG.max_memories_to_process,
    timeout_seconds: userConfig.timeout_seconds ?? DEFAULT_IDLE_REFLECTION_CONFIG.timeout_seconds,
  };
}

/**
 * Determine which agent handles each operation
 * Returns 'claude' or 'sleep' for each operation
 */
export type IdleOperation = 'memory_consolidation' | 'graph_refinement' | 'session_summary' | 'precompute_context' | 'write_reflection';

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
      session_summary: boolean;
      precompute_context: boolean;
      write_reflection: boolean;
      retention_cleanup: boolean;
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
        memory_consolidation: idleReflection.operations.memory_consolidation ?? true,
        graph_refinement: idleReflection.operations.graph_refinement ?? true,
        session_summary: idleReflection.operations.session_summary ?? true,
        precompute_context: idleReflection.operations.precompute_context ?? false,
        write_reflection: idleReflection.operations.write_reflection ?? true,
        retention_cleanup: idleReflection.operations.retention_cleanup ?? true,
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
  lines.push(`    - Session summary: ${ops.session_summary}`);
  lines.push(`    - Precompute context: ${ops.precompute_context}`);
  lines.push(`    - Write reflection: ${ops.write_reflection}`);
  lines.push(`    - Retention cleanup: ${ops.retention_cleanup}`);
  if (display.idle_reflection.sleep_agent.enabled) {
    lines.push(`  Sleep agent: ${display.idle_reflection.sleep_agent.mode} (${display.idle_reflection.sleep_agent.model || 'not configured'})`);
  }
  lines.push('');

  // Idle Watcher
  lines.push('## Idle Watcher');
  lines.push(`  Enabled: ${display.idle_watcher.enabled}`);
  lines.push(`  Idle minutes: ${display.idle_watcher.idle_minutes}`);
  lines.push(`  Check interval: ${display.idle_watcher.check_interval}s`);
  lines.push(`  Min conversation length: ${display.idle_watcher.min_conversation_length}`);

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

/**
 * Get status of all succ daemons (watch, analyze)
 */
export function getDaemonStatuses(): DaemonStatus[] {
  const succDir = getSuccDir();
  const statuses: DaemonStatus[] = [];

  // Watch daemon
  const watchPidFile = path.join(succDir, 'watch.pid');
  const watchLogFile = path.join(succDir, 'watch.log');
  if (fs.existsSync(watchPidFile)) {
    const pid = parseInt(fs.readFileSync(watchPidFile, 'utf-8').trim(), 10);
    statuses.push({
      name: 'watch',
      running: isProcessRunning(pid),
      pid,
      pidFile: watchPidFile,
      logFile: fs.existsSync(watchLogFile) ? watchLogFile : undefined,
    });
  } else {
    statuses.push({ name: 'watch', running: false });
  }

  // Analyze daemon
  const analyzePidFile = path.join(succDir, 'daemon.pid');
  const analyzeLogFile = path.join(succDir, 'daemon.log');
  if (fs.existsSync(analyzePidFile)) {
    const pid = parseInt(fs.readFileSync(analyzePidFile, 'utf-8').trim(), 10);
    statuses.push({
      name: 'analyze',
      running: isProcessRunning(pid),
      pid,
      pidFile: analyzePidFile,
      logFile: fs.existsSync(analyzeLogFile) ? analyzeLogFile : undefined,
    });
  } else {
    statuses.push({ name: 'analyze', running: false });
  }

  // Idle watcher (from hooks)
  const tmpDir = path.join(succDir, '.tmp');
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
