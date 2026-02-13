/**
 * Native ONNX Runtime session for embedding generation.
 *
 * Uses onnxruntime-node directly instead of @huggingface/transformers WASM backend.
 * Supports DirectML (Windows), CoreML (macOS), CUDA (Linux), CPU (all).
 *
 * Tokenization still uses @huggingface/transformers AutoTokenizer.
 */

import * as ort from 'onnxruntime-node';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { DependencyError } from './errors.js';

export interface NativeOrtSessionConfig {
  model: string;
  providers?: string[];
  numThreads?: number;
}

export class NativeOrtSession {
  private session: ort.InferenceSession | null = null;
  private tokenizer: any = null;
  private model: string;
  private providers: string[];
  private numThreads: number;
  private activeProvider: string = 'cpu';

  constructor(config: NativeOrtSessionConfig) {
    this.model = config.model;
    this.providers = config.providers || ['cpu'];
    this.numThreads = config.numThreads ?? 1;
  }

  async init(): Promise<void> {
    // 1. Load tokenizer via @huggingface/transformers
    const { AutoTokenizer } = await import('@huggingface/transformers');
    this.tokenizer = await AutoTokenizer.from_pretrained(this.model);

    // 2. Resolve ONNX model path
    const modelPath = await resolveModelPath(this.model);

    // 3. Create InferenceSession with provider fallback
    for (const provider of this.providers) {
      try {
        this.session = await ort.InferenceSession.create(modelPath, {
          executionProviders: [provider],
          interOpNumThreads: this.numThreads,
          intraOpNumThreads: this.numThreads,
        });
        this.activeProvider = provider;
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (this.providers.indexOf(provider) === this.providers.length - 1) {
          // Last provider in chain — throw with details
          throw new DependencyError(
            `Failed to create ORT session. Last provider ${provider}: ${msg}`
          );
        }
        // More providers to try
      }
    }

    throw new DependencyError(
      `Failed to create ORT session with any provider: ${this.providers.join(', ')}`
    );
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!this.session || !this.tokenizer) {
      throw new DependencyError('Session not initialized. Call init() first.');
    }

    // Tokenize
    const encoded = this.tokenizer(texts, {
      padding: true,
      truncation: true,
      max_length: 128,
    });

    const batchSize = encoded.input_ids.dims[0];
    const seqLen = encoded.input_ids.dims[1];

    // Convert to ORT int64 tensors
    const inputIds = toBigInt64Tensor(encoded.input_ids.data, [batchSize, seqLen]);
    const attentionMask = toBigInt64Tensor(encoded.attention_mask.data, [batchSize, seqLen]);

    const feeds: Record<string, ort.Tensor> = {
      input_ids: inputIds,
      attention_mask: attentionMask,
    };

    // Some models require token_type_ids
    if (this.session.inputNames.includes('token_type_ids')) {
      feeds.token_type_ids = new ort.Tensor(
        'int64',
        new BigInt64Array(batchSize * seqLen),
        [batchSize, seqLen]
      );
    }

    // Run inference
    const results = await this.session.run(feeds);

    // Get output — model outputs last_hidden_state or similar
    const outputKey = 'last_hidden_state' in results
      ? 'last_hidden_state'
      : this.session.outputNames[0];
    const output = results[outputKey];
    const hiddenDim = output.dims[output.dims.length - 1];
    const outputData = output.data as Float32Array;

    // Mean pooling with attention mask + L2 normalization
    return meanPoolAndNormalize(
      outputData,
      encoded.attention_mask.data,
      batchSize,
      seqLen,
      hiddenDim
    );
  }

  get provider(): string {
    return this.activeProvider;
  }

  get isInitialized(): boolean {
    return this.session !== null && this.tokenizer !== null;
  }

  async dispose(): Promise<void> {
    if (this.session) {
      await this.session.release();
      this.session = null;
    }
    this.tokenizer = null;
  }
}

/**
 * Resolve ONNX model file path from various cache locations.
 */
