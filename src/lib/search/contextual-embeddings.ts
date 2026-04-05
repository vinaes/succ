/**
 * Contextual Embeddings — LLM-generated semantic descriptions for code chunks.
 *
 * Prepends a 1-sentence description to each chunk before embedding, improving
 * semantic search quality by +35-49% recall (Anthropic technique).
 *
 * Config-gated: `indexing.contextual_embeddings: true` (default: false)
 * Cost: 1 LLM call per chunk (~50 tokens output). Uses prompt caching for
 * same-file chunks to reduce cost.
 */

import { callLLM } from '../llm.js';
import { logWarn, logInfo } from '../fault-logger.js';
import { getErrorMessage } from '../errors.js';
import type { Chunk } from '../chunker.js';

/** Circuit breaker: once an LLM call fails hard, skip all remaining calls. */
let llmCircuitOpen = false;

const CONTEXT_SYSTEM =
  'You describe code chunks in one sentence. Be precise and technical. ' +
  'Focus on what the code does, not how. No markdown, no bullet points.';

/**
 * Build the context prompt via direct interpolation (avoids String.replace
 * corruption when file content contains literal `{chunk}`).
 */
function buildContextPrompt(fileContext: string, chunkContent: string): string {
  const clippedContext = fileContext.slice(0, 4000);
  const clippedChunk = chunkContent.slice(0, 2000);
  return `File context (first 200 lines):
${clippedContext}

Describe what this code chunk does in one sentence:
${clippedChunk}`;
}

/**
 * Generate a semantic context description for a code chunk using LLM.
 * Returns the description string, or null on failure (fail-open).
 */
async function generateChunkContext(chunk: Chunk, fileContext: string): Promise<string | null> {
  const prompt = buildContextPrompt(fileContext, chunk.content);

  const response = await callLLM(prompt, {
    maxTokens: 100,
    temperature: 0.1,
    systemPrompt: CONTEXT_SYSTEM,
  });

  const desc = response?.trim();
  return !desc || desc.length < 10 || desc.length > 300 ? null : desc;
}

/**
 * Enrich chunks with LLM-generated semantic context for better embeddings.
 *
 * For each chunk, generates a 1-sentence description and prepends it:
 * `"[Context: {description}]\n[type: name(sig)]\n{content}"`
 *
 * Processes chunks sequentially per file (LLM has file context in prompt cache).
 * Falls back to structural enrichment on LLM failure.
 *
 * @param chunks - Code chunks from tree-sitter or regex chunker
 * @param fileContent - Full file content (used as context)
 * @param enrichFn - Structural enrichment function (fallback)
 * @returns Enriched text strings for embedding (same order as input chunks)
 */
export async function enrichWithContext(
  chunks: Chunk[],
  fileContent: string,
  enrichFn: (chunk: Chunk) => string
): Promise<string[]> {
  // Use first 200 lines as file context (prompt caching makes repeated calls cheap)
  const fileLines = fileContent.split('\n');
  const fileContext = fileLines.slice(0, 200).join('\n');

  const results: string[] = [];
  let contextGenerated = 0;

  for (const chunk of chunks) {
    const structuralEnrichment = enrichFn(chunk);

    // Skip LLM calls if circuit breaker is open (previous hard failure)
    if (llmCircuitOpen) {
      results.push(structuralEnrichment);
      continue;
    }

    // Try LLM context generation; trip circuit breaker on first hard failure
    let description: string | null;
    try {
      description = await generateChunkContext(chunk, fileContext);
    } catch (error) {
      llmCircuitOpen = true;
      logWarn(
        'contextual-embeddings',
        `LLM context generation failed; using structural fallback for remaining chunks: ${getErrorMessage(error)}`
      );
      results.push(structuralEnrichment);
      continue;
    }

    if (description) {
      results.push(`[Context: ${description}]\n${structuralEnrichment}`);
      contextGenerated++;
    } else {
      // Fallback to structural-only enrichment
      results.push(structuralEnrichment);
    }
  }

  if (contextGenerated > 0) {
    logInfo(
      'contextual-embeddings',
      `Generated context for ${contextGenerated}/${chunks.length} chunks`
    );
  }

  return results;
}

/** Reset the LLM circuit breaker (for testing or new indexing sessions). */
export function resetLlmCircuitBreaker(): void {
  llmCircuitOpen = false;
}
