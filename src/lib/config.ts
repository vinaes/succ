/**
 * Configuration system for succ
 *
 * Core configuration loading and management functions.
 * Type definitions are in config-types.ts
 * Default values are in config-defaults.ts
 * Display functions are in config-display.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { deepMerge, validateConfig } from './config-validation.js';

// Re-export all types (type-only exports use 'export type')
// Re-export all types from config-types.ts
export type {
  GateConfig,
  SubdirGateConfig,
  CommandSafetyGuardConfig,
  CommandSafetyPattern,
  QualityGatesConfig,
  SuccConfig,
  StorageConfig,
  LLMConfig,
  SkillsConfig,
  CompactBriefingConfig,
  DaemonConfig,
  RetentionPolicyConfig,
  TemporalConfig,
  ReadinessGateConfig,
  GraphLLMRelationsConfig,
  GraphContextualProximityConfig,
  GraphCommunityDetectionConfig,
  GraphCentralityConfig,
  WebSearchConfig,
  RetrievalConfig,
  ObserverConfig,
  ErrorReportingConfig,
  BPETokenizerConfig,
  IdleWatcherConfig,
  IdleReflectionConfig,
  ResolvedLLMTaskConfig,
  ConfigDisplay,
  DaemonStatus,
  GlobalConfig,
} from './config-types.js';

// Re-export IdleOperation and OperationAssignment as regular exports (not type-only)
export type { IdleOperation, OperationAssignment } from './config-types.js';

// Re-export all defaults
export {
  LOCAL_MODEL,
  DEFAULT_READINESS_GATE_CONFIG,
  DEFAULT_IDLE_WATCHER_CONFIG,
  DEFAULT_RETENTION_POLICY_CONFIG,
  DEFAULT_SLEEP_AGENT_CONFIG,
  DEFAULT_COMPACT_BRIEFING_CONFIG,
  DEFAULT_ERROR_REPORTING_CONFIG,
  DEFAULT_IDLE_REFLECTION_CONFIG,
  DEFAULT_CONFIG,
  DEFAULT_API_URL,
} from './config-defaults.js';

// Re-export display functions
export { getConfigDisplay, formatConfigDisplay } from './config-display.js';

// Import necessary types and defaults for internal use
import type {
  SuccConfig,
  ResolvedLLMTaskConfig,
  IdleWatcherConfig,
  RetentionPolicyConfig,
  CompactBriefingConfig,
  IdleReflectionConfig,
  WebSearchConfig,
  RetrievalConfig,
  ObserverConfig,
  GlobalConfig,
  DaemonStatus,
  IdleOperation,
  OperationAssignment as OperationAssignmentType,
} from './config-types.js';
import {
  DEFAULT_CONFIG,
  DEFAULT_API_URL,
  LOCAL_MODEL,
  DEFAULT_IDLE_WATCHER_CONFIG,
  DEFAULT_RETENTION_POLICY_CONFIG,
  DEFAULT_COMPACT_BRIEFING_CONFIG,
  DEFAULT_READINESS_GATE_CONFIG,
  DEFAULT_IDLE_REFLECTION_CONFIG,
  DEFAULT_SLEEP_AGENT_CONFIG,
  DEFAULT_ERROR_REPORTING_CONFIG,
} from './config-defaults.js';

// ============================================================================
// Core Configuration Functions
// ============================================================================

// Config cache: avoids re-reading files on every getConfig() call
let configCache: {
  config: SuccConfig;
  globalMtime: number;
  projectMtime: number;
  projectPath: string;
} | null = null;

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
    path.join(process.cwd(), '.claude', 'succ.json'), // legacy
  ];
  let activeProjectPath = '';
  for (const p of projectConfigPaths) {
    if (fs.existsSync(p)) {
      activeProjectPath = p;
      break;
    }
  }

  // Check if cache is still valid (stat is cheaper than read+parse)
  if (configCache) {
    const globalMtime = getFileMtime(globalConfigPath);
    const projectMtime = activeProjectPath ? getFileMtime(activeProjectPath) : 0;
    if (
      globalMtime === configCache.globalMtime &&
      projectMtime === configCache.projectMtime &&
      activeProjectPath === configCache.projectPath
    ) {
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

  // Read project config (recursive deep merge for nested objects like storage.sqlite, llm.embeddings, etc.)
  if (activeProjectPath) {
    try {
      const projectConfig = JSON.parse(fs.readFileSync(activeProjectPath, 'utf-8'));
      fileConfig = deepMerge(
        fileConfig as Record<string, unknown>,
        projectConfig
      ) as Partial<SuccConfig>;
    } catch {
      // Ignore parse errors
    }
  }

  // Validate critical config sections (logs warnings, never throws)
  const validated = validateConfig(fileConfig as Record<string, unknown>) as Partial<SuccConfig>;

  const result: SuccConfig = {
    ...DEFAULT_CONFIG,
    ...validated,
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
  if (
    envRoot &&
    (fs.existsSync(path.join(envRoot, '.succ')) || fs.existsSync(path.join(envRoot, '.git')))
  ) {
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
 * Get OpenRouter API key specifically (for web search tools).
 * Resolution: OPENROUTER_API_KEY env → web_search.api_key → llm.embeddings.api_key (if sk-or-) → llm.api_key (if sk-or-)
 * Only returns keys with sk-or- prefix (OpenRouter format), except env var which is trusted.
 */
