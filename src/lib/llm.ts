/**
 * Unified LLM Backend Module
 *
 * Provides a consistent interface for calling LLMs across succ.
 * Supports three backends:
 * - claude: Claude Code CLI (requires Claude Code subscription)
 * - local: Ollama or any OpenAI-compatible local server
 * - openrouter: OpenRouter API (requires OPENROUTER_API_KEY)
 *
 * Default backend is 'local' to avoid ToS issues with Claude CLI automation.
 */

import spawn from 'cross-spawn';
import { getConfig } from './config.js';

// ============================================================================
// Types
// ============================================================================

export type LLMBackend = 'claude' | 'local' | 'openrouter';

export interface LLMConfig {
  backend: LLMBackend;
  model: string;
  localEndpoint?: string;
  openrouterModel?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMOptions {
  timeout?: number;
  maxTokens?: number;
  temperature?: number;
  /** Use sleep agent config if available (for background operations) */
  useSleepAgent?: boolean;
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_LLM_CONFIG: LLMConfig = {
  backend: 'local', // Default to local to avoid Claude CLI ToS issues
  model: 'qwen2.5:7b',
  localEndpoint: 'http://localhost:11434/v1/chat/completions',
  openrouterModel: 'anthropic/claude-3-haiku',
  maxTokens: 2000,
  temperature: 0.3,
};

// ============================================================================
// Config Loading
// ============================================================================

/**
 * Get LLM config from succ config, with defaults
 */
export function getLLMConfig(): LLMConfig {
  const config = getConfig();
  const llmConfig = config.llm || {};

  return {
    backend: (llmConfig.backend as LLMBackend) || DEFAULT_LLM_CONFIG.backend,
    model: llmConfig.model || DEFAULT_LLM_CONFIG.model,
    localEndpoint: llmConfig.local_endpoint || DEFAULT_LLM_CONFIG.localEndpoint,
    openrouterModel: llmConfig.openrouter_model || DEFAULT_LLM_CONFIG.openrouterModel,
    maxTokens: llmConfig.max_tokens || DEFAULT_LLM_CONFIG.maxTokens,
    temperature: llmConfig.temperature || DEFAULT_LLM_CONFIG.temperature,
  };
}

/**
 * Get Sleep Agent config if enabled
 * Returns null if sleep agent is not enabled
 */
export function getSleepAgentConfig(): LLMConfig | null {
  const config = getConfig();
  const sleepAgent = config.sleep_agent;

  if (!sleepAgent?.enabled) {
    return null;
  }

  // Get base LLM config for fallback values
  const baseLlmConfig = getLLMConfig();

  // Sleep agent only supports local and openrouter (not claude - ToS issues)
  const backend = sleepAgent.backend || 'local';
  if (backend !== 'local' && backend !== 'openrouter') {
    console.warn(`[llm] Sleep agent backend '${backend}' not supported, using 'local'`);
  }

  // Determine model based on backend
  const effectiveModel = sleepAgent.model ||
    (backend === 'openrouter' ? baseLlmConfig.openrouterModel : baseLlmConfig.model) ||
    DEFAULT_LLM_CONFIG.model;

  return {
    backend: backend === 'openrouter' ? 'openrouter' : 'local',
    model: effectiveModel,
    localEndpoint: sleepAgent.local_endpoint || baseLlmConfig.localEndpoint,
    openrouterModel: backend === 'openrouter' ? (sleepAgent.model || baseLlmConfig.openrouterModel) : baseLlmConfig.openrouterModel,
    maxTokens: sleepAgent.max_tokens || baseLlmConfig.maxTokens,
    temperature: sleepAgent.temperature ?? baseLlmConfig.temperature,
  };
}

/**
 * Check if sleep agent is enabled
 */
export function isSleepAgentEnabled(): boolean {
  const config = getConfig();
  return config.sleep_agent?.enabled === true;
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Call LLM with the configured backend
 *
 * @param prompt - The prompt to send to the LLM
 * @param options - Optional overrides for timeout, maxTokens, temperature, useSleepAgent
 * @param configOverride - Optional config override (for testing or specific use cases)
 */
export async function callLLM(
  prompt: string,
  options: LLMOptions = {},
  configOverride?: Partial<LLMConfig>
): Promise<string> {
  // If useSleepAgent is true and sleep agent is enabled, use sleep agent config
  let baseConfig: LLMConfig;
  if (options.useSleepAgent) {
    const sleepAgentConfig = getSleepAgentConfig();
    baseConfig = sleepAgentConfig || getLLMConfig();
  } else {
    baseConfig = getLLMConfig();
  }

  const config = { ...baseConfig, ...configOverride };
  const timeout = options.timeout || 30000;
  const maxTokens = options.maxTokens || config.maxTokens || 2000;
  const temperature = options.temperature ?? config.temperature ?? 0.3;

  switch (config.backend) {
    case 'claude':
      return runClaudeCLI(prompt, config.model, timeout);

    case 'local':
      return callLocalLLM(prompt, config.localEndpoint!, config.model, timeout, maxTokens, temperature);

    case 'openrouter':
      return callOpenRouter(prompt, config.openrouterModel!, timeout, maxTokens, temperature);

    default:
      throw new Error(`Unknown LLM backend: ${config.backend}`);
  }
}

/**
 * Call LLM with fallback chain
 * Tries backends in order until one succeeds
 */
export async function callLLMWithFallback(
  prompt: string,
  options: LLMOptions = {},
  preferredBackend?: LLMBackend
): Promise<string> {
  const config = getLLMConfig();
  const backends: LLMBackend[] = ['local', 'openrouter', 'claude'];
  const preferred = preferredBackend || config.backend;

  // Order: preferred first, then others
  const orderedBackends = [preferred, ...backends.filter((b) => b !== preferred)];

  let lastError: Error | null = null;

  for (const backend of orderedBackends) {
    try {
      return await callLLM(prompt, options, { backend });
    } catch (err) {
      lastError = err as Error;
      console.warn(`[llm] ${backend} failed: ${lastError.message}`);
      // Continue to next backend
    }
  }

  throw lastError || new Error('All LLM backends failed');
}

// ============================================================================
// Backend Implementations
// ============================================================================

/**
 * Call Claude Code CLI
 * WARNING: Using this programmatically may violate Anthropic ToS
 */
function runClaudeCLI(prompt: string, model: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--model', model], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SUCC_SERVICE_SESSION: '1' },
      windowsHide: true,
    });

    proc.stdin?.write(prompt);
    proc.stdin?.end();

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Claude CLI timeout'));
    }, timeout);

    proc.on('close', (code: number) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Claude CLI failed: ${stderr || 'unknown error'}`));
      }
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Call local LLM (Ollama or OpenAI-compatible)
 */
async function callLocalLLM(
  prompt: string,
  endpoint: string,
  model: string,
  timeout: number,
  maxTokens: number,
  temperature: number
): Promise<string> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    throw new Error(`Local LLM error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  if (!data.choices || data.choices.length === 0) {
    throw new Error('Local LLM returned no choices');
  }

  return data.choices[0].message.content;
}

