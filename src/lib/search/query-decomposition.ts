/**
 * Query Decomposition — split complex multi-concept queries into focused sub-queries.
 *
 * Detection heuristic: >15 words, contains conjunctions, asks about multiple entities.
 * LLM decomposition: "Split into 2-3 focused sub-queries" → parallel retrieval → RRF merge.
 *
 * Gated behind config: `retrieval.query_decomposition_enabled: true`
 * Costs 1 LLM call per search when triggered.
 */

import { callLLM } from '../llm.js';
import { logWarn } from '../fault-logger.js';

// ============================================================================
// Types
// ============================================================================

export interface DecompositionResult {
  /** Original query */
  original: string;
  /** Decomposed sub-queries (empty if not decomposed) */
  subQueries: string[];
  /** Whether decomposition was applied */
  wasDecomposed: boolean;
}

// ============================================================================
// Detection
// ============================================================================

/** Conjunctions and multi-concept indicators */
const CONJUNCTION_PATTERN = /\b(and|but|or|versus|vs\.?|compared to|as well as|along with|plus)\b/i;

/** Question words that suggest multi-part queries */
const MULTI_QUESTION_PATTERN =
  /\b(how|what|why|where|when|which)\b.*\b(and|also|additionally|moreover)\b/i;

/**
 * Detect if a query is complex enough to benefit from decomposition.
 *
 * Criteria (any 2 must match):
 * - >15 words
 * - Contains conjunctions (and/but/or/versus)
 * - Contains multiple quoted terms or identifiers
 * - Multi-part question pattern
 */
export function shouldDecompose(query: string): boolean {
  const words = query.split(/\s+/).filter((w) => w.length > 0);
  let signals = 0;

  if (words.length > 15) signals++;
  if (CONJUNCTION_PATTERN.test(query)) signals++;
  if (MULTI_QUESTION_PATTERN.test(query)) signals++;

  // Multiple quoted phrases (e.g., compare "retry budget" versus "rate limit")
  const quotedTerms = query.match(/"[^"\n]{2,}"|'[^'\n]{2,}'/g);
  if (quotedTerms && quotedTerms.length >= 2) signals++;

  // Multiple identifiers (PascalCase, snake_case, dotNotation)
  const identifiers = query.match(/\b[A-Z][a-zA-Z]+\b|\b\w+_\w+\b|\b\w+\.\w+\b/g);
  if (identifiers && identifiers.length >= 2) signals++;

  return signals >= 2;
}

// ============================================================================
// Decomposition
// ============================================================================

const DECOMPOSITION_SYSTEM =
  'You split complex queries into 2-3 focused sub-queries. Each sub-query should target one specific concept. Return ONLY the sub-queries, one per line. No numbering, no explanations.';

const DECOMPOSITION_PROMPT = `Split this query into 2-3 focused sub-queries:

{query}`;

/**
 * Decompose a complex query into focused sub-queries using LLM.
 *
 * Returns the original query unchanged if:
 * - Query is too simple (shouldDecompose returns false)
 * - LLM call fails (graceful fallback)
 * - LLM returns fewer than 2 sub-queries
 *
 * @param query - The original user query
 * @returns Decomposition result with sub-queries
 */
export async function decomposeQuery(query: string): Promise<DecompositionResult> {
  if (!shouldDecompose(query)) {
    return { original: query, subQueries: [], wasDecomposed: false };
  }

  try {
    const prompt = DECOMPOSITION_PROMPT.replace('{query}', query);
    const response = await callLLM(prompt, {
      maxTokens: 200,
      temperature: 0.3,
      systemPrompt: DECOMPOSITION_SYSTEM,
      timeout: 15000,
    });

    if (!response || response.trim().length === 0) {
      return { original: query, subQueries: [], wasDecomposed: false };
    }

    const seen = new Set<string>();
    const subQueries = response
      .split('\n')
      .map((line) =>
        line
          .replace(/^\d+[.)]\s*/, '')
          .replace(/^[-*]\s+/, '')
          .trim()
      )
      .filter((line) => line.length >= 5 && line.length <= 300)
      .filter((line) => !/^(sub-quer|here|the query|split)/i.test(line))
      .filter((line) => {
        const key = line.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 3);

    if (subQueries.length < 2) {
      return { original: query, subQueries: [], wasDecomposed: false };
    }

    return { original: query, subQueries, wasDecomposed: true };
  } catch (error) {
    logWarn('query-decomposition', 'LLM decomposition failed, using original query', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { original: query, subQueries: [], wasDecomposed: false };
  }
}
