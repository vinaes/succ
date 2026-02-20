/**
 * Unified LLM Backend Module
 *
 * Two modes:
 * - claude: Claude Code CLI (process or WebSocket transport)
 * - api: Any OpenAI-compatible HTTP endpoint (Ollama, OpenRouter, nano-gpt, etc.)
 *
 * OpenRouter headers (HTTP-Referer, X-Title) are auto-sent when api_url contains 'openrouter.ai'.
 */

import spawn from 'cross-spawn';
import { logError, logWarn } from './fault-logger.js';
// cross-spawn exposes .sync at runtime but not in types

// cross-spawn's sync method is available at runtime but not in types
// Keep as any since cross-spawn types are incomplete
const crossSpawnSync = (spawn as any).sync as (...args: any[]) => any;
import {
  getConfig,
  getLLMTaskConfig,
  getApiKey,
  getApiUrl,
  getOpenRouterApiKey,
} from './config.js';
import { ClaudeWSTransport } from './claude-ws-transport.js';
import { NetworkError, ConfigError } from './errors.js';
import { processRegistry } from './process-registry.js';

// ============================================================================
// Types
// ============================================================================

export type LLMBackend = 'claude' | 'api';

export interface LLMRuntimeConfig {
  backend: LLMBackend;
  model: string;
  endpoint?: string; // API URL (for 'api' mode)
  apiKey?: string; // API key (for 'api' mode)
  maxTokens?: number;
  temperature?: number;
}

