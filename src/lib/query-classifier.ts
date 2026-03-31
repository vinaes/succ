/**
 * Query classification for adaptive BM25/vector alpha selection.
 * Pure regex — zero cost, no LLM call.
 */

export type QueryType = 'identifier' | 'natural_language' | 'mixed';

/**
 * Classify a query to determine optimal BM25/vector balance.
 *
 * - identifier: camelCase, PascalCase, snake_case, dotNotation, contains () → alpha=0.3 (boost BM25)
 * - natural_language: starts with how/what/why/when, >=3 words → alpha=0.7 (boost vector)
 * - mixed: default → alpha=0.5
 */
export function classifyQuery(query: string): { type: QueryType; alpha: number } {
  const words = query.split(/\s+/).filter((w) => w.length > 0);

  // Identifier-like patterns: strong BM25 signal
  const hasParens = /\(/.test(query);
  const hasPascalCase = /\b[A-Z][a-z]+[A-Z]\w*\b/.test(query);
  const hasCamelCase = /\b[a-z]+[A-Z]\w*\b/.test(query);
  const hasSnakeCase = /\b\w+_\w+\b/.test(query);
  const hasDotNotation = /\b\w+\.\w+\b/.test(query);
  const hasCodeSyntax = /[{}();=]|=>|::/.test(query);

  const identifierSignals =
    (hasParens ? 1 : 0) +
    (hasPascalCase ? 1 : 0) +
    (hasCamelCase ? 1 : 0) +
    (hasSnakeCase ? 1 : 0) +
    (hasDotNotation ? 1 : 0) +
    (hasCodeSyntax ? 1 : 0);

  if (identifierSignals >= 2 || (identifierSignals >= 1 && words.length <= 3)) {
    return { type: 'identifier', alpha: 0.3 };
  }

  // Natural language question patterns: strong vector signal
  // Threshold >= 3 words so short questions like "what is X?" classify as NL
  const startsWithQuestion = /^(how|what|why|where|when|which|can|does|is|are|should)\b/i.test(
    query
  );
  const isLongQuery = words.length >= 3;

  if (startsWithQuestion && isLongQuery) {
    return { type: 'natural_language', alpha: 0.7 };
  }

  return { type: 'mixed', alpha: 0.5 };
}