/**
 * Call OpenRouter API
 */
async function callOpenRouter(
  prompt: string,
  model: string,
  timeout: number,
  maxTokens: number,
  temperature: number
): Promise<string> {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not set');
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://succ.ai',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[llm] OpenRouter error body: ${errorBody}`);
    throw new Error(`OpenRouter error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  if (!data.choices || data.choices.length === 0) {
    throw new Error('OpenRouter returned no choices');
  }

  return data.choices[0].message.content;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if local LLM is available
 */
export async function isLocalLLMAvailable(): Promise<boolean> {
  const config = getLLMConfig();
  try {
    const response = await fetch(config.localEndpoint!.replace('/chat/completions', '/models'), {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get OpenRouter API key from env or config
 */
function getOpenRouterApiKey(): string | undefined {
  if (process.env.OPENROUTER_API_KEY) {
    return process.env.OPENROUTER_API_KEY;
  }
  const config = getConfig();
  return config.openrouter_api_key;
}

/**
 * Check if OpenRouter is configured
 */
export function isOpenRouterConfigured(): boolean {
  return !!getOpenRouterApiKey();
}

/**
 * Get available backends
 */
export async function getAvailableBackends(): Promise<LLMBackend[]> {
  const available: LLMBackend[] = ['claude']; // Always available if Claude Code is installed

  if (await isLocalLLMAvailable()) {
    available.unshift('local'); // Prefer local
  }

  if (isOpenRouterConfigured()) {
    available.push('openrouter');
  }

  return available;
}
