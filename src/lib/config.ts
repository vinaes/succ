import fs from 'fs';
import path from 'path';
import os from 'os';

export interface SuccConfig {
  openrouter_api_key?: string;
  embedding_model: string;
  embedding_mode: 'local' | 'openrouter' | 'custom';
  custom_api_url?: string;  // For custom API (llama.cpp, LM Studio, Ollama, etc.)
  custom_api_key?: string;  // Optional API key for custom endpoint
  custom_batch_size?: number;  // Batch size for custom API (default 32, llama.cpp works well with larger batches)
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
  graph_export_path?: string;  // Custom export path (default: .claude/brain/graph)
  // Analyze mode settings (for succ analyze)
  analyze_mode?: 'claude' | 'openrouter' | 'local';  // claude = Claude CLI (default), openrouter = OpenRouter API, local = local LLM
  analyze_api_url?: string;  // Local LLM API URL (e.g., http://localhost:11434/v1 for Ollama)
  analyze_api_key?: string;  // Optional API key for local LLM
  analyze_model?: string;  // Model name for local/openrouter (e.g., qwen2.5-coder:32b, deepseek-coder-v2)
  analyze_temperature?: number;  // Temperature for generation (default: 0.3)
  analyze_max_tokens?: number;  // Max tokens per response (default: 4096)
}

// Model names for different modes
export const LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';  // 384 dimensions
export const OPENROUTER_MODEL = 'openai/text-embedding-3-small';

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

  // Try project config
  const projectConfigPath = path.join(process.cwd(), '.claude', 'succ.json');
  if (fs.existsSync(projectConfigPath)) {
    try {
      const projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
      fileConfig = { ...fileConfig, ...projectConfig };
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

  if (embeddingMode === 'custom' && !fileConfig.custom_api_url) {
    throw new Error(
      'Custom API URL required. Set custom_api_url in config (e.g., "http://localhost:1234/v1/embeddings")'
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
  // Walk up to find .git or .claude
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.claude'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export function getClaudeDir(): string {
  return path.join(getProjectRoot(), '.claude');
}

export function getDbPath(): string {
  return path.join(getClaudeDir(), 'succ.db');
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
