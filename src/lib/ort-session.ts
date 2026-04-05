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
import { logWarn } from './fault-logger.js';

export interface NativeOrtSessionConfig {
  model: string;
  providers?: string[];
  numThreads?: number;
  /** Max token length for tokenizer truncation (default: model-specific or 128) */
  maxLength?: number;
}

export class NativeOrtSession {
  private session: ort.InferenceSession | null = null;
  private tokenizer: any = null;
  private model: string;
  private providers: string[];
  private numThreads: number;
  private maxLength: number;
  private activeProvider: string = 'cpu';

  constructor(config: NativeOrtSessionConfig) {
    this.model = config.model;
    this.providers = config.providers || ['cpu'];
    this.numThreads = config.numThreads ?? 1;
    this.maxLength = config.maxLength ?? 128;
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
      max_length: this.maxLength,
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
      feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(batchSize * seqLen), [
        batchSize,
        seqLen,
      ]);
    }

    // Run inference
    const results = await this.session.run(feeds);

    // Get output — model outputs last_hidden_state or similar
    const outputKey =
      'last_hidden_state' in results ? 'last_hidden_state' : this.session.outputNames[0];
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

  /**
   * Run inference and return raw per-token hidden states (before pooling).
   * Used by late chunking to pool embeddings per AST chunk boundaries.
   *
   * @returns { hiddenStates, attentionMask, seqLen, hiddenDim } for each text
   */
  async embedRaw(text: string): Promise<{
    hiddenStates: Float32Array;
    attentionMask: any;
    seqLen: number;
    hiddenDim: number;
  }> {
    if (!this.session || !this.tokenizer) {
      throw new DependencyError('Session not initialized. Call init() first.');
    }

    // Tokenize single text
    const encoded = this.tokenizer([text], {
      padding: true,
      truncation: true,
      max_length: this.maxLength,
    });

    const seqLen = encoded.input_ids.dims[1];

    // Convert to ORT int64 tensors
    const inputIds = toBigInt64Tensor(encoded.input_ids.data, [1, seqLen]);
    const attentionMask = toBigInt64Tensor(encoded.attention_mask.data, [1, seqLen]);

    const feeds: Record<string, ort.Tensor> = {
      input_ids: inputIds,
      attention_mask: attentionMask,
    };

    if (this.session.inputNames.includes('token_type_ids')) {
      feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(seqLen), [1, seqLen]);
    }

    const results = await this.session.run(feeds);

    const outputKey =
      'last_hidden_state' in results ? 'last_hidden_state' : this.session.outputNames[0];
    const output = results[outputKey];
    const hiddenDim = output.dims[output.dims.length - 1];

    return {
      hiddenStates: output.data as Float32Array,
      attentionMask: encoded.attention_mask.data,
      seqLen,
      hiddenDim,
    };
  }

  /**
   * Tokenize text and return token offsets (character positions).
   * Used by late chunking to map AST chunk boundaries to token positions.
   *
   * Transformers.js does not support `return_offsets_mapping` — the option is
   * silently ignored (the field is absent from the returned tensor map) or, in
   * some versions, throws.  We attempt the call with the option first; if the
   * offsets are absent or the call throws we fall back to a uniform character-
   * distribution estimate which is good enough for the late-chunking use case.
   */
  getTokenOffsets(text: string): Array<[number, number]> {
    if (!this.tokenizer) {
      throw new DependencyError('Session not initialized. Call init() first.');
    }

    // Pass as array for consistent behavior with embedRaw() (2D tensor output).
    // return_offsets_mapping is a hint — not all tokenizer backends honour it.
    let encoded: any;
    try {
      encoded = this.tokenizer([text], {
        truncation: true,
        max_length: this.maxLength,
        return_offsets_mapping: true,
      });
    } catch (error) {
      // Some tokenizer backends throw on unknown options; retry without it.
      logWarn('ort-session', 'Tokenizer does not support return_offsets_mapping, using fallback', {
        error: error instanceof Error ? error.message : String(error),
      });
      encoded = this.tokenizer([text], {
        truncation: true,
        max_length: this.maxLength,
      });
    }

    // offsets_mapping: [[start, end], ...] for each token
    const offsets: Array<[number, number]> = [];
    if (encoded.offsets_mapping?.data) {
      const data = encoded.offsets_mapping.data;
      for (let i = 0; i < data.length; i += 2) {
        offsets.push([Number(data[i]), Number(data[i + 1])]);
      }
    }

    if (offsets.length > 0) {
      return offsets;
    }

    // Fallback: build a uniform character-range estimate.
    // This is imprecise but keeps late-chunking functional without native
    // offset support.  The late-chunking pipeline already handles the case
    // where token ranges map to zero tokens (they are skipped).
    const tokenCount = encoded.input_ids.dims[encoded.input_ids.dims.length - 1];
    const charPerToken = Math.ceil(text.length / Math.max(tokenCount, 1));
    for (let i = 0; i < tokenCount; i++) {
      const start = i * charPerToken;
      const end = Math.min((i + 1) * charPerToken, text.length);
      offsets.push([start, end]);
    }

    return offsets;
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
export async function resolveModelPath(modelName: string, signal?: AbortSignal): Promise<string> {
  // 1. Check transformers.js cache (node_modules/@huggingface/transformers/.cache/)
  const tfCachePath = findTransformersJsCache(modelName);
  if (tfCachePath) return tfCachePath;

  // 2. Check HuggingFace Hub standard cache
  const hfCachePath = findHfHubCache(modelName);
  if (hfCachePath) return hfCachePath;

  // 3. Not cached — trigger download via AutoModel (downloads config.json + onnx/model.onnx)
  // Note: AutoTokenizer only downloads tokenizer files, NOT the ONNX model.
  // AutoModel.from_pretrained() downloads the full model including onnx/model.onnx.

  // Fast-path: abort before expensive module load
  if (signal?.aborted) {
    const err = new DependencyError(`Model resolution aborted for '${modelName}'`);
    (err as any).aborted = true;
    throw err;
  }

  const transformers = await import('@huggingface/transformers');
  const AutoModel = (transformers as any).AutoModel;

  // Check abort after async import, before starting expensive download
  if (signal?.aborted) {
    const err = new DependencyError(`Model resolution aborted for '${modelName}'`);
    (err as any).aborted = true;
    throw err;
  }

  let tempModel;
  try {
    const downloadPromise = AutoModel.from_pretrained(modelName, {
      device: 'cpu',
      dtype: 'fp32',
    });

    if (signal) {
      const abortPromise = new Promise<never>((_, reject) => {
        const makeAbortError = () => {
          const err = new DependencyError(`Model resolution aborted for '${modelName}'`);
          (err as any).aborted = true;
          return err;
        };
        if (signal.aborted) {
          reject(makeAbortError());
        } else {
          signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
        }
      });
      tempModel = await Promise.race([downloadPromise, abortPromise]);
    } else {
      tempModel = await downloadPromise;
    }
  } finally {
    try {
      if (tempModel?.dispose) {
        await tempModel.dispose();
      }
    } catch (err) {
      logWarn(
        'ort-session',
        `AutoModel dispose failed (non-critical): ${err instanceof Error ? err.message : err}`
      );
    }
  }

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
  } catch (error) {
    logWarn(
      'ort-session',
      'Failed to resolve ONNX model path from @huggingface/transformers cache',
      {
        error: error instanceof Error ? error.message : String(error),
      }
    );
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
  } catch (error) {
    logWarn('ort-session', 'Failed to read HuggingFace hub cache snapshot for ONNX model', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Corrupted cache
  }
  return null;
}

function getHfCacheDir(): string {
  if (process.env.HF_HOME) return path.join(process.env.HF_HOME, 'hub');
  if (process.env.HUGGINGFACE_HUB_CACHE) return process.env.HUGGINGFACE_HUB_CACHE;
  if (process.env.XDG_CACHE_HOME)
    return path.join(process.env.XDG_CACHE_HOME, 'huggingface', 'hub');
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
