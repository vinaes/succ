import { getConfig, getConfigWithOverride } from './config.js';
import { createHash } from 'crypto';
import os from 'os';

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
};

// Default timeout for API requests (30 seconds)
const API_TIMEOUT_MS = 30000;

import { EmbeddingPool } from './embedding-pool.js';

// Lazy-loaded local embedding pipeline
let localPipeline: any = null;

// Worker pool for parallel local embeddings (lazy init)
let embeddingPool: EmbeddingPool | null = null;
let poolInitFailed = false; // Don't retry if pool init failed

/**
 * Cleanup embedding pipeline and worker pool to free memory
 */
export function cleanupEmbeddings(): void {
  if (localPipeline) {
    localPipeline = null;
    embeddingCache.clear();
    // Hint GC if available
    if (global.gc) {
      global.gc();
    }
  }
  if (embeddingPool) {
    embeddingPool.shutdown().catch(() => {});
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
 * Validate embedding dimension matches expected model dimension
 */
function validateEmbedding(embedding: number[], model: string): void {
  const expectedDim = MODEL_DIMENSIONS[model];
  if (expectedDim && embedding.length !== expectedDim) {
    throw new Error(
      `Embedding dimension mismatch: expected ${expectedDim} for ${model}, got ${embedding.length}`
    );
  }
  // Check for NaN/Infinity
  if (embedding.some((v) => !isFinite(v))) {
    throw new Error('Embedding contains NaN or Infinity values');
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
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// Simple LRU cache for embeddings
const CACHE_MAX_SIZE = 500;
const embeddingCache = new Map<string, number[]>();

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
  if (embeddingCache.size >= CACHE_MAX_SIZE) {
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
        console.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

/**
 * Get local embedding pipeline (lazy loaded)
 * Uses CPU by default. GPU can be enabled via config (webgpu only for now).
 */
async function getLocalPipeline() {
  if (!localPipeline) {
    const { pipeline } = await import('@huggingface/transformers');
    const config = getConfigWithOverride();

    // Use WebGPU only if explicitly requested in config
    let device: 'webgpu' | 'cpu' = 'cpu';
    if (config.gpu_enabled && config.gpu_device === 'webgpu') {
      try {
        if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
          const gpu = (navigator as any).gpu;
          if (gpu) {
            const adapter = await gpu.requestAdapter();
            if (adapter) {
              device = 'webgpu';
            }
          }
        }
      } catch {
        // WebGPU not available
      }
    }

    gpuBackend = device;
    console.log(`Loading local embedding model: ${config.embedding_model} (${device.toUpperCase()})...`);

    try {
      localPipeline = await pipeline('feature-extraction', config.embedding_model, {
        device,
        dtype: device === 'webgpu' ? 'fp16' : 'fp32',
      });
      console.log('Model loaded.');
    } catch (error: unknown) {
      // If WebGPU failed, retry with CPU
      if (device === 'webgpu') {
        console.log('WebGPU initialization failed, falling back to CPU...');
        gpuBackend = 'cpu';
        try {
          localPipeline = await pipeline('feature-extraction', config.embedding_model, {
            device: 'cpu',
            dtype: 'fp32',
          });
          console.log('Model loaded (CPU fallback).');
          return localPipeline;
        } catch (cpuError: unknown) {
          const message = cpuError instanceof Error ? cpuError.message : String(cpuError);
          throw new Error(
            `Failed to load embedding model '${config.embedding_model}'. ` +
              `This may be due to network issues, disk space, or invalid model name. ` +
              `Error: ${message}`
          );
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load embedding model '${config.embedding_model}'. ` +
          `This may be due to network issues, disk space, or invalid model name. ` +
          `Error: ${message}`
      );
    }
  }
  return localPipeline;
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
  if (texts.length < 32) return null;

  try {
    if (!embeddingPool) {
      const poolSize = config.embedding_worker_pool_size ?? Math.min(os.cpus().length - 1, 4);
      embeddingPool = new EmbeddingPool({ poolSize, model: config.embedding_model });
      console.log(`Initializing embedding worker pool (${embeddingPool.size} workers)...`);
      await embeddingPool.init();
      console.log('Worker pool ready.');
    }

    return await embeddingPool.getEmbeddings(texts);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Worker pool failed, falling back to single-thread: ${msg}`);
    poolInitFailed = true;
    if (embeddingPool) {
      embeddingPool.shutdown().catch(() => {});
      embeddingPool = null;
    }
    return null;
  }
}

/**
 * Get embeddings using local model (batch optimized)
 * For large batches (32+), uses worker thread pool for true CPU parallelism.
 * Falls back to single-thread processing for small batches or if pool unavailable.
 */
async function getLocalEmbeddings(texts: string[]): Promise<number[][]> {
  const config = getConfigWithOverride();

  // Try worker pool for large batches
  const poolResult = await tryPoolEmbeddings(texts, config);
  if (poolResult) {
    for (const embedding of poolResult) {
      validateEmbedding(embedding, config.embedding_model);
    }
    return poolResult;
  }

  const pipe = await getLocalPipeline();

  // For single text, process directly
  if (texts.length === 1) {
    const output = await pipe(texts[0], { pooling: 'mean', normalize: true });
    const embedding = Array.from(output.data as Float32Array);
    validateEmbedding(embedding, config.embedding_model);
    return [embedding];
  }

  // Batch processing - transformers.js supports arrays natively
  // Process in smaller batches to avoid memory issues
  // Use concurrent batch processing for better performance
  const BATCH_SIZE = config.embedding_local_batch_size ?? 16;
  const CONCURRENT_BATCHES = config.embedding_local_concurrency ?? 4;

  // Split texts into batches
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    batches.push(texts.slice(i, i + BATCH_SIZE));
  }

  // Process batch helper
  const processBatch = async (batch: string[], startIndex: number): Promise<number[][]> => {
    const batchResults = await Promise.allSettled(
      batch.map(async (text) => {
        const output = await pipe(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data as Float32Array);
      })
    );

    return batchResults.map((result, idx) => {
      if (result.status === 'rejected') {
        console.warn(`Failed to embed text at index ${startIndex + idx}: ${result.reason}`);
        const expectedDim = getModelDimension(config.embedding_model) || 384;
        return new Array(expectedDim).fill(0);
      }
      return result.value;
    });
  };

  // Process batches concurrently
  const results: number[][] = [];
  for (let i = 0; i < batches.length; i += CONCURRENT_BATCHES) {
    const concurrentBatches = batches.slice(i, i + CONCURRENT_BATCHES);
    const startIndices = concurrentBatches.map((_, idx) => (i + idx) * BATCH_SIZE);

    const batchResults = await Promise.all(
      concurrentBatches.map((batch, idx) => processBatch(batch, startIndices[idx]))
    );

    for (const batchResult of batchResults) {
      results.push(...batchResult);
    }
  }

  // Validate all embeddings (not just first)
  for (const embedding of results) {
    validateEmbedding(embedding, config.embedding_model);
  }

  return results;
}

/**
 * Get embeddings from OpenRouter API (with retry and timeout)
 */
async function getOpenRouterEmbeddings(texts: string[]): Promise<number[][]> {
  const config = getConfigWithOverride();
  if (!config.openrouter_api_key) {
    throw new Error('OpenRouter API key required');
  }

  return withRetry(async () => {
    const response = await fetchWithTimeout('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openrouter_api_key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/cpz/succ',
        'X-Title': 'succ',
      },
      body: JSON.stringify({
        model: config.embedding_model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as EmbeddingResponse;
    const embeddings = data.data.map((d) => d.embedding);

    // Validate all embeddings
    for (const embedding of embeddings) {
      validateEmbedding(embedding, config.embedding_model);
    }

    return embeddings;
  });
}

/**
 * Check if custom API (llama.cpp, LM Studio, Ollama) is available
 * Returns true if server responds, false otherwise
 */
export async function checkCustomApiHealth(): Promise<{ ok: boolean; error?: string }> {
  const config = getConfigWithOverride();
  if (!config.embedding_api_url) {
    return { ok: false, error: 'Custom API URL not configured' };
  }

  try {
    // Try to get the base URL (without /embeddings) for health check
    const baseUrl = config.embedding_api_url.replace(/\/embeddings\/?$/, '');
    const healthUrl = `${baseUrl}/health`;

    const response = await fetchWithTimeout(healthUrl, { method: 'GET' }, 5000);

    if (response.ok) {
      return { ok: true };
    }

    // Some servers don't have /health, try a minimal embedding request
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.embedding_api_key) {
      headers['Authorization'] = `Bearer ${config.embedding_api_key}`;
    }

    const testResponse = await fetchWithTimeout(
      config.embedding_api_url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.embedding_model,
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
 * Get embeddings from custom API (llama.cpp, LM Studio, Ollama, etc.)
 * Expects OpenAI-compatible /v1/embeddings endpoint (with retry and timeout)
 * Supports larger batch sizes for llama.cpp (default 32, configurable)
 */
async function getCustomApiEmbeddings(texts: string[]): Promise<number[][]> {
  const config = getConfigWithOverride();
  if (!config.embedding_api_url) {
    throw new Error('Custom API URL required');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Add API key if provided
  if (config.embedding_api_key) {
    headers['Authorization'] = `Bearer ${config.embedding_api_key}`;
  }

  // Use larger batch size for custom API (llama.cpp handles 32+ well)
  const batchSize = config.embedding_batch_size || 32;
  const expectedDimensions = config.embedding_dimensions;

  // Process in batches
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    const batchEmbeddings = await withRetry(async () => {
      const response = await fetchWithTimeout(config.embedding_api_url!, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.embedding_model,
          input: batch,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Custom API error: ${response.status} - ${error}`);
      }

      const data = (await response.json()) as EmbeddingResponse;
      return data.data.map((d) => d.embedding);
    });

    // Validate embeddings
    for (const embedding of batchEmbeddings) {
      if (embedding.some((v) => !isFinite(v))) {
        throw new Error('Embedding contains NaN or Infinity values');
      }
      // Validate dimensions if configured
      if (expectedDimensions && embedding.length !== expectedDimensions) {
        throw new Error(
          `Embedding dimension mismatch: expected ${expectedDimensions}, got ${embedding.length}`
        );
      }
    }

    results.push(...batchEmbeddings);
  }

  return results;
}

/**
 * Get embeddings (auto-selects based on config mode)
 * Priority: local (default) → openrouter → custom
 * Uses configOverride if set (for benchmarking)
 */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const config = getConfigWithOverride();

  switch (config.embedding_mode) {
    case 'local':
      return getLocalEmbeddings(texts);
    case 'openrouter':
      return getOpenRouterEmbeddings(texts);
    case 'custom':
      return getCustomApiEmbeddings(texts);
    default:
      return getLocalEmbeddings(texts);
  }
}

/**
 * Get embedding for a single text (with caching)
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const config = getConfigWithOverride();
  const cacheKey = getCacheKey(text, config.embedding_mode, config.embedding_model);

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
  const config = getConfigWithOverride();
  return {
    mode: config.embedding_mode,
    model: config.embedding_model,
    dimensions: getModelDimension(config.embedding_model),
  };
}

/**
 * Cosine similarity between two vectors.
 * Returns 0 for zero-vectors to avoid division by zero.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have same length');
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