export function getOpenRouterApiKey(): string | undefined {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const config = getConfig();
  const candidates = [
    config.web_search?.api_key,
    config.llm?.embeddings?.api_key,
    config.llm?.api_key,
  ];
  for (const key of candidates) {
    if (typeof key === 'string' && key.startsWith('sk-or-')) return key;
  }
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

// ============================================================================
// LLM Task Configuration Resolvers
// ============================================================================

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
  const globalTypeFallback =
    globalType && !(localOnlyTasks.has(task) && globalType === 'claude') ? globalType : undefined;

  const mode =
    ((taskConfig as Record<string, unknown>).mode as string) ||
    globalTypeFallback ||
    defaultModes[task];

  // llm.model is the global API/Claude model — don't use it as fallback for 'local' mode
  const globalModelFallback = mode === 'local' ? undefined : llm.model;
  const model =
    ((taskConfig as Record<string, unknown>).model as string) ||
    globalModelFallback ||
    defaultModels[mode] ||
    defaultModels['api'];

  const apiKey =
    ((taskConfig as Record<string, unknown>).api_key as string | undefined) ||
    llm.api_key ||
    process.env.OPENROUTER_API_KEY ||
    undefined;

  const apiUrl =
    ((taskConfig as Record<string, unknown>).api_url as string | undefined) ||
    llm.api_url ||
    DEFAULT_API_URL;

  const maxTokens =
    ((taskConfig as Record<string, unknown>).max_tokens as number | undefined) ??
    llm.max_tokens ??
    (task === 'chat' ? 4000 : task === 'analyze' ? 4096 : 2000);

  const temperature =
    ((taskConfig as Record<string, unknown>).temperature as number | undefined) ??
    llm.temperature ??
    (task === 'chat' ? 0.7 : 0.3);

  // Task-specific extra fields
  const batchSize =
    task === 'embeddings'
      ? (((taskConfig as Record<string, unknown>).batch_size as number | undefined) ?? 32)
      : undefined;

  const dimensions =
    task === 'embeddings'
      ? ((taskConfig as Record<string, unknown>).dimensions as number | undefined)
      : undefined;

  const concurrency =
    task === 'analyze'
      ? (((taskConfig as Record<string, unknown>).concurrency as number | undefined) ?? 3)
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
    min_conversation_length:
      userConfig.min_conversation_length ?? DEFAULT_IDLE_WATCHER_CONFIG.min_conversation_length,
    reflection_cooldown_minutes:
      userConfig.reflection_cooldown_minutes ??
      DEFAULT_IDLE_WATCHER_CONFIG.reflection_cooldown_minutes,
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
    max_access_boost:
      userConfig.max_access_boost ?? DEFAULT_RETENTION_POLICY_CONFIG.max_access_boost,
    keep_threshold: userConfig.keep_threshold ?? DEFAULT_RETENTION_POLICY_CONFIG.keep_threshold,
    delete_threshold:
      userConfig.delete_threshold ?? DEFAULT_RETENTION_POLICY_CONFIG.delete_threshold,
    default_quality_score:
      userConfig.default_quality_score ?? DEFAULT_RETENTION_POLICY_CONFIG.default_quality_score,
    auto_cleanup_interval_days:
      userConfig.auto_cleanup_interval_days ??
      DEFAULT_RETENTION_POLICY_CONFIG.auto_cleanup_interval_days,
    use_temporal_decay:
      userConfig.use_temporal_decay ?? DEFAULT_RETENTION_POLICY_CONFIG.use_temporal_decay,
  };
}

