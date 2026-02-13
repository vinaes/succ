import { getConfig, getConfigWithOverride, getLLMTaskConfig, LOCAL_MODEL } from './config.js';
import { createHash } from 'crypto';
import { logWarn, logInfo } from './fault-logger.js';
import os from 'os';
import { NativeOrtSession } from './ort-session.js';
import { detectExecutionProvider } from './ort-provider.js';
import { NetworkError, ValidationError } from './errors.js';

// Track which GPU backend is being used
let gpuBackend: string | null = null;

export interface EmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
  usage?: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

// Known model dimensions for validation
const MODEL_DIMENSIONS: Record<string, number> = {
  'Xenova/all-MiniLM-L6-v2': 384,
  'Xenova/bge-small-en-v1.5': 384,
  'Xenova/bge-base-en-v1.5': 768,
  'Xenova/bge-large-en-v1.5': 1024,
  'Xenova/multilingual-e5-large': 1024,
  'openai/text-embedding-3-small': 1536,
  'openai/text-embedding-3-large': 3072,
  'openai/text-embedding-ada-002': 1536,
  'qwen/qwen3-embedding-0.6b': 1024,
  'qwen/qwen3-embedding-4b': 2560,
  'qwen/qwen3-embedding-8b': 4096,
  'baai/bge-m3': 1024,
  'mistralai/mistral-embed-2312': 1024,
  'mistralai/codestral-embed-2505': 3072,
  'google/gemini-embedding-001': 3072,
};

// Default timeout for API requests (30 seconds)
const API_TIMEOUT_MS = 30000;

import { EmbeddingPool } from './embedding-pool.js';

// Lazy-loaded native ORT session (replaces transformers.js WASM pipeline)
let nativeSession: NativeOrtSession | null = null;

// Worker pool for parallel local embeddings (lazy init)
let embeddingPool: EmbeddingPool | null = null;
let poolInitFailed = false; // Don't retry if pool init failed

/**
 * Cleanup embedding session and worker pool to free memory
 */
export function cleanupEmbeddings(): void {
  if (nativeSession) {
    nativeSession.dispose().catch(err => logWarn('embeddings', err instanceof Error ? err.message : 'Session dispose failed'));
    nativeSession = null;
    embeddingCache.clear();
    // Hint GC if available
    if (global.gc) {
      global.gc();
    }
  }
  if (embeddingPool) {
    embeddingPool.shutdown().catch(err => logWarn('embeddings', err instanceof Error ? err.message : 'Pool shutdown failed'));
    embeddingPool = null;
  }
}

/**
 * Get expected dimension for a model (or undefined if unknown)
 */
export function getModelDimension(model: string): number | undefined {
  return MODEL_DIMENSIONS[model];
}

/**
 * Validate embedding dimension matches expected model dimension.
 * If configDimensions is set (MRL override), use that instead of model native dims.
 */
function validateEmbedding(embedding: number[], model: string, configDimensions?: number): void {
  const expectedDim = configDimensions ?? MODEL_DIMENSIONS[model];
  if (expectedDim && embedding.length !== expectedDim) {
    throw new ValidationError(
      `Embedding dimension mismatch: expected ${expectedDim} for ${model}, got ${embedding.length}`
    );
  }
  // Check for NaN/Infinity
  if (embedding.some((v) => !isFinite(v))) {
    throw new ValidationError('Embedding contains NaN or Infinity values');
  }
}

/**
 * Fetch with timeout
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = API_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new NetworkError(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// Simple LRU cache for embeddings (size configurable via embedding_cache_size)
let cacheMaxSize: number | null = null;
const embeddingCache = new Map<string, number[]>();

function getCacheMaxSize(): number {
  if (cacheMaxSize === null) {
    cacheMaxSize = getConfig().embedding_cache_size ?? 500;
  }
  return cacheMaxSize;
}

/**
 * Generate a cache key using full SHA-256 hash to prevent collisions
 */
function getCacheKey(text: string, mode: string, model: string): string {
  const textHash = createHash('sha256').update(text).digest('hex');
  return `${mode}:${model}:${textHash}`;
}

function cacheGet(key: string): number[] | undefined {
  const value = embeddingCache.get(key);
  if (value) {
    // Move to end (most recently used)
    embeddingCache.delete(key);
    embeddingCache.set(key, value);
  }
  return value;
}

function cacheSet(key: string, value: number[]): void {
  // Evict oldest if at capacity
  if (embeddingCache.size >= getCacheMaxSize()) {
    const firstKey = embeddingCache.keys().next().value;
    if (firstKey) embeddingCache.delete(firstKey);
  }
  embeddingCache.set(key, value);
}

