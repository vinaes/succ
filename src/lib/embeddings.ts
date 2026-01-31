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

// Lazy-loaded local embedding pipeline
let localPipeline: any = null;

/**
 * Get local embedding pipeline (lazy loaded)
 */
async function getLocalPipeline() {
  if (!localPipeline) {
    // Dynamic import to avoid loading transformers.js if not needed
    const { pipeline } = await import('@huggingface/transformers');
    const config = getConfig();
    console.log(`Loading local embedding model: ${config.embedding_model}...`);
    localPipeline = await pipeline('feature-extraction', config.embedding_model);
    console.log('Model loaded.');
  }
  return localPipeline;
}

/**
 * Get embeddings using local model
 */
async function getLocalEmbeddings(texts: string[]): Promise<number[][]> {
  const pipe = await getLocalPipeline();
  const results: number[][] = [];

  for (const text of texts) {
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    results.push(Array.from(output.data));
  }

  return results;
}

/**
 * Get embeddings from OpenRouter API
 */
async function getOpenRouterEmbeddings(texts: string[]): Promise<number[][]> {
  const config = getConfig();
  if (!config.openrouter_api_key) {
    throw new Error('OpenRouter API key required');
  }

  const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
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
  return data.data.map((d) => d.embedding);
}

/**
 * Get embeddings from custom API (llama.cpp, LM Studio, Ollama, etc.)
 * Expects OpenAI-compatible /v1/embeddings endpoint
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

  const response = await fetch(config.custom_api_url, {
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
  return data.data.map((d) => d.embedding);
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
 * Get embedding for a single text
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const embeddings = await getEmbeddings([text]);
  return embeddings[0];
}

/**
 * Cosine similarity between two vectors
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

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