/**
 * Get web search configuration with defaults
 */
export function getWebSearchConfig(): Required<WebSearchConfig> {
  const config = getConfig();
  const userConfig = config.web_search || {};
  return {
    api_key: userConfig.api_key ?? '',
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
  const sleepEnabled =
    userSleepAgent.enabled ?? config.llm?.sleep?.enabled ?? DEFAULT_SLEEP_AGENT_CONFIG.enabled;

  // Safety: memory_consolidation requires GLOBAL opt-in.
  // Project config can DISABLE (false) but cannot ENABLE (true) on its own.
  // This prevents .succ/config.json from silently enabling destructive consolidation.
  let globalConsolidation: boolean | undefined;
  try {
    const globalCfg = loadGlobalConfig() as Record<string, unknown>;
    const idleRef = globalCfg.idle_reflection as Record<string, unknown> | undefined;
    const ops = idleRef?.operations as Record<string, unknown> | undefined;
    globalConsolidation = ops?.memory_consolidation as boolean | undefined;
  } catch {
    /* ignore parse errors */
  }

  // Rule: global must explicitly be true, AND merged value must not be false
  const consolidationEnabled =
    globalConsolidation === true && userConfig.operations?.memory_consolidation !== false;

  return {
    enabled: userConfig.enabled ?? DEFAULT_IDLE_REFLECTION_CONFIG.enabled,
    operations: {
      memory_consolidation: consolidationEnabled,
      graph_refinement:
        userConfig.operations?.graph_refinement ??
        DEFAULT_IDLE_REFLECTION_CONFIG.operations.graph_refinement,
      graph_enrichment:
        userConfig.operations?.graph_enrichment ??
        DEFAULT_IDLE_REFLECTION_CONFIG.operations.graph_enrichment,
      session_summary:
        userConfig.operations?.session_summary ??
        DEFAULT_IDLE_REFLECTION_CONFIG.operations.session_summary,
      precompute_context:
        userConfig.operations?.precompute_context ??
        DEFAULT_IDLE_REFLECTION_CONFIG.operations.precompute_context,
      write_reflection:
        userConfig.operations?.write_reflection ??
        DEFAULT_IDLE_REFLECTION_CONFIG.operations.write_reflection,
      retention_cleanup:
        userConfig.operations?.retention_cleanup ??
        DEFAULT_IDLE_REFLECTION_CONFIG.operations.retention_cleanup,
    },
    thresholds: {
      similarity_for_merge:
        userConfig.thresholds?.similarity_for_merge ??
        DEFAULT_IDLE_REFLECTION_CONFIG.thresholds.similarity_for_merge,
      auto_link_threshold:
        userConfig.thresholds?.auto_link_threshold ??
        DEFAULT_IDLE_REFLECTION_CONFIG.thresholds.auto_link_threshold,
      min_quality_for_summary:
        userConfig.thresholds?.min_quality_for_summary ??
        DEFAULT_IDLE_REFLECTION_CONFIG.thresholds.min_quality_for_summary,
    },
    agent_model: userConfig.agent_model ?? DEFAULT_IDLE_REFLECTION_CONFIG.agent_model,
    sleep_agent: {
      enabled: sleepEnabled,
      handle_operations: {
        memory_consolidation:
          userSleepAgent.handle_operations?.memory_consolidation ??
          DEFAULT_SLEEP_AGENT_CONFIG.handle_operations.memory_consolidation,
        session_summary:
          userSleepAgent.handle_operations?.session_summary ??
          DEFAULT_SLEEP_AGENT_CONFIG.handle_operations.session_summary,
        precompute_context:
          userSleepAgent.handle_operations?.precompute_context ??
          DEFAULT_SLEEP_AGENT_CONFIG.handle_operations.precompute_context,
      },
    },
    consolidation_guards: {
      min_memory_age_days:
        userConfig.consolidation_guards?.min_memory_age_days ??
        DEFAULT_IDLE_REFLECTION_CONFIG.consolidation_guards.min_memory_age_days,
      min_corpus_size:
        userConfig.consolidation_guards?.min_corpus_size ??
        DEFAULT_IDLE_REFLECTION_CONFIG.consolidation_guards.min_corpus_size,
      require_llm_merge:
        userConfig.consolidation_guards?.require_llm_merge ??
        DEFAULT_IDLE_REFLECTION_CONFIG.consolidation_guards.require_llm_merge,
    },
    max_memories_to_process:
      userConfig.max_memories_to_process ?? DEFAULT_IDLE_REFLECTION_CONFIG.max_memories_to_process,
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
    include_learnings:
      userConfig.include_learnings ?? DEFAULT_COMPACT_BRIEFING_CONFIG.include_learnings,
    include_memories:
      userConfig.include_memories ?? DEFAULT_COMPACT_BRIEFING_CONFIG.include_memories,
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
  const defaultThresholds = DEFAULT_READINESS_GATE_CONFIG.thresholds;

  return {
    enabled: userConfig.enabled ?? DEFAULT_READINESS_GATE_CONFIG.enabled,
    thresholds: {
      proceed: userThresholds.proceed ?? defaultThresholds.proceed,
      warn: userThresholds.warn ?? defaultThresholds.warn,
    },
    expected_results: userConfig.expected_results ?? DEFAULT_READINESS_GATE_CONFIG.expected_results,
  };
}

/**
 * Determine which agent handles each operation
 * Returns 'claude' or 'sleep' for each operation
 */
export function getOperationAssignments(): OperationAssignmentType[] {
  const idleConfig = getIdleReflectionConfig();
  const sleepTaskCfg = getLLMTaskConfig('sleep');
  const ops = idleConfig.operations;
  const sleepAgent = idleConfig.sleep_agent;
  const sleepOps = sleepAgent.handle_operations;
  const sleepEnabled = sleepAgent.enabled && !!sleepTaskCfg.model;

  const assignments: OperationAssignmentType[] = [
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
    .filter((a) => a.agent === agent && a.enabled)
    .map((a) => a.operation);
}

// ============================================================================
// Daemon Status Helpers
// ============================================================================

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

// ============================================================================
// Global Config Helpers (for onboarding state)
// ============================================================================

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
  let services: {
    watch?: { active?: boolean };
    analyze?: { active?: boolean; running?: boolean };
  } | null = null;
  if (daemonRunning && daemonPort) {
    try {
      const http = await import('http');
      services = await new Promise((resolve) => {
        const req = http.get(
          `http://127.0.0.1:${daemonPort}/api/services`,
          { timeout: 2000 },
          (res) => {
            let data = '';
            res.on('data', (chunk: string) => {
              data += chunk;
            });
            res.on('end', () => {
              try {
                resolve(JSON.parse(data));
              } catch {
                resolve(null);
              }
            });
          }
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
          req.destroy();
          resolve(null);
        });
      });
    } catch {
      /* daemon unreachable */
    }
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
    sentry_environment:
      user.sentry_environment ?? DEFAULT_ERROR_REPORTING_CONFIG.sentry_environment,
    sentry_sample_rate:
      user.sentry_sample_rate ?? DEFAULT_ERROR_REPORTING_CONFIG.sentry_sample_rate,
  };
}
