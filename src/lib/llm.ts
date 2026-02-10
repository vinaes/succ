/**
 * Unified LLM Backend Module
 *
 * Provides a consistent interface for calling LLMs across succ.
 * Supports three backends:
 * - claude: Claude Code CLI (requires Claude Code subscription)
 *   - process mode (default): spawns a new CLI process per call
 *   - ws mode: persistent WebSocket connection via --sdk-url (no process-per-call overhead)
 * - local: Ollama or any OpenAI-compatible local server
 * - openrouter: OpenRouter API (requires OPENROUTER_API_KEY)
 *
 * Default backend is 'local' to avoid ToS issues with Claude CLI automation.
 */

import spawn from 'cross-spawn';
// cross-spawn exposes .sync at runtime but not in types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const crossSpawnSync = (spawn as any).sync as (...args: any[]) => any;
import { getConfig } from './config.js';
import { ClaudeWSTransport } from './claude-ws-transport.js';

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
  /** Use chat_llm config (for interactive chats like succ chat, onboarding) */
  useChatLLM?: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
// Claude Mode (process vs ws)
// ============================================================================

/**
 * Get Claude transport mode from config.
 * 'process' = spawn per call (default), 'ws' = persistent WebSocket.
 */
export function getClaudeMode(): 'process' | 'ws' {
  const config = getConfig();
  return (config.llm?.claude_mode as 'process' | 'ws') || 'process';
}

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

/**
 * Default Chat LLM config - Claude CLI with Sonnet
 * Used for interactive chats (succ chat, onboarding)
 */
const DEFAULT_CHAT_LLM_CONFIG: LLMConfig = {
  backend: 'claude',
  model: 'sonnet',
  maxTokens: 4000,
  temperature: 0.7,
};

/**
 * Get Chat LLM config for interactive chats (succ chat, onboarding)
 * Default: Claude CLI with Sonnet (best quality for interactive use)
 * Can be overridden via chat_llm config
 */
