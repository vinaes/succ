import fs from 'fs';
import path from 'path';
import os from 'os';

export interface SuccConfig {
  openrouter_api_key?: string;
  embedding_model: string;
  embedding_mode: 'local' | 'openrouter';
  chunk_size: number;
  chunk_overlap: number;
}

const DEFAULT_CONFIG: Omit<SuccConfig, 'openrouter_api_key'> = {
  embedding_model: 'openai/text-embedding-3-small',
  embedding_mode: 'openrouter',  // OpenRouter by default (local mode experimental on Windows)
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

  // If OpenRouter mode and no API key, error
  if (embeddingMode === 'openrouter' && !finalApiKey) {
    throw new Error(
      'OpenRouter API key required for embeddings. Set OPENROUTER_API_KEY env var or add to ~/.succ/config.json\n' +
      'Or set embedding_mode: "local" in config (experimental, requires model download)'
    );
  }

  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    openrouter_api_key: finalApiKey,
    embedding_mode: embeddingMode,
  };
}

/**
 * Get config, requiring OpenRouter API key
 */
export function getConfigWithApiKey(): SuccConfig & { openrouter_api_key: string } {
  const config = getConfig();
  if (!config.openrouter_api_key) {
    throw new Error(
      'OpenRouter API key not found. Set OPENROUTER_API_KEY env var or add to ~/.succ/config.json'
    );
  }
  return config as SuccConfig & { openrouter_api_key: string };
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
