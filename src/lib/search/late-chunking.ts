/**
 * Late Chunking — embed full file context, pool per AST chunk boundaries.
 *
 * Traditional chunking: chunk first → embed each chunk independently.
 * Late chunking: embed full file → get per-token hidden states → pool by AST boundaries.
 *
 * Each chunk embedding "knows about" the whole file context for free.
 * No extra LLM calls. Requires a long-context embedding model (e.g., jina 8192 tokens).
 *
 * Reference: Jina AI "Late Chunking" (2024)
 * https://jina.ai/news/late-chunking-in-long-context-embedding-models/
 */

import { logInfo, logWarn } from '../fault-logger.js';
import { getNativeSession, getModelMaxLength } from '../embeddings.js';
import { chunkCodeAsync, type Chunk } from '../chunker.js';
import { getLLMTaskConfig } from '../config.js';
import { LOCAL_MODEL } from '../config-defaults.js';

// ============================================================================
// Types
// ============================================================================

export interface LateChunkResult {
  /** Original chunk metadata */
  chunk: Chunk;
  /** Embedding generated via late chunking (context-aware) */
  embedding: number[];
}

export interface LateChunkingResult {
  /** Per-chunk embeddings with file-level context baked in */
  chunks: LateChunkResult[];
  /** Whether late chunking was used (false = fell back to standard) */
  usedLateChunking: boolean;
  /** Reason for fallback if not used */
  fallbackReason?: string;
}

// Minimum max_length to enable late chunking (short-context models can't benefit)
const MIN_CONTEXT_FOR_LATE_CHUNKING = 512;

// ============================================================================
// Core Implementation
// ============================================================================

/**
 * Generate embeddings for code chunks using late chunking.
 *
 * Pipeline:
 * 1. Parse file into AST chunks (tree-sitter)
 * 2. Concatenate full file content
 * 3. Run embedding model on full file → get per-token hidden states
 * 4. Map AST chunk character boundaries to token positions
 * 5. Mean-pool hidden states within each chunk's token range
 * 6. L2-normalize each chunk embedding
 *
 * Falls back to standard chunking if:
 * - Model max_length < 512 (short-context model won't benefit)
 * - File exceeds model's max token length
 * - Token offset mapping unavailable
 *
 * @param content - Full file content
 * @param filePath - File path for AST parsing
 * @returns Per-chunk embeddings with file-level context
 */
