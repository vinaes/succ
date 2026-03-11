/**
 * LLM-based query expansion for richer recall.
 *
 * Takes a user query and generates additional search terms
 * to improve retrieval coverage. Disabled by default.
 */

import { callLLM, getLLMConfig } from './llm.js';
import type { LLMBackend } from './llm.js';
import { EXPANSION_SYSTEM, EXPANSION_PROMPT } from '../prompts/index.js';

import { logWarn } from './fault-logger.js';

// ============================================================================
// Types
// ============================================================================

export interface ExpandedQuery {
  /** Original query */
  original: string;
  /** Expanded alternative queries (not including original) */
  expanded: string[];
  /** Combined string: original + all expanded terms joined by space */
  combined: string;
  /** Whether expansion was applied */
  wasExpanded: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Returns true if the query looks like a code snippet rather than natural language.
 * Code-like queries are skipped for expansion.
 */
export function looksLikeCode(query: string): boolean {
  return /[{}();=]|=>|\.\w+\(/.test(query);
}

// ============================================================================
// Core expand (returns string[] — used by recall.ts)
// ============================================================================

/**
 * Expand a query into multiple search terms using LLM.
 *
 * @param query - The original user query
 * @param mode - LLM backend override (defaults to configured backend)
 * @returns Array of expanded queries (NOT including the original)
 */
export async function expandQuery(query: string, mode?: LLMBackend): Promise<string[]> {
  const prompt = EXPANSION_PROMPT.replace('{query}', query);

  const llmConfig = getLLMConfig();
  const backend = mode ?? llmConfig.backend;

  try {
    const configOverride = backend !== llmConfig.backend ? { backend } : undefined;
    const response = await callLLM(
      prompt,
      {
        maxTokens: 200,
        temperature: 0.7,
        systemPrompt: EXPANSION_SYSTEM,
      },
      configOverride
    );

    if (!response || response.trim().length === 0) return [];

    // Parse response: one query per line, filter empty/invalid
    const expanded = response
      .split('\n')
      .map((line) => line.replace(/^[\d\-*.)]+\s*/, '').trim()) // strip numbering
      .filter((line) => line.length >= 3 && line.length <= 200)
      .filter((line) => !/^(alternative|here are|queries?:)/i.test(line))
      .slice(0, 5);

    return expanded;
  } catch (error) {
    logWarn('query-expansion', 'LLM call failed for query expansion', {
      error: error instanceof Error ? error.message : String(error),
    });
    // LLM failure should never break search — silently fall back to no expansion
    return [];
  }
}

// ============================================================================
// Full expand (returns ExpandedQuery — used by BM25 / hybrid search)
// ============================================================================

export interface ExpandQueryFullOptions {
  /** Force expansion even for long or code-like queries */
  forceExpand?: boolean;
  /** LLM backend override */
  mode?: LLMBackend;
}

/**
 * Expand a query and return a structured result with combined string.
 *
 * Skips expansion for code-like queries or queries with 8+ words unless
 * `forceExpand` is set. Delegates to `expandQuery()` for LLM expansion.
 *
 * @param query - Search query to expand
 * @param options - Optional flags (forceExpand, mode)
 * @returns ExpandedQuery with original, expanded[], combined, wasExpanded
 */
export async function expandQueryFull(
  query: string,
  options: ExpandQueryFullOptions = {}
): Promise<ExpandedQuery> {
  const { forceExpand = false, mode } = options;

  // '   '.trim().split(/\s+/) returns [''] (length 1), so the wordCount >= 8
  // check below does NOT guard against whitespace-only queries. Bail early.
  if (!query.trim()) {
    return { original: query, expanded: [], combined: query, wasExpanded: false };
  }

  if (!forceExpand) {
    const wordCount = query.trim().split(/\s+/).length;
    if (wordCount >= 8 || looksLikeCode(query)) {
      return {
        original: query,
        expanded: [],
        combined: query,
        wasExpanded: false,
      };
    }
  }

  const expanded = await expandQuery(query, mode);

  if (expanded.length === 0) {
    return {
      original: query,
      expanded: [],
      combined: query,
      wasExpanded: false,
    };
  }

  return {
    original: query,
    expanded,
    combined: [query, ...expanded].join(' '),
    wasExpanded: true,
  };
}
