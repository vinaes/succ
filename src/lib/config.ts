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
  // Idle reflection settings (sleep-time compute)
  idle_reflection?: IdleReflectionConfig;
  // Idle watcher settings (smart activity-based reflections)
  idle_watcher?: IdleWatcherConfig;
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
    precompute_context: false,  // Disabled by default - experimental
    write_reflection: true,
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