export interface LLMOptions {
  timeout?: number;
  maxTokens?: number;
  temperature?: number;
  /** Use sleep agent config if available (for background operations) */
  useSleepAgent?: boolean;
  /** Use chat_llm config (for interactive chats like succ chat, onboarding) */
  useChatLLM?: boolean;
  /**
   * Separate system prompt for prompt caching optimization.
   * When provided, sent as a dedicated system message before the user prompt.
   * This enables LLM providers to cache the stable system prefix across calls.
   */
  systemPrompt?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ============================================================================
// Claude Mode (process vs ws)
// ============================================================================

/**
 * Get Claude transport mode from config.
 * Reads: llm.transport → llm.claude.transport → 'process'
 */
export function getClaudeMode(): 'process' | 'ws' {
  const config = getConfig();
  const llm = config.llm;
  if (!llm) return 'process';

  if (llm.transport === 'ws' || llm.transport === 'process') return llm.transport;
  if (llm.claude?.transport) return llm.claude.transport;

  return 'process';
}

// ============================================================================
// Config Loading
// ============================================================================

/**
 * Build headers for an API call.
 * Auto-adds OpenRouter-specific headers when endpoint contains 'openrouter.ai'.
 */
function buildApiHeaders(endpoint: string, apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // OpenRouter-specific headers
  if (endpoint.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://succ.ai';
    headers['X-Title'] = 'succ';
  }

  return headers;
}

/**
 * Get LLM runtime config from succ config, with defaults.
 * Reads from llm.type/model/api_url/api_key.
 */
export function getLLMConfig(): LLMRuntimeConfig {
  const config = getConfig();
  const llm = config.llm || {};

  const backend: LLMBackend = (llm.type as LLMBackend) || 'api';
  const model = llm.model || (backend === 'claude' ? 'haiku' : 'qwen2.5:7b');

  return {
    backend,
    model,
    endpoint: getApiUrl() + '/chat/completions',
    apiKey: getApiKey(),
    maxTokens: llm.max_tokens ?? 2000,
    temperature: llm.temperature ?? 0.3,
  };
}

/**
 * Get Sleep Agent config if enabled.
 * Reads from llm.sleep.*.
 */
export function getSleepAgentConfig(): LLMRuntimeConfig | null {
  const config = getConfig();
  const sleepEnabled = config.llm?.sleep?.enabled;

  if (!sleepEnabled) return null;

  const taskCfg = getLLMTaskConfig('sleep');

  return {
    backend: 'api', // Sleep agent is always 'api' (claude = ToS issues)
    model: taskCfg.model,
    endpoint: taskCfg.api_url + '/chat/completions',
    apiKey: taskCfg.api_key,
    maxTokens: taskCfg.max_tokens,
    temperature: taskCfg.temperature,
  };
}

/**
 * Check if sleep agent is enabled
 */
export function isSleepAgentEnabled(): boolean {
  const config = getConfig();
  return config.llm?.sleep?.enabled === true;
}

/**
 * Get Chat LLM config for interactive chats (succ chat, onboarding).
 * Reads from llm.chat.*.
 */
export function getChatLLMConfig(): LLMRuntimeConfig {
  const taskCfg = getLLMTaskConfig('chat');

  return {
    backend: taskCfg.mode === 'claude' ? 'claude' : 'api',
    model: taskCfg.model,
    endpoint: taskCfg.api_url + '/chat/completions',
    apiKey: taskCfg.api_key,
    maxTokens: taskCfg.max_tokens,
    temperature: taskCfg.temperature,
  };
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Call LLM with the configured backend
 */
export async function callLLM(
  prompt: string,
  options: LLMOptions = {},
  configOverride?: Partial<LLMRuntimeConfig>
): Promise<string> {
  let baseConfig: LLMRuntimeConfig;
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

  // When systemPrompt is provided, prepend it for CLI backends
  const effectivePrompt =
    config.backend === 'claude' && options.systemPrompt
      ? `System: ${options.systemPrompt}\n\n${prompt}`
      : prompt;

  switch (config.backend) {
    case 'claude': {
      if (getClaudeMode() === 'ws') {
        const transport = await ClaudeWSTransport.getInstance();
        return transport.send(effectivePrompt, { model: config.model, timeout });
      }
      return runClaudeCLI(effectivePrompt, config.model, timeout);
    }

    case 'api':
      return callApiLLM(
        prompt,
        config.endpoint!,
        config.model,
        timeout,
        maxTokens,
        temperature,
        config.apiKey,
        options.systemPrompt
      );

    default:
      throw new ConfigError(`Unknown LLM backend: ${config.backend}`);
  }
}

/**
 * Call LLM with fallback chain.
 * Tries configured backend first, then fallback.
 */
export async function callLLMWithFallback(
  prompt: string,
  options: LLMOptions = {},
  preferredBackend?: LLMBackend
): Promise<string> {
  const config = getLLMConfig();
  const backends: LLMBackend[] = ['api', 'claude'];
  const preferred = preferredBackend || config.backend;

  const orderedBackends = [preferred, ...backends.filter((b) => b !== preferred)];

  let lastError: Error | null = null;

  for (const backend of orderedBackends) {
    try {
      return await callLLM(prompt, options, { backend });
    } catch (err) {
      lastError = err as Error;
      logWarn('llm', `Backend '${backend}' failed: ${lastError.message}`);
    }
  }

  throw lastError || new Error('All LLM backends failed');
}

/**
 * Call LLM with multi-turn chat messages
 */
export async function callLLMChat(
  messages: ChatMessage[],
  options: LLMOptions = {},
  configOverride?: Partial<LLMRuntimeConfig>
): Promise<string> {
  let baseConfig: LLMRuntimeConfig;
  if (options.useChatLLM !== false) {
    baseConfig = getChatLLMConfig();
  } else if (options.useSleepAgent) {
    const sleepAgentConfig = getSleepAgentConfig();
    baseConfig = sleepAgentConfig || getLLMConfig();
  } else {
    baseConfig = getLLMConfig();
  }

  const config = { ...baseConfig, ...configOverride };
  const timeout = options.timeout || 60000;
  const maxTokens = options.maxTokens || config.maxTokens || 4000;
  const temperature = options.temperature ?? config.temperature ?? 0.7;

  switch (config.backend) {
    case 'claude': {
      if (getClaudeMode() === 'ws') {
        const transport = await ClaudeWSTransport.getInstance();
        return transport.sendChat(messages, { model: config.model, timeout });
      }
      // Process mode — CLI doesn't support multi-turn, concatenate messages
      const prompt = messages
        .map((m) =>
          m.role === 'system'
            ? `System: ${m.content}`
            : m.role === 'user'
              ? `User: ${m.content}`
              : `Assistant: ${m.content}`
        )
        .join('\n\n');
      return runClaudeCLI(prompt, config.model, timeout);
    }

    case 'api':
      return callApiLLMChat(
        messages,
        config.endpoint!,
        config.model,
        timeout,
        maxTokens,
        temperature,
        config.apiKey
      );

    default:
      throw new ConfigError(`Unknown LLM backend: ${config.backend}`);
  }
}

// ============================================================================
// Backend Implementations
// ============================================================================

// ---- Shared Claude CLI helpers ----

export interface ClaudeCLIOptions {
  model?: string; // default: 'haiku'
  tools?: string; // e.g. '' to disable tools; omit for default
  timeout?: number; // ms, default: 60000
}

function buildClaudeArgs(options?: ClaudeCLIOptions): string[] {
  const model = options?.model ?? 'haiku';
  const args = ['-p', '--no-session-persistence', '--model', model];
  if (options?.tools !== undefined) {
    args.push('--tools', options.tools);
  }
  return args;
}

// Remove CLAUDECODE to allow spawning inside a Claude Code session
const CLAUDE_SPAWN_ENV = (() => {
  const env: Record<string, string | undefined> = { ...process.env, SUCC_SERVICE_SESSION: '1' };
  delete env.CLAUDECODE;
  return env;
})();

const CLAUDE_SPAWN_OPTIONS = {
  env: CLAUDE_SPAWN_ENV,
  windowsHide: true,
} as const;

/**
 * Spawn Claude CLI asynchronously and return stdout.
 * When transport is 'ws', routes through persistent WebSocket transport.
 */
export async function spawnClaudeCLI(prompt: string, options?: ClaudeCLIOptions): Promise<string> {
  if (getClaudeMode() === 'ws') {
    const transport = await ClaudeWSTransport.getInstance();
    return transport.send(prompt, {
      model: options?.model,
      timeout: options?.timeout,
    });
  }

  const timeout = options?.timeout ?? 60000;
  const args = buildClaudeArgs(options);

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...CLAUDE_SPAWN_OPTIONS,
    });

