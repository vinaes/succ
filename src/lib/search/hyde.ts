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
import { parseCode } from '../tree-sitter/index.js';

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
  // Clamp to prevent excessive LLM fan-out / rate limiting
  numHypotheticals = Math.max(1, Math.min(numHypotheticals, 10));
  // Use tree-sitter AST to detect if query is already code — skip HyDE if so
  if (await looksLikeCodeAST(query)) {
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

    // Embed only the hypothetical code snippets — not the original NL query.
    // Mixing the query back in pulls the averaged vector toward natural-language
    // space and weakens the code-space bridge HyDE is meant to create.
    const allTexts = hypotheticals;
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

// Languages to try when checking if a query is code
const CODE_DETECT_LANGUAGES = ['typescript', 'python', 'go', 'rust'] as const;

/**
 * Detect if a query is code using tree-sitter AST parsing.
 *
 * Tries parsing the query as several common languages. If any language
 * produces a clean AST (no ERROR nodes), the query is code.
 * Falls back to false if tree-sitter is unavailable.
 */
async function looksLikeCodeAST(query: string): Promise<boolean> {
  // Short strings (< 3 chars) cannot form valid code constructs
  if (query.length < 3) return false;

  for (const lang of CODE_DETECT_LANGUAGES) {
    try {
      const tree = await parseCode(query, lang);
      if (!tree) continue;

      try {
        const root = tree.rootNode;
        // Clean parse with at least one named child = definitely code
        if (!root.hasError && root.namedChildCount > 0) {
          return true;
        }
        // Mostly clean: few errors relative to named children = likely code
        if (root.namedChildCount >= 2) {
          const errorNodes = root.descendantsOfType('ERROR');
          if (errorNodes.length / root.namedChildCount < 0.3) {
            return true;
          }
        }
      } finally {
        tree.delete();
      }
    } catch (err) {
      logWarn('hyde', `Tree-sitter parse failed for ${lang}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return false;
}
