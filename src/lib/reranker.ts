/**
 * Cross-encoder reranker for search result post-processing.
 *
 * Uses an ONNX cross-encoder model (ms-marco-MiniLM-L6-v2) to score
 * (query, document) pairs for relevance. Applied after hybrid search
 * (BM25 + vector + RRF) to improve precision.
 *
 * Architecture: singleton session, lazy-loaded on first use, auto-disposed on cleanup.
 */

import * as ort from 'onnxruntime-node';
import { resolveModelPath } from './ort-session.js';
import { detectExecutionProvider } from './ort-provider.js';
import { getConfig } from './config.js';
import { logInfo, logWarn } from './fault-logger.js';
/** Minimal interface for results that can be reranked */
export interface Rerankable {
  content: string;
  similarity: number;
  symbol_name?: string | null;
  signature?: string | null;
}

/** Default cross-encoder model — small, fast, good quality */
const DEFAULT_RERANKER_MODEL = 'cross-encoder/ms-marco-MiniLM-L6-v2';

/** Max sequence length for cross-encoder input (query + doc tokens) */
const MAX_SEQ_LENGTH = 512;

/** Batch size for cross-encoder inference (limits memory usage) */
const RERANKER_BATCH_SIZE = 16;

// Singleton session
let rerankerSession: ort.InferenceSession | null = null;
let rerankerTokenizer: any = null;
let rerankerInitializing: Promise<void> | null = null;
let rerankerInitFailed = false; // Don't retry after initialization failure
let rerankerShuttingDown = false; // Guard against races between init and cleanup

/**
 * Initialize the cross-encoder reranker session.
 * Uses same model resolution + provider detection as embedding pipeline.
 */
