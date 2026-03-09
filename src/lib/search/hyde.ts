/**
 * HyDE (Hypothetical Document Embeddings) for Code Search.
 *
 * For natural language queries, generates a hypothetical code snippet
 * via LLM, then embeds the code (not the query) to bridge the
 * NL↔code embedding space gap.
 *
 * "how to debounce" → LLM generates `function debounce(fn, delay) {...}`
 * → embed the code → find real implementations.
 */

import { callLLM } from '../llm.js';
import { getEmbedding, getEmbeddings } from '../embeddings.js';
import { logInfo, logWarn } from '../fault-logger.js';

// ============================================================================
// Types
// ============================================================================

export interface HyDEResult {
  /** Averaged embedding from hypothetical documents */
  embedding: number[];
  /** The generated hypothetical code snippets */
  hypotheticals: string[];
  /** Whether HyDE was used (vs. fallback to direct query embedding) */
  used: boolean;
}

// ============================================================================
// HyDE
// ============================================================================

const HYDE_SYSTEM = `You are a code generation assistant. Given a natural language query about code, generate a realistic code snippet that would answer the query. Output ONLY the code, no explanations.`;

const HYDE_PROMPT = `Generate a code snippet that answers this query:
"{query}"

Requirements:
- Write realistic, production-quality code
- Use common patterns and naming conventions
- Include function signature, types, and core logic
- Output ONLY the code (no markdown, no explanations)`;

/**
 * Generate hypothetical code embeddings for a natural language query.
 *
 * @param query - Natural language search query
 * @param numHypotheticals - Number of hypothetical docs to generate (default: 3)
 * @returns Averaged embedding from hypothetical documents
 */
export async function generateHyDE(
  query: string,
  numHypotheticals: number = 3
): Promise<HyDEResult> {
  // Quick heuristic: if query looks like code already, skip HyDE
  if (looksLikeCode(query)) {
    const embedding = await getEmbedding(query);
    return { embedding, hypotheticals: [], used: false };
  }

  try {
    // Generate hypothetical code snippets in parallel
    const promises = Array.from({ length: numHypotheticals }, () =>
      callLLM(HYDE_PROMPT.replace('{query}', query), {
        maxTokens: 500,
        systemPrompt: HYDE_SYSTEM,
        timeout: 15000,
      })
    );

    const responses = await Promise.allSettled(promises);
    const hypotheticals = responses
      .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
      .map((r) => r.value.trim())
      .filter((code) => code.length > 20); // Filter empty/tiny responses

    if (hypotheticals.length === 0) {
      logWarn('hyde', 'All hypothetical generations failed, falling back to query embedding');
      const embedding = await getEmbedding(query);
      return { embedding, hypotheticals: [], used: false };
    }

    // Embed all hypotheticals + the original query
    const allTexts = [query, ...hypotheticals];
    const embeddings = await getEmbeddings(allTexts);

    // Average all embeddings
    const dim = embeddings[0].length;
    const averaged = new Array(dim).fill(0);

    for (const emb of embeddings) {
      for (let i = 0; i < dim; i++) {
        averaged[i] += emb[i];
      }
    }

    for (let i = 0; i < dim; i++) {
      averaged[i] /= embeddings.length;
    }

    // Normalize
    const norm = Math.sqrt(averaged.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < dim; i++) {
        averaged[i] /= norm;
      }
    }

    logInfo('hyde', `Generated ${hypotheticals.length} hypothetical embeddings for query`);

    return { embedding: averaged, hypotheticals, used: true };
  } catch (error) {
    logWarn('hyde', 'HyDE generation failed, falling back to query embedding', {
      error: error instanceof Error ? error.message : String(error),
    });
    const embedding = await getEmbedding(query);
    return { embedding, hypotheticals: [], used: false };
  }
}

/**
 * Heuristic to detect if a query already looks like code.
 * If so, HyDE is unnecessary — just embed directly.
 */
function looksLikeCode(query: string): boolean {
  const codeIndicators = [
    /^(function|const|let|var|class|import|export|def|fn|pub|async|interface|type)\s/,
    /[{}();=]/,
    /\.\w+\(/,
    /=>/,
    /^\s*(if|for|while|return|switch|match)\s/,
  ];

  return codeIndicators.some((re) => re.test(query));
}