export async function resolveModelPath(modelName: string): Promise<string> {
  // 1. Check transformers.js cache (node_modules/@huggingface/transformers/.cache/)
  const tfCachePath = findTransformersJsCache(modelName);
  if (tfCachePath) return tfCachePath;

  // 2. Check HuggingFace Hub standard cache
  const hfCachePath = findHfHubCache(modelName);
  if (hfCachePath) return hfCachePath;

  // 3. Not cached — trigger download via AutoTokenizer (downloads full repo including onnx/)
  const { AutoTokenizer } = await import('@huggingface/transformers');
  await AutoTokenizer.from_pretrained(modelName);

  // Retry after download
  const retryPath = findTransformersJsCache(modelName) || findHfHubCache(modelName);
  if (retryPath) return retryPath;

  throw new DependencyError(
    `ONNX model file not found for '${modelName}'. ` +
    `Ensure the model has ONNX exports (e.g., Xenova/ models on HuggingFace).`
  );
}

function findTransformersJsCache(modelName: string): string | null {
  // transformers.js v3 stores models at:
  // node_modules/@huggingface/transformers/.cache/{modelName}/onnx/model.onnx
  try {
    const require = createRequire(import.meta.url);
    const resolvedEntry = require.resolve('@huggingface/transformers');
    // resolve points to dist/transformers.node.cjs — go up to package root
    const transformersRoot = path.dirname(path.dirname(resolvedEntry));
    const candidates = [
      path.join(transformersRoot, '.cache', modelName, 'onnx', 'model.onnx'),
      path.join(transformersRoot, '.cache', modelName, 'onnx', 'model_quantized.onnx'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // @huggingface/transformers not installed or path resolution failed
  }
  return null;
}

function findHfHubCache(modelName: string): string | null {
  const hfCacheDir = getHfCacheDir();
  const safeModelName = modelName.replace(/\//g, '--');
  const modelDir = path.join(hfCacheDir, `models--${safeModelName}`);
  const refsMain = path.join(modelDir, 'refs', 'main');

  if (!fs.existsSync(refsMain)) return null;

  try {
    const hash = fs.readFileSync(refsMain, 'utf-8').trim();
    const snapshotDir = path.join(modelDir, 'snapshots', hash);
    const candidates = [
      path.join(snapshotDir, 'onnx', 'model.onnx'),
      path.join(snapshotDir, 'onnx', 'model_quantized.onnx'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // Corrupted cache
  }
  return null;
}

function getHfCacheDir(): string {
  if (process.env.HF_HOME) return path.join(process.env.HF_HOME, 'hub');
  if (process.env.HUGGINGFACE_HUB_CACHE) return process.env.HUGGINGFACE_HUB_CACHE;
  if (process.env.XDG_CACHE_HOME) return path.join(process.env.XDG_CACHE_HOME, 'huggingface', 'hub');
  return path.join(os.homedir(), '.cache', 'huggingface', 'hub');
}

function toBigInt64Tensor(data: any, dims: number[]): ort.Tensor {
  const arr = new BigInt64Array(data.length);
  for (let i = 0; i < data.length; i++) {
    arr[i] = BigInt(data[i]);
  }
  return new ort.Tensor('int64', arr, dims);
}

function meanPoolAndNormalize(
  hiddenStates: Float32Array,
  attentionMask: any,
  batchSize: number,
  seqLen: number,
  hiddenDim: number
): number[][] {
  const embeddings: number[][] = [];

  for (let b = 0; b < batchSize; b++) {
    const embedding = new Float64Array(hiddenDim);
    let maskSum = 0;

    for (let s = 0; s < seqLen; s++) {
      const mask = Number(attentionMask[b * seqLen + s]);
      if (mask === 0) continue;
      maskSum += mask;

      const offset = (b * seqLen + s) * hiddenDim;
      for (let d = 0; d < hiddenDim; d++) {
        embedding[d] += hiddenStates[offset + d] * mask;
      }
    }

    // Mean
    if (maskSum > 0) {
      for (let d = 0; d < hiddenDim; d++) {
        embedding[d] /= maskSum;
      }
    }

    // L2 normalize
    let norm = 0;
    for (let d = 0; d < hiddenDim; d++) {
      norm += embedding[d] * embedding[d];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let d = 0; d < hiddenDim; d++) {
        embedding[d] /= norm;
      }
    }

    embeddings.push(Array.from(embedding));
  }

  return embeddings;
}
