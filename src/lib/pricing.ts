/**
 * Token Pricing for Claude Models
 *
 * Provides "Claude equivalent" pricing for token savings comparison.
 * This allows users to understand the value of saved tokens regardless
 * of which LLM backend they actually use (Ollama, OpenRouter, Claude CLI).
 *
 * Prices are per million tokens.
 * Source: https://www.anthropic.com/api
 */

export interface ModelPricing {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

/**
 * Pricing rates per million tokens for Claude models
 */
export const PRICING: Record<string, ModelPricing> = {
  // --- Claude 4.5 (Current) ---
  'claude-opus-4-5-20251101': {
    input: 15.0,
    output: 75.0,
    cache_write: 18.75,
    cache_read: 1.5,
  },
  'claude-sonnet-4-5-20251101': {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3,
  },

  // --- Claude 4 ---
  'claude-opus-4-20250514': {
    input: 15.0,
    output: 75.0,
    cache_write: 18.75,
    cache_read: 1.5,
  },
  'claude-sonnet-4-20250514': {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3,
  },

  // --- Claude 3.5 ---
  'claude-3-5-sonnet-20241022': {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3,
  },
  'claude-3-5-sonnet-20240620': {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3,
  },
  'claude-3-5-haiku-20241022': {
    input: 0.8,
    output: 4.0,
    cache_write: 1.0,
    cache_read: 0.08,
  },

  // --- Claude 3 ---
  'claude-3-opus-20240229': {
    input: 15.0,
    output: 75.0,
    cache_write: 18.75,
    cache_read: 1.5,
  },
  'claude-3-sonnet-20240229': {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3,
  },
  'claude-3-haiku-20240307': {
    input: 0.25,
    output: 1.25,
    cache_write: 0.3125,
    cache_read: 0.025,
  },
};

// Aliases for common model names
const MODEL_ALIASES: Record<string, string> = {
  // Short names
  opus: 'claude-opus-4-5-20251101',
  sonnet: 'claude-sonnet-4-5-20251101',
  haiku: 'claude-3-5-haiku-20241022',

  // Version shortcuts
  'opus-4.5': 'claude-opus-4-5-20251101',
  'sonnet-4.5': 'claude-sonnet-4-5-20251101',
  'opus-4': 'claude-opus-4-20250514',
  'sonnet-4': 'claude-sonnet-4-20250514',
  'sonnet-3.5': 'claude-3-5-sonnet-20241022',
  'haiku-3.5': 'claude-3-5-haiku-20241022',
  'haiku-3': 'claude-3-haiku-20240307',
};

// Default model for unknown inputs
const DEFAULT_MODEL = 'claude-sonnet-4-5-20251101';

/**
 * Get pricing for a model, with fuzzy matching
 */
export function getModelPricing(modelId?: string): ModelPricing {
  if (!modelId) {
    return PRICING[DEFAULT_MODEL];
  }

  // Direct match
  if (PRICING[modelId]) {
    return PRICING[modelId];
  }

  // Check aliases
  const lowerModel = modelId.toLowerCase();
  if (MODEL_ALIASES[lowerModel]) {
    return PRICING[MODEL_ALIASES[lowerModel]];
  }

  // Fuzzy match by model family
  if (lowerModel.includes('opus')) {
    if (lowerModel.includes('4.5') || lowerModel.includes('4-5')) {
      return PRICING['claude-opus-4-5-20251101'];
    }
    if (lowerModel.includes('4')) {
      return PRICING['claude-opus-4-20250514'];
    }
    return PRICING['claude-3-opus-20240229'];
  }

  if (lowerModel.includes('sonnet')) {
    if (lowerModel.includes('4.5') || lowerModel.includes('4-5')) {
      return PRICING['claude-sonnet-4-5-20251101'];
    }
    if (lowerModel.includes('4')) {
      return PRICING['claude-sonnet-4-20250514'];
    }
    return PRICING['claude-3-5-sonnet-20241022'];
  }

  if (lowerModel.includes('haiku')) {
    if (lowerModel.includes('3.5') || lowerModel.includes('3-5')) {
      return PRICING['claude-3-5-haiku-20241022'];
    }
    return PRICING['claude-3-haiku-20240307'];
  }

  // Default
  return PRICING[DEFAULT_MODEL];
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface CostBreakdown {
  total: number;
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

/**
 * Calculate cost for token usage
 */
export function calculateCost(usage: TokenUsage, modelId?: string): CostBreakdown {
  const pricing = getModelPricing(modelId);

  const inputCost = (usage.input_tokens / 1_000_000) * pricing.input;
  const outputCost = (usage.output_tokens / 1_000_000) * pricing.output;
  const cacheWriteCost = ((usage.cache_creation_input_tokens || 0) / 1_000_000) * pricing.cache_write;
  const cacheReadCost = ((usage.cache_read_input_tokens || 0) / 1_000_000) * pricing.cache_read;

  return {
    total: inputCost + outputCost + cacheWriteCost + cacheReadCost,
    input: inputCost,
    output: outputCost,
    cache_write: cacheWriteCost,
    cache_read: cacheReadCost,
  };
}

/**
 * Estimate cost for saved tokens (tokens not sent to API)
 * Uses input pricing since saved tokens would have been input tokens
 */
export function estimateSavings(savedTokens: number, modelId?: string): number {
  const pricing = getModelPricing(modelId);
  return (savedTokens / 1_000_000) * pricing.input;
}

/**
 * Format cost as USD string
 */
export function formatCost(cost: number): string {
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  if (cost < 1) {
    return `$${cost.toFixed(3)}`;
  }
  return `$${cost.toFixed(2)}`;
}

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Get current model from environment variable, Claude Code transcript, or default to sonnet
 *
 * Priority:
 * 1. ANTHROPIC_MODEL env var (explicit override)
 * 2. Most recent Claude Code session transcript (automatic detection)
 * 3. Default to 'sonnet'
 */
export function getCurrentModel(): string {
  // 1. Check env var first (explicit override)
  if (process.env.ANTHROPIC_MODEL) {
    return process.env.ANTHROPIC_MODEL;
  }

  // 2. Try to detect from Claude Code session transcript
  try {
    const detectedModel = detectModelFromClaudeCode();
    if (detectedModel) {
      return detectedModel;
    }
  } catch {
    // Ignore errors, fall back to default
  }

  // 3. Default
  return 'sonnet';
}

/**
 * Detect model from Claude Code session transcript
 * Reads the most recent session in current project and extracts model from assistant messages
 */
function detectModelFromClaudeCode(): string | null {
  const claudeDir = path.join(os.homedir(), '.claude');
  const projectsDir = path.join(claudeDir, 'projects');

  if (!fs.existsSync(projectsDir)) {
    return null;
  }

  // Get current working directory to find matching project
  const cwd = process.cwd();
  const projectDirName = cwd.replace(/[:/\\]/g, '-').replace(/^-/, '');

  // Find project directory (case-insensitive on Windows)
  const projectDirs = fs.readdirSync(projectsDir);
  const matchingDir = projectDirs.find(
    (d) => d.toLowerCase() === projectDirName.toLowerCase()
  );

  if (!matchingDir) {
    return null;
  }

  const projectPath = path.join(projectsDir, matchingDir);

  // Find most recent .jsonl file (session transcript)
  const files = fs.readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) {
    return null;
  }

  // Sort by mtime, get most recent
  const sortedFiles = files
    .map((f) => ({
      name: f,
      mtime: fs.statSync(path.join(projectPath, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.mtime - a.mtime);

  const latestSession = path.join(projectPath, sortedFiles[0].name);

  // Read last few KB of file to find model (reading from end is faster for large files)
  const stats = fs.statSync(latestSession);
  const readSize = Math.min(stats.size, 50000); // Last 50KB should be enough
  const fd = fs.openSync(latestSession, 'r');
  const buffer = Buffer.alloc(readSize);
  fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
  fs.closeSync(fd);

  const content = buffer.toString('utf-8');

  // Find last occurrence of "model":"..." in assistant messages
  const modelMatches = content.match(/"model"\s*:\s*"([^"]+)"/g);
  if (!modelMatches || modelMatches.length === 0) {
    return null;
  }

  // Get the last match and extract model name
  const lastMatch = modelMatches[modelMatches.length - 1];
  const modelName = lastMatch.match(/"model"\s*:\s*"([^"]+)"/)?.[1];

  return modelName || null;
}