/**
 * Retry wrapper with exponential backoff
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  options: { retries?: number; baseDelay?: number; maxDelay?: number } = {}
): Promise<T> {
  const { retries = 3, baseDelay = 1000, maxDelay = 10000 } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Don't retry on client errors (4xx except 429)
      if (error.message?.includes('API error: 4') && !error.message?.includes('429')) {
        throw error;
      }

      if (attempt < retries) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        logWarn('embeddings', `Retry attempt ${attempt + 1}/${retries} after ${delay}ms delay`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

/**
 * Get the resolved embedding model name.
 * Reads from llm.embeddings.model → LOCAL_MODEL for local mode.
 */
function getEmbeddingModel(): string {
  const taskCfg = getLLMTaskConfig('embeddings');
  return taskCfg.model || LOCAL_MODEL;
}

/**
 * Get native ORT session (lazy loaded)
 * Auto-detects GPU provider per platform: DirectML (Windows), CoreML (macOS arm64),
 * CUDA (Linux), CPU (all). Uses onnxruntime-node for 4-17x speedup over WASM.
 */
async function getNativeSession(): Promise<NativeOrtSession> {
  if (!nativeSession) {
    const config = getConfigWithOverride();
    const embeddingModel = getEmbeddingModel();

    const providerResult = detectExecutionProvider(process.platform, {
      gpu_enabled: config.gpu_enabled,
      gpu_device: config.gpu_device,
      arch: process.arch,
    });

    if (providerResult.warning) {
      logWarn('embeddings', providerResult.warning);
    }

    gpuBackend = providerResult.provider;
    console.log(
      `Loading native ORT session: ${embeddingModel} ` +
      `(${providerResult.provider}, fallback: ${providerResult.fallbackChain.slice(1).join(' → ') || 'none'})...`
    );

    nativeSession = new NativeOrtSession({
      model: embeddingModel,
      providers: providerResult.fallbackChain,
    });

    try {
      await nativeSession.init();
      gpuBackend = nativeSession.provider;
      console.log(`Model loaded (${nativeSession.provider}).`);
    } catch (error: unknown) {
      nativeSession = null;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load embedding model '${embeddingModel}'. ` +
          `This may be due to network issues, disk space, or invalid model name. ` +
          `Error: ${message}`
      );
    }
  }
  return nativeSession;
}

/**
 * Get the currently active backend (webgpu/cpu)
 */
export function getGpuBackend(): string | null {
  return gpuBackend;
}

/**
 * Try to use worker pool for large embedding batches.
 * Returns null if pool is unavailable or disabled.
 */
async function tryPoolEmbeddings(texts: string[], config: any): Promise<number[][] | null> {
  if (poolInitFailed) return null;
  if (config.embedding_worker_pool_enabled === false) return null;
  // Only use pool for batches large enough to benefit from parallelism
  if (texts.length < 8) return null;

  try {
    if (!embeddingPool) {
      const poolSize = config.embedding_worker_pool_size ?? undefined;
      const maxWorkers = config.embedding_worker_pool_max ?? 8;
      embeddingPool = new EmbeddingPool({ poolSize, maxWorkers, model: getEmbeddingModel() });
      console.log(`Initializing embedding worker pool (${embeddingPool.size} workers)...`);
      await embeddingPool.init();
      console.log('Worker pool ready.');
    }

    return await embeddingPool.getEmbeddings(texts);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn('embeddings', `Worker pool failed, falling back to single-threaded: ${msg}`);
    poolInitFailed = true;
    if (embeddingPool) {
      embeddingPool.shutdown().catch(err => logWarn('embeddings', err instanceof Error ? err.message : 'Pool cleanup failed'));
      embeddingPool = null;
    }
    return null;
  }
}

/**
 * Get embeddings using local native ORT model (batch optimized)
 * For large batches (32+), uses worker thread pool for true CPU parallelism.
 * Native ORT workers are single-threaded — pool provides real parallel scaling.
 * Falls back to main session for small batches or if pool unavailable.
 */
async function getLocalEmbeddings(texts: string[]): Promise<number[][]> {
  const config = getConfigWithOverride();

  // Try worker pool for large batches
  const poolResult = await tryPoolEmbeddings(texts, config);
  if (poolResult) {
    for (const embedding of poolResult) {
      validateEmbedding(embedding, getEmbeddingModel());
    }
    return poolResult;
  }

  const session = await getNativeSession();

  // Native ORT session handles batching internally
  const BATCH_SIZE = config.embedding_local_batch_size ?? 64;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const embeddings = await session.embed(batch);
    results.push(...embeddings);
  }

  // Validate all embeddings
  for (const embedding of results) {
    validateEmbedding(embedding, getEmbeddingModel());
  }

  return results;
}

/**
 * Check if embedding API endpoint is available
 * Returns true if server responds, false otherwise
 */
export async function checkApiHealth(): Promise<{ ok: boolean; error?: string }> {
  const taskCfg = getLLMTaskConfig('embeddings');
  const apiUrl = taskCfg.api_url;

  try {
    // Try to get the base URL (without /embeddings) for health check
    const baseUrl = apiUrl.replace(/\/embeddings\/?$/, '');
    const healthUrl = `${baseUrl}/health`;

    const response = await fetchWithTimeout(healthUrl, { method: 'GET' }, 5000);

    if (response.ok) {
      return { ok: true };
    }

    // Some servers don't have /health, try a minimal embedding request
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (taskCfg.api_key) {
      headers['Authorization'] = `Bearer ${taskCfg.api_key}`;
    }
    // Auto-add OpenRouter headers when URL contains openrouter.ai
    if (apiUrl.includes('openrouter.ai')) {
      headers['HTTP-Referer'] = 'https://github.com/vinaes/succ';
      headers['X-Title'] = 'succ';
    }

    const testResponse = await fetchWithTimeout(
      apiUrl,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: taskCfg.model,
          input: ['test'],
        }),
      },
      10000
    );

    if (testResponse.ok) {
      return { ok: true };
    }

    return { ok: false, error: `Server returned ${testResponse.status}` };
  } catch (error: any) {
    return { ok: false, error: error.message || 'Connection failed' };
  }
}


/**
 * Get embeddings from API endpoint (OpenRouter, Ollama, llama.cpp, LM Studio, etc.)
 * Expects OpenAI-compatible /v1/embeddings endpoint (with retry and timeout)
 * Supports batching (default 32, configurable via llm.embeddings.batch_size)
 */
async function getApiEmbeddings(texts: string[]): Promise<number[][]> {
  const taskCfg = getLLMTaskConfig('embeddings');
  const apiUrl = taskCfg.api_url;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Add API key if provided
  if (taskCfg.api_key) {
    headers['Authorization'] = `Bearer ${taskCfg.api_key}`;
  }
  // Auto-add OpenRouter headers when URL contains openrouter.ai
  if (apiUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://github.com/vinaes/succ';
    headers['X-Title'] = 'succ';
  }

  const config = getConfigWithOverride();
  const batchSize = taskCfg.batch_size ?? config.llm?.embeddings?.batch_size ?? 32;
  const expectedDimensions = config.llm?.embeddings?.dimensions;

  // Process in batches
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    const batchEmbeddings = await withRetry(async () => {
      const response = await fetchWithTimeout(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: taskCfg.model,
          input: batch,
          ...(expectedDimensions ? { dimensions: expectedDimensions } : {}),
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new NetworkError(`Embedding API error: ${response.status} - ${error}`, response.status);
      }

      const data = (await response.json()) as EmbeddingResponse;
      return data.data.map((d) => d.embedding);
    });

    // Validate embeddings (configDimensions overrides model native dims for MRL)
    for (const embedding of batchEmbeddings) {
      validateEmbedding(embedding, getEmbeddingModel(), expectedDimensions);
    }

    results.push(...batchEmbeddings);
  }

  return results;
}

/**
 * Get embeddings (auto-selects based on llm.embeddings.mode)
 * Modes: local (ONNX, default) | api (any OpenAI-compatible endpoint)
 * Uses configOverride if set (for benchmarking)
 */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const taskCfg = getLLMTaskConfig('embeddings');

  switch (taskCfg.mode) {
    case 'api':
      return getApiEmbeddings(texts);
    case 'local':
    default:
      return getLocalEmbeddings(texts);
  }
}

/**
 * Get embedding for a single text (with caching)
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const taskCfg = getLLMTaskConfig('embeddings');
  const cacheKey = getCacheKey(text, taskCfg.mode, taskCfg.model);

  // Check cache first
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Compute and cache
  const embeddings = await getEmbeddings([text]);
  const result = embeddings[0];
  cacheSet(cacheKey, result);

  return result;
}

/**
 * Get info about current embedding configuration
 */
export function getEmbeddingInfo(): { mode: string; model: string; dimensions: number | undefined } {
  const taskCfg = getLLMTaskConfig('embeddings');
  const config = getConfigWithOverride();
  return {
    mode: taskCfg.mode,
    model: taskCfg.model,
    dimensions: config.llm?.embeddings?.dimensions ?? getModelDimension(taskCfg.model),
  };
}

/**
 * Cosine similarity between two vectors.
 * Returns 0 for zero-vectors to avoid division by zero.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new ValidationError('Vectors must have same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}