async function initReranker(): Promise<void> {
  if (rerankerShuttingDown) throw new Error('Reranker is shutting down');
  if (rerankerSession && rerankerTokenizer) return;
  if (rerankerInitFailed) throw new Error('Reranker initialization previously failed');

  // Prevent concurrent initialization
  if (rerankerInitializing) {
    await rerankerInitializing;
    return;
  }

  rerankerInitializing = (async () => {
    try {
      const config = getConfig();
      const model = config.llm?.reranker?.model ?? DEFAULT_RERANKER_MODEL;

      logInfo('reranker', `Loading cross-encoder model: ${model}`);

      // Load tokenizer
      const { AutoTokenizer } = await import('@huggingface/transformers');
      rerankerTokenizer = await AutoTokenizer.from_pretrained(model);

      // Resolve model path (same cache locations as embeddings)
      const modelPath = await resolveModelPath(model);

      // Create session with GPU fallback
      const providerResult = detectExecutionProvider(process.platform, {
        gpu_enabled: config.gpu_enabled,
        gpu_device: config.gpu_device,
      });
      for (const provider of providerResult.fallbackChain) {
        try {
          rerankerSession = await ort.InferenceSession.create(modelPath, {
            executionProviders: [provider],
            interOpNumThreads: 1,
            intraOpNumThreads: 2,
          });
          logInfo('reranker', `Cross-encoder loaded with provider: ${provider}`);
          return;
        } catch (err) {
          logWarn('reranker', `Provider ${provider} failed, trying next`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      throw new Error(
        `Failed to create reranker session with any provider: ${providerResult.fallbackChain.join(', ')}`
      );
    } catch (error) {
      rerankerSession = null;
      rerankerTokenizer = null;
      rerankerInitFailed = true;
      throw error;
    } finally {
      rerankerInitializing = null;
    }
  })();

  await rerankerInitializing;
}

/**
 * Score a batch of (query, document) pairs using the cross-encoder.
 * Returns relevance scores (higher = more relevant).
 *
 * Cross-encoders output logits; we apply sigmoid to get 0-1 scores.
 */
async function scorePairs(query: string, documents: string[]): Promise<number[]> {
  if (documents.length === 0) return [];

  await initReranker();
  if (!rerankerSession || !rerankerTokenizer) {
    throw new Error('Reranker not initialized');
  }

  const allScores: number[] = [];

  // Process in batches to limit memory usage
  for (let i = 0; i < documents.length; i += RERANKER_BATCH_SIZE) {
    const batch = documents.slice(i, i + RERANKER_BATCH_SIZE);
    const batchScores = await scoreBatch(query, batch);
    allScores.push(...batchScores);
  }

  return allScores;
}

/**
 * Score a single batch of (query, document) pairs.
 */
async function scoreBatch(query: string, documents: string[]): Promise<number[]> {
  // Cross-encoders take (query, document) as a text pair input.
  // The tokenizer encodes them as [CLS] query [SEP] document [SEP].
  const pairs = documents.map((doc) => [query, doc]);

  // Tokenize all pairs
  const encoded = rerankerTokenizer!(pairs, {
    padding: true,
    truncation: true,
    max_length: MAX_SEQ_LENGTH,
    return_tensors: false,
  });

  const batchSize = documents.length;
  const seqLen = encoded.input_ids.dims ? encoded.input_ids.dims[1] : encoded.input_ids[0].length;

  // Flatten for ORT tensors
  const flatInputIds = encoded.input_ids.dims
    ? encoded.input_ids.data
    : new BigInt64Array(encoded.input_ids.flat().map((v: number) => BigInt(v)));
  const flatAttentionMask = encoded.attention_mask.dims
    ? encoded.attention_mask.data
    : new BigInt64Array(encoded.attention_mask.flat().map((v: number) => BigInt(v)));

  const inputIdsTensor = new ort.Tensor('int64', toBigInt64(flatInputIds, batchSize * seqLen), [
    batchSize,
    seqLen,
  ]);
  const attentionMaskTensor = new ort.Tensor(
    'int64',
    toBigInt64(flatAttentionMask, batchSize * seqLen),
    [batchSize, seqLen]
  );

  const feeds: Record<string, ort.Tensor> = {
    input_ids: inputIdsTensor,
    attention_mask: attentionMaskTensor,
  };

  // Some models need token_type_ids (0 for query, 1 for document)
  if (rerankerSession!.inputNames.includes('token_type_ids')) {
    let tokenTypeData: BigInt64Array;
    if (encoded.token_type_ids) {
      const flatTokenTypes = encoded.token_type_ids.dims
        ? encoded.token_type_ids.data
        : new BigInt64Array(encoded.token_type_ids.flat().map((v: number) => BigInt(v)));
      tokenTypeData = toBigInt64(flatTokenTypes, batchSize * seqLen);
    } else {
      tokenTypeData = new BigInt64Array(batchSize * seqLen);
    }
    feeds.token_type_ids = new ort.Tensor('int64', tokenTypeData, [batchSize, seqLen]);
  }

  // Run inference
  const results = await rerankerSession!.run(feeds);

  // Cross-encoder outputs logits (usually shape [batch, 1] or [batch])
  const outputKey = rerankerSession!.outputNames[0];
  const output = results[outputKey];
  const logits = output.data as Float32Array;

  // Apply sigmoid to convert logits to 0-1 relevance scores
  const scores: number[] = [];
  for (let i = 0; i < batchSize; i++) {
    const logit = logits[i];
    scores.push(sigmoid(logit));
  }

  return scores;
}

/**
 * Rerank hybrid search results using cross-encoder scoring.
 *
 * Takes existing search results (from BM25 + vector + RRF) and re-scores
 * them using a cross-encoder model that sees both query and document together.
 *
 * @param query - Original search query
 * @param results - Hybrid search results to rerank
 * @param topK - Number of top results to return (default: results.length)
 * @returns Reranked results with updated similarity scores
 */
export async function rerank<T extends Rerankable>(
  query: string,
  results: T[],
  topK?: number
): Promise<T[]> {
  if (results.length === 0) return [];

  // Normalize topK: must be a positive integer, clamped to results length.
  const safeTopK =
    topK !== undefined && Number.isFinite(topK) && topK > 0
      ? Math.min(Math.floor(topK), results.length)
      : undefined;

  // Helper: apply topK slice consistently on every return path.
  const applyTopK = (arr: T[]): T[] => (safeTopK !== undefined ? arr.slice(0, safeTopK) : arr);

  if (results.length === 1) return applyTopK(results);

  const config = getConfig();
  const rerankerConfig = config.llm?.reranker;

  // Check if reranking is enabled
  if (rerankerConfig?.enabled === false) {
    return applyTopK(results);
  }

  // Don't rerank if too few results (overhead not worth it)
  const minResults = rerankerConfig?.min_results ?? 3;
  if (results.length < minResults) {
    return applyTopK(results);
  }

  try {
    // Prepare document texts for scoring
    // Truncate long documents to save compute
    const rawMaxDocChars = rerankerConfig?.max_doc_chars ?? 1000;
    const maxDocChars =
      Number.isFinite(rawMaxDocChars) && rawMaxDocChars > 0 ? Math.floor(rawMaxDocChars) : 1000;
    const docTexts = results.map((r) => {
      const text = r.content.slice(0, maxDocChars);
      // Include symbol metadata for code results
      if (r.symbol_name) {
        return `${r.symbol_name}${r.signature ? ': ' + r.signature : ''}\n${text}`;
      }
      return text;
    });

    // Score all (query, document) pairs
    const scores = await scorePairs(query, docTexts);

    // Combine with original scores:
    // reranker_weight * cross_encoder_score + (1 - reranker_weight) * original_score
    const rawWeight = rerankerConfig?.weight ?? 0.7;
    const weight = Number.isFinite(rawWeight) ? Math.max(0, Math.min(1, rawWeight)) : 0.7;
    const reranked = results.map((result, i) => ({
      ...result,
      _originalSimilarity: result.similarity,
      similarity: weight * scores[i] + (1 - weight) * result.similarity,
    }));

    // Sort by new combined score
    reranked.sort((a, b) => b.similarity - a.similarity);

    // Return top-K
    return applyTopK(reranked);
  } catch (error) {
    // Graceful degradation: return original results if reranker fails
    logWarn(
      'reranker',
      `Cross-encoder reranking failed, returning original results: ${error instanceof Error ? error.message : String(error)}`
    );
    return applyTopK(results);
  }
}

/**
 * Check if the reranker is available and enabled.
 */
export function isRerankerEnabled(): boolean {
  const config = getConfig();
  return config.llm?.reranker?.enabled !== false;
}

/**
 * Cleanup reranker session to free memory.
 *
 * Sets a shutdown guard first, then awaits any in-flight initialization before
 * releasing ONNX resources. This prevents a race where cleanup returns while
 * initReranker() is still allocating the session (which would then leak).
 */
export async function cleanupReranker(): Promise<void> {
  rerankerShuttingDown = true;

  // Wait for any in-flight init to finish before releasing resources.
  if (rerankerInitializing) {
    try {
      await rerankerInitializing;
    } catch {
      // Init may have failed — that's fine, we're cleaning up anyway
      logWarn('reranker', 'Reranker init failed during shutdown — continuing cleanup');
    }
  }

  if (rerankerSession) {
    try {
      await rerankerSession.release();
    } catch (err) {
      logWarn('reranker', err instanceof Error ? err.message : 'Reranker session release failed');
    }
    rerankerSession = null;
  }
  rerankerTokenizer = null;
  rerankerInitializing = null;
  rerankerInitFailed = false;
  rerankerShuttingDown = false;
}

// ============================================================================
// Utilities
// ============================================================================

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function toBigInt64(data: any, expectedLength: number): BigInt64Array {
  if (data instanceof BigInt64Array && data.length === expectedLength) {
    return data;
  }
  const arr = new BigInt64Array(expectedLength);
  for (let i = 0; i < expectedLength && i < data.length; i++) {
    arr[i] = typeof data[i] === 'bigint' ? data[i] : BigInt(Number(data[i]));
  }
  return arr;
}
