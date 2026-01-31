import { getConfig } from './config.js';

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

// Lazy-loaded local embedding pipeline
let localPipeline: any = null;

/**
 * Cleanup embedding pipeline to free memory
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

function getCacheKey(text: string, mode: string, model: string): string {
  return `${mode}:${model}:${text}`;
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
 */
async function getLocalPipeline() {
  if (!localPipeline) {
    // Dynamic import to avoid loading transformers.js if not needed
    const { pipeline } = await import('@huggingface/transformers');
    const config = getConfig();
    console.log(`Loading local embedding model: ${config.embedding_model}...`);

    try {
      localPipeline = await pipeline('feature-extraction', config.embedding_model);
      console.log('Model loaded.');
    } catch (error: unknown) {
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
 * Get embeddings using local model (batch optimized)
 * Processes texts in batches for 3-5x speedup over sequential processing
 */
async function getLocalEmbeddings(texts: string[]): Promise<number[][]> {
  const pipe = await getLocalPipeline();

  // For single text, process directly
  if (texts.length === 1) {
    const output = await pipe(texts[0], { pooling: 'mean', normalize: true });
    return [Array.from(output.data as Float32Array)];
  }

  // Batch processing - transformers.js supports arrays natively
  // Process in smaller batches to avoid memory issues
  const BATCH_SIZE = 16;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    // Process batch in parallel using Promise.all
    const batchResults = await Promise.all(
      batch.map(async (text) => {
        const output = await pipe(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data as Float32Array);
      })
    );

    results.push(...batchResults);
  }

  return results;
}

/**
 * Get embeddings from OpenRouter API (with retry and timeout)
 */
async function getOpenRouterEmbeddings(texts: string[]): Promise<number[][]> {
  const config = getConfig();
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

    // Validate first embedding
    if (embeddings.length > 0) {
      validateEmbedding(embeddings[0], config.embedding_model);
    }

    return embeddings;
  });
}

/**
 * Get embeddings from custom API (llama.cpp, LM Studio, Ollama, etc.)
 * Expects OpenAI-compatible /v1/embeddings endpoint (with retry and timeout)
 */
async function getCustomApiEmbeddings(texts: string[]): Promise<number[][]> {
  const config = getConfig();
  if (!config.custom_api_url) {
    throw new Error('Custom API URL required');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Add API key if provided
  if (config.custom_api_key) {
    headers['Authorization'] = `Bearer ${config.custom_api_key}`;
  }

  return withRetry(async () => {
    const response = await fetchWithTimeout(config.custom_api_url!, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.embedding_model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Custom API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as EmbeddingResponse;
    const embeddings = data.data.map((d) => d.embedding);

    // Validate first embedding (custom models may have unknown dimensions)
    if (embeddings.length > 0 && embeddings[0].some((v) => !isFinite(v))) {
      throw new Error('Embedding contains NaN or Infinity values');
    }

    return embeddings;
  });
}

/**
 * Get embeddings (auto-selects based on config mode)
 * Priority: local (default) → openrouter → custom
 */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const config = getConfig();

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
  const config = getConfig();
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