export async function lateChunkEmbed(
  content: string,
  filePath: string
): Promise<LateChunkingResult> {
  // Check if current model supports late chunking
  const taskCfg = getLLMTaskConfig('embeddings');
  const model = taskCfg.model || LOCAL_MODEL;
  const maxLength = getModelMaxLength(model);

  if (maxLength < MIN_CONTEXT_FOR_LATE_CHUNKING) {
    return {
      chunks: [],
      usedLateChunking: false,
      fallbackReason: `Model ${model} max_length=${maxLength} too short for late chunking (need ${MIN_CONTEXT_FOR_LATE_CHUNKING}+)`,
    };
  }

  // 1. Parse into AST chunks
  const chunks = await chunkCodeAsync(content, filePath);
  if (chunks.length === 0) {
    return { chunks: [], usedLateChunking: true };
  }

  try {
    const session = await getNativeSession();

    // 2. Get token offsets for the full file
    const tokenOffsets = session.getTokenOffsets(content);

    // Detect tokenizer truncation: if the model's max_length was exceeded the
    // tokenizer silently truncates the input. We check by finding the last
    // token whose offset covers real content (non-special tokens have non-zero
    // offsets) and comparing its end to the content length. If the furthest
    // character covered is substantially less than the full content length the
    // file was truncated and late chunking would produce incorrect embeddings
    // for the trailing chunks.
    const lastCoveredChar = tokenOffsets.reduce((max, [, tEnd], i) => {
      // Skip special tokens (offset [0,0] after position 0)
      if (tEnd === 0 && i > 0) return max;
      return Math.max(max, tEnd);
    }, 0);
    // 0.95 threshold: allow up to 5% character loss from tokenizer rounding
    // (subword boundaries rarely align exactly with content end). Beyond 5%
    // the file was genuinely truncated and trailing chunks would be wrong.
    if (lastCoveredChar > 0 && lastCoveredChar < content.length * 0.95) {
      return {
        chunks: [],
        usedLateChunking: false,
        fallbackReason: `File exceeds model max_length (covered ${lastCoveredChar}/${content.length} chars); falling back to standard chunking`,
      };
    }

    // 3. Run model on full file → get per-token hidden states
    const raw = await session.embedRaw(content);

    // 4. Pre-compute line offsets for O(1) char position lookup
    const lineOffsets = computeLineOffsets(content);

    // Map each chunk's character range to token positions
    const results: LateChunkResult[] = [];

    for (const chunk of chunks) {
      // Find character range for this chunk in the original content.
      // chunk.startLine / chunk.endLine are 1-indexed.
      //
      // The end boundary is derived from lineOffsets rather than from
      // chunk.content.length.  chunk.content is assembled with join('\n'),
      // which omits the trailing newline that exists in the original source.
      // Using lineOffsets[endLine] (= start-of-next-line) gives the correct
      // exclusive end that covers the trailing '\n'.  For the very last chunk
      // we fall back to content.length so we never read past the buffer.
      const chunkCharStart = getCharOffsetForLine(lineOffsets, chunk.startLine);
      // lineOffsets is 0-indexed by line (lineOffsets[0] = offset of line 1).
      // The offset of the line after endLine is lineOffsets[endLine] when it
      // exists, otherwise the total content length.
      const chunkCharEnd =
        chunk.endLine < lineOffsets.length ? lineOffsets[chunk.endLine] : content.length;

      // Map char range to token range
      const tokenRange = charRangeToTokenRange(tokenOffsets, chunkCharStart, chunkCharEnd);

      if (tokenRange.start >= tokenRange.end) {
        // Chunk mapped to zero tokens — skip
        continue;
      }

      // 5. Mean-pool hidden states within this token range
      const embedding = poolTokenRange(
        raw.hiddenStates,
        raw.attentionMask,
        raw.hiddenDim,
        tokenRange.start,
        tokenRange.end
      );

      // 6. L2-normalize
      l2Normalize(embedding);

      results.push({ chunk, embedding: Array.from(embedding) });
    }

    logInfo(
      'late-chunking',
      `Generated ${results.length} context-aware embeddings for ${filePath} (${tokenOffsets.length} tokens)`
    );

    return { chunks: results, usedLateChunking: true };
  } catch (error) {
    logWarn('late-chunking', `Late chunking failed, use standard embedding`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      chunks: [],
      usedLateChunking: false,
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if the current embedding model supports late chunking.
 */
export function isLateChunkingSupported(): boolean {
  const taskCfg = getLLMTaskConfig('embeddings');
  const model = taskCfg.model || LOCAL_MODEL;
  const maxLength = getModelMaxLength(model);
  return maxLength >= MIN_CONTEXT_FOR_LATE_CHUNKING;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Pre-compute character offset for each line (0-indexed).
 * Returns array where lineOffsets[i] = char offset of line i+1 (1-indexed).
 */
function computeLineOffsets(content: string): number[] {
  const offsets: number[] = [0]; // Line 1 starts at offset 0
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

/**
 * Get character offset for a 1-indexed line number.
 */
function getCharOffsetForLine(lineOffsets: number[], line: number): number {
  const idx = Math.max(0, Math.min(line - 1, lineOffsets.length - 1));
  return lineOffsets[idx];
}

/**
 * Map character range [charStart, charEnd) to token range [tokenStart, tokenEnd).
 * Uses token offset mappings from the tokenizer.
 */
function charRangeToTokenRange(
  tokenOffsets: Array<[number, number]>,
  charStart: number,
  charEnd: number
): { start: number; end: number } {
  let tokenStart = tokenOffsets.length;
  let tokenEnd = 0;

  for (let i = 0; i < tokenOffsets.length; i++) {
    const [tStart, tEnd] = tokenOffsets[i];

    // Skip special tokens (offset [0,0])
    if (tStart === 0 && tEnd === 0 && i > 0) continue;

    // Token overlaps with chunk range
    if (tEnd > charStart && tStart < charEnd) {
      tokenStart = Math.min(tokenStart, i);
      tokenEnd = Math.max(tokenEnd, i + 1);
    }
  }

  return { start: tokenStart, end: tokenEnd };
}

/**
 * Mean-pool hidden states for a token range [start, end).
 * Respects attention mask (skips padding tokens).
 */
function poolTokenRange(
  hiddenStates: Float32Array,
  attentionMask: any,
  hiddenDim: number,
  tokenStart: number,
  tokenEnd: number
): Float64Array {
  const embedding = new Float64Array(hiddenDim);
  let maskSum = 0;

  for (let t = tokenStart; t < tokenEnd; t++) {
    const mask = Number(attentionMask[t]);
    if (mask === 0) continue;
    maskSum += mask;

    const offset = t * hiddenDim;
    for (let d = 0; d < hiddenDim; d++) {
      embedding[d] += hiddenStates[offset + d] * mask;
    }
  }

  if (maskSum > 0) {
    for (let d = 0; d < hiddenDim; d++) {
      embedding[d] /= maskSum;
    }
  }

  return embedding;
}

/**
 * In-place L2 normalization.
 */
function l2Normalize(embedding: Float64Array): void {
  let norm = 0;
  for (let d = 0; d < embedding.length; d++) {
    norm += embedding[d] * embedding[d];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let d = 0; d < embedding.length; d++) {
      embedding[d] /= norm;
    }
  }
}
