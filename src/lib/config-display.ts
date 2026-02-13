/**
 * Configuration display and formatting functions
 *
 * Functions for displaying configuration in human-readable format
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ConfigDisplay } from './config-types.js';
import {
  getConfig,
  getIdleReflectionConfig,
  getIdleWatcherConfig,
  getRetrievalConfig,
  getWebSearchConfig,
  getErrorReportingConfig,
  getApiKey,
  getApiUrl,
  getLLMTaskConfig,
} from './config.js';

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

  const mask = (val: string | undefined) => (maskSecrets ? maskSensitive(val) : val || '(not set)');

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
      embeddings: {
        mode: embCfg.mode,
        model: embCfg.model,
        api_url: embCfg.mode === 'api' ? embCfg.api_url : undefined,
      },
      analyze: {
        mode: anlCfg.mode,
        model: anlCfg.model,
        api_url: anlCfg.mode === 'api' ? anlCfg.api_url : undefined,
        concurrency:
          ((config.llm?.analyze as Record<string, unknown> | undefined)?.concurrency as number) ??
          3,
      },
      quality: {
        mode: qCfg.mode,
        model: qCfg.model,
        api_url: qCfg.mode === 'api' ? qCfg.api_url : undefined,
      },
      chat: {
        mode: chatCfg.mode,
        model: chatCfg.model,
        max_tokens: chatCfg.max_tokens,
        temperature: chatCfg.temperature,
      },
      sleep: {
        enabled: config.llm?.sleep?.enabled ?? false,
        mode: sleepCfg.mode,
        model: sleepCfg.model,
      },
      skills: { mode: skillsCfg.mode, model: skillsCfg.model },
    },
    storage: (() => {
      const sc = config.storage;
      const result: ConfigDisplay['storage'] = {
        backend: sc?.backend || 'sqlite',
        vector: sc?.vector || 'builtin',
      };
      if (sc?.backend === 'postgresql' && sc.postgresql) {
        result.postgresql = {
          host: sc.postgresql.host || 'localhost',
          port: sc.postgresql.port || 5432,
          database: sc.postgresql.database,
          ssl: sc.postgresql.ssl ?? false,
          pool_size: sc.postgresql.pool_size ?? 10,
          connection_string: sc.postgresql.connection_string
            ? mask(sc.postgresql.connection_string)
            : undefined,
        };
      } else {
        result.sqlite = {
          path: sc?.sqlite?.path,
          global_path: sc?.sqlite?.global_path,
          wal_mode: sc?.sqlite?.wal_mode,
        };
      }
      if (sc?.vector === 'qdrant' && sc.qdrant) {
        result.qdrant = {
          url: sc.qdrant.url || 'http://localhost:6333',
          collection_prefix: sc.qdrant.collection_prefix || 'succ_',
          api_key: sc.qdrant.api_key ? mask(sc.qdrant.api_key) : undefined,
        };
      }
      return result;
    })(),
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

  // Storage
  lines.push('## Storage');
  lines.push(`  Backend: ${display.storage.backend}`);
  lines.push(`  Vector: ${display.storage.vector}`);
  if (display.storage.postgresql) {
    const pg = display.storage.postgresql;
    lines.push('  PostgreSQL:');
    if (pg.connection_string) {
      lines.push(`    Connection string: ${pg.connection_string}`);
    } else {
      lines.push(`    Host: ${pg.host}:${pg.port}`);
      if (pg.database) lines.push(`    Database: ${pg.database}`);
    }
    lines.push(`    SSL: ${pg.ssl}`);
    lines.push(`    Pool size: ${pg.pool_size}`);
  }
  if (display.storage.sqlite) {
    const sq = display.storage.sqlite;
    if (sq.path) lines.push(`  SQLite path: ${sq.path}`);
    if (sq.global_path) lines.push(`  SQLite global path: ${sq.global_path}`);
    if (sq.wal_mode !== undefined) lines.push(`  WAL mode: ${sq.wal_mode}`);
  }
  if (display.storage.qdrant) {
    const qd = display.storage.qdrant;
    lines.push('  Qdrant:');
    lines.push(`    URL: ${qd.url}`);
    lines.push(`    Collection prefix: ${qd.collection_prefix}`);
    if (qd.api_key) lines.push(`    API key: ${qd.api_key}`);
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
  lines.push(
    `    Mode: ${display.llm.analyze.mode}, Model: ${display.llm.analyze.model}, Concurrency: ${display.llm.analyze.concurrency}`
  );
  if (display.llm.analyze.api_url) lines.push(`    API URL: ${display.llm.analyze.api_url}`);
  lines.push('  Quality:');
  lines.push(`    Mode: ${display.llm.quality.mode}, Model: ${display.llm.quality.model}`);
  if (display.llm.quality.api_url) lines.push(`    API URL: ${display.llm.quality.api_url}`);
  lines.push('  Chat:');
  lines.push(
    `    Mode: ${display.llm.chat.mode}, Model: ${display.llm.chat.model}, Temp: ${display.llm.chat.temperature}`
  );
  lines.push('  Sleep:');
  lines.push(
    `    Enabled: ${display.llm.sleep.enabled}, Mode: ${display.llm.sleep.mode}, Model: ${display.llm.sleep.model}`
  );
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
  lines.push(
    `    - Similarity threshold: ${display.idle_reflection.thresholds.similarity_for_merge}`
  );
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
  lines.push(
    `  Quality boost: ${display.retrieval.quality_boost_enabled} (weight: ${display.retrieval.quality_boost_weight})`
  );
  lines.push(
    `  MMR diversity: ${display.retrieval.mmr_enabled} (lambda: ${display.retrieval.mmr_lambda})`
  );
  lines.push(
    `  Query expansion: ${display.retrieval.query_expansion_enabled} (mode: ${display.retrieval.query_expansion_mode})`
  );
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
  lines.push(
    `  Daily budget: ${display.web_search.daily_budget_usd > 0 ? `$${display.web_search.daily_budget_usd}` : 'unlimited'}`
  );
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