export function getChatLLMConfig(): LLMConfig {
  const config = getConfig();
  const chatLlm = config.chat_llm;

  // If no chat_llm config, use Claude CLI with Sonnet as default
  if (!chatLlm?.backend) {
    return DEFAULT_CHAT_LLM_CONFIG;
  }

  const baseLlmConfig = getLLMConfig();

  return {
    backend: (chatLlm.backend as LLMBackend) || DEFAULT_CHAT_LLM_CONFIG.backend,
    model: chatLlm.model || DEFAULT_CHAT_LLM_CONFIG.model,
    localEndpoint: chatLlm.local_endpoint || baseLlmConfig.localEndpoint,
    openrouterModel: chatLlm.backend === 'openrouter'
      ? (chatLlm.model || baseLlmConfig.openrouterModel)
      : baseLlmConfig.openrouterModel,
    maxTokens: chatLlm.max_tokens || DEFAULT_CHAT_LLM_CONFIG.maxTokens,
    temperature: chatLlm.temperature ?? DEFAULT_CHAT_LLM_CONFIG.temperature,
  };
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

/**
 * Call LLM with multi-turn chat messages
 * Used for interactive conversations (succ chat, onboarding)
 *
 * @param messages - Array of chat messages (system, user, assistant)
 * @param options - Optional overrides for timeout, maxTokens, temperature
 * @param configOverride - Optional config override
 */
export async function callLLMChat(
  messages: ChatMessage[],
  options: LLMOptions = {},
  configOverride?: Partial<LLMConfig>
): Promise<string> {
  // Use chat LLM config by default for chat calls
  let baseConfig: LLMConfig;
  if (options.useChatLLM !== false) {
    baseConfig = getChatLLMConfig();
  } else if (options.useSleepAgent) {
    const sleepAgentConfig = getSleepAgentConfig();
    baseConfig = sleepAgentConfig || getLLMConfig();
  } else {
    baseConfig = getLLMConfig();
  }

  const config = { ...baseConfig, ...configOverride };
  const timeout = options.timeout || 60000; // Longer timeout for chat
  const maxTokens = options.maxTokens || config.maxTokens || 4000;
  const temperature = options.temperature ?? config.temperature ?? 0.7;

  switch (config.backend) {
    case 'claude':
      if (getClaudeMode() === 'ws') {
        // WebSocket mode — native multi-turn, no message concatenation
        const transport = await ClaudeWSTransport.getInstance();
        return transport.sendChat(messages, { model: config.model, timeout });
      }
      // Process mode — CLI doesn't support multi-turn, concatenate messages
      const prompt = messages
        .map((m) => (m.role === 'system' ? `System: ${m.content}` : m.role === 'user' ? `User: ${m.content}` : `Assistant: ${m.content}`))
        .join('\n\n');
      return runClaudeCLI(prompt, config.model, timeout);

    case 'local':
      return callLocalLLMChat(messages, config.localEndpoint!, config.model, timeout, maxTokens, temperature);

    case 'openrouter':
      return callOpenRouterChat(messages, config.openrouterModel!, timeout, maxTokens, temperature);

    default:
      throw new Error(`Unknown LLM backend: ${config.backend}`);
  }
}

// ============================================================================
// Backend Implementations
// ============================================================================

// ---- Shared Claude CLI helpers ----

export interface ClaudeCLIOptions {
  model?: string;    // default: 'haiku'
  tools?: string;    // e.g. '' to disable tools; omit for default
  timeout?: number;  // ms, default: 60000
}

function buildClaudeArgs(options?: ClaudeCLIOptions): string[] {
  const model = options?.model ?? 'haiku';
  const args = ['-p', '--no-session-persistence', '--model', model];
  if (options?.tools !== undefined) {
    args.push('--tools', options.tools);
  }
  return args;
}

const CLAUDE_SPAWN_OPTIONS = {
  env: { ...process.env, SUCC_SERVICE_SESSION: '1' },
  windowsHide: true,
} as const;

/**
 * Spawn Claude CLI asynchronously and return stdout.
 * Single source of truth for all async Claude CLI calls.
 * When claude_mode is 'ws', routes through persistent WebSocket transport.
 */
export async function spawnClaudeCLI(prompt: string, options?: ClaudeCLIOptions): Promise<string> {
  // WebSocket mode — route through persistent connection
  if (getClaudeMode() === 'ws') {
    const transport = await ClaudeWSTransport.getInstance();
    return transport.send(prompt, {
      model: options?.model,
      timeout: options?.timeout,
    });
  }

  // Process mode — spawn per call (default)
  const timeout = options?.timeout ?? 60000;
  const args = buildClaudeArgs(options);

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...CLAUDE_SPAWN_OPTIONS,
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
 * Spawn Claude CLI synchronously and return stdout.
 * Single source of truth for all sync Claude CLI calls.
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
    throw new Error(`Claude CLI error: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Claude CLI failed: ${result.stderr || 'unknown error'}`);
  }

  return (result.stdout ?? '').trim();
}

/** Internal wrapper used by callLLM() */
function runClaudeCLI(prompt: string, model: string, timeout: number): Promise<string> {
  return spawnClaudeCLI(prompt, { model, timeout });
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

/**
 * Call local LLM with multi-turn messages (Ollama or OpenAI-compatible)
 */
async function callLocalLLMChat(
  messages: ChatMessage[],
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
      messages,
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
 * Call OpenRouter API with multi-turn messages
 */
async function callOpenRouterChat(
  messages: ChatMessage[],
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
      messages,
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

/**
 * Response from OpenRouter with Perplexity-specific fields (citations, search_results)
 */
export interface OpenRouterSearchResponse {
  content: string;
  citations?: string[];
  search_results?: Array<{ title?: string; url: string; snippet?: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  reasoning?: string;
}

/**
 * Call OpenRouter search models (Perplexity Sonar) and return full response with citations.
 */
export async function callOpenRouterSearch(
  messages: ChatMessage[],
  model: string,
  timeout: number,
  maxTokens: number,
  temperature: number,
): Promise<OpenRouterSearchResponse> {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not set. Configure via environment variable or succ_config_set.');
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
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[llm] OpenRouter search error: ${errorBody}`);
    throw new Error(`OpenRouter error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string; reasoning?: string } }>;
    citations?: string[];
    search_results?: Array<{ title?: string; url: string; snippet?: string }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  if (!data.choices || data.choices.length === 0) {
    throw new Error('OpenRouter returned no choices');
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
export function getOpenRouterApiKey(): string | undefined {
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