    if (proc.pid) processRegistry.register(proc.pid, 'claude-cli');

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
      reject(new NetworkError('Claude CLI timeout'));
    }, timeout);

    proc.on('close', (code: number) => {
      clearTimeout(timer);
      if (proc.pid) processRegistry.unregister(proc.pid);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new NetworkError(`Claude CLI failed: ${stderr || 'unknown error'}`));
      }
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      if (proc.pid) processRegistry.unregister(proc.pid);
      reject(err);
    });
  });
}

/**
 * Spawn Claude CLI synchronously and return stdout.
 */
export function spawnClaudeCLISync(prompt: string, options?: ClaudeCLIOptions): string {
  const timeout = options?.timeout ?? 60000;
  const args = buildClaudeArgs(options);

  const result = crossSpawnSync('claude', args, {
    input: prompt,
    encoding: 'utf-8',
    timeout,
    ...CLAUDE_SPAWN_OPTIONS,
  });

  if (result.error) {
    throw new NetworkError(`Claude CLI error: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new NetworkError(`Claude CLI failed: ${result.stderr || 'unknown error'}`);
  }

  return (result.stdout ?? '').trim();
}

/** Internal wrapper used by callLLM() */
function runClaudeCLI(prompt: string, model: string, timeout: number): Promise<string> {
  return spawnClaudeCLI(prompt, { model, timeout });
}

/**
 * Call any OpenAI-compatible API (single prompt)
 */
async function callApiLLM(
  prompt: string,
  endpoint: string,
  model: string,
  timeout: number,
  maxTokens: number,
  temperature: number,
  apiKey?: string,
  systemPrompt?: string
): Promise<string> {
  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: buildApiHeaders(endpoint, apiKey),
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    logError('llm', `API error ${response.status}: ${errorBody}`);
    throw new NetworkError(
      `LLM API error: ${response.status} ${response.statusText}`,
      response.status
    );
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  if (!data.choices || data.choices.length === 0) {
    throw new NetworkError('LLM API returned no choices');
  }

  return data.choices[0].message.content;
}

/**
 * Call any OpenAI-compatible API with multi-turn messages
 */
async function callApiLLMChat(
  messages: ChatMessage[],
  endpoint: string,
  model: string,
  timeout: number,
  maxTokens: number,
  temperature: number,
  apiKey?: string
): Promise<string> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: buildApiHeaders(endpoint, apiKey),
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    logError('llm', `API chat error ${response.status}: ${errorBody}`);
    throw new NetworkError(
      `LLM API error: ${response.status} ${response.statusText}`,
      response.status
    );
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  if (!data.choices || data.choices.length === 0) {
    throw new NetworkError('LLM API returned no choices');
  }

  return data.choices[0].message.content;
}

/**
 * Response from search API with Perplexity-specific fields (citations, search_results)
 */
export interface OpenRouterSearchResponse {
  content: string;
  citations?: string[];
  search_results?: Array<{ title?: string; url: string; snippet?: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  reasoning?: string;
}

/**
 * Call search API (Perplexity Sonar via OpenRouter) and return full response with citations.
 * Uses llm.api_key for authentication.
 */
export async function callOpenRouterSearch(
  messages: ChatMessage[],
  model: string,
  timeout: number,
  maxTokens: number,
  temperature: number
): Promise<OpenRouterSearchResponse> {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    throw new ConfigError(
      'OpenRouter API key not set. Configure via OPENROUTER_API_KEY env, web_search.api_key, or llm.api_key (sk-or-... format).'
    );
  }

  const endpoint = 'https://openrouter.ai/api/v1/chat/completions';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: buildApiHeaders(endpoint, apiKey),
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    logError('llm', `Search API error ${response.status}: ${errorBody}`);
    throw new NetworkError(
      `Search API error: ${response.status} ${response.statusText}`,
      response.status
    );
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string; reasoning?: string } }>;
    citations?: string[];
    search_results?: Array<{ title?: string; url: string; snippet?: string }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  if (!data.choices || data.choices.length === 0) {
    throw new NetworkError('Search API returned no choices');
  }

  return {
    content: data.choices[0].message.content,
    citations: data.citations,
    search_results: data.search_results,
    usage: data.usage,
    reasoning: data.choices[0].message.reasoning,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if API endpoint is available
 */
export async function isLocalLLMAvailable(): Promise<boolean> {
  const apiUrl = getApiUrl();
  try {
    const response = await fetch(apiUrl + '/models', {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Check if an API key is configured (for web search, etc.)
 */
export function isApiConfigured(): boolean {
  return !!getOpenRouterApiKey();
}

/**
 * Get available backends
 */
export async function getAvailableBackends(): Promise<LLMBackend[]> {
  const available: LLMBackend[] = ['claude']; // Always available if Claude Code is installed

  if (await isLocalLLMAvailable()) {
    available.unshift('api'); // Prefer api (local endpoint)
  }

  if (getApiKey()) {
    // If we have an API key but no local endpoint, still add 'api'
    if (!available.includes('api')) {
      available.push('api');
    }
  }

  return available;
}
