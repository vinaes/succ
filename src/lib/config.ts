import fs from 'fs';
import path from 'path';
import os from 'os';

export interface SuccConfig {
  openrouter_api_key?: string;
  embedding_model: string;
  embedding_mode: 'local' | 'openrouter' | 'custom';
  custom_api_url?: string;  // For custom API (llama.cpp, LM Studio, etc.)
  custom_api_key?: string;  // Optional API key for custom endpoint
  chunk_size: number;
  chunk_overlap: number;
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
