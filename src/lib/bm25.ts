/**
 * BM25 + Hybrid Search
 *
 * Two modes:
 * - Code search: exact tokenizer for identifiers (camelCase, snake_case)
 * - Docs search: stemming for natural language
 *
 * Best practices from research:
 * - RRF (Reciprocal Rank Fusion) for combining results
 * - k1=1.3, b=0.75 - optimal parameters
 * - Exact match boost for identifier searches
 *
 * Sources:
 * - https://weaviate.io/blog/hybrid-search-explained
 * - https://superlinked.com/vectorhub/articles/optimizing-rag-with-hybrid-search-reranking
 */

// BM25 parameters (tuned for code/docs)
const K1 = 1.3; // Term frequency saturation (1.2-1.5 optimal)
const B = 0.75; // Length normalization
const RRF_K = 60; // RRF constant (standard value)

export interface BM25Index {
  invertedIndex: Map<string, Map<number, number>>;
  docLengths: Map<number, number>;
  avgDocLength: number;
  totalDocs: number;
  // For exact match boost
  rawContent: Map<number, string>;
}

export interface BM25Result {
  docId: number;
  score: number;
}

// ============================================================================
// Tokenizers
// ============================================================================

/**
 * Code-aware tokenizer
 * Handles all common naming conventions:
 * - camelCase: getUserName -> get, user, name
 * - PascalCase: GetUserName -> get, user, name
 * - snake_case: get_user_name -> get, user, name
 * - SCREAMING_SNAKE: GET_USER_NAME -> get, user, name
 * - kebab-case: get-user-name -> get, user, name
 * - dot.case: get.user.name -> get, user, name
 * - path/case: src/utils/helper -> src, utils, helper
 * - Train-Case: Get-User-Name -> get, user, name
 * - colon::case: std::vector -> std, vector
 * - number suffixes: user2, v3 -> user, 2, v, 3
 *
 * Preserves original identifiers for exact match
 */
export function tokenizeCode(text: string): string[] {
  // 1. Split camelCase/PascalCase: useGlobalHooks -> use Global Hooks
  let processed = text.replace(/([a-z])([A-Z])/g, '$1 $2');
  // Handle acronyms: HTMLParser -> HTML Parser
  processed = processed.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

  // 2. Split on common separators: _ - . / \ : @
  processed = processed.replace(/[_\-./\\:@]+/g, ' ');

  // 3. Split numbers from letters: user2 -> user 2, v3 -> v 3
  processed = processed.replace(/([a-zA-Z])(\d)/g, '$1 $2');
  processed = processed.replace(/(\d)([a-zA-Z])/g, '$1 $2');

  // 4. Keep alphanumeric, remove rest
  processed = processed.replace(/[^a-zA-Z0-9\s]/g, ' ');

  // 5. Lowercase and split
  const words = processed
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  // 6. Add original tokens for exact match (important for searching useGlobalHooks)
  // Split on non-identifier chars but keep underscores (valid in most languages)
  const originalTokens = text
    .split(/[^a-zA-Z0-9_]+/)
    .filter((t) => t.length > 1)
    .map((t) => t.toLowerCase());

  // Combine: split tokens + original identifiers
  return [...new Set([...words, ...originalTokens])];
}

/**
 * Porter Stemmer (simplified)
 * Handles common English suffixes
 */
function stem(word: string): string {
  if (word.length < 3) return word;

  let w = word.toLowerCase();

  // Step 1a: plurals
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies')) w = w.slice(0, -2) + 'y';
  else if (w.endsWith('ss')) {
    /* keep */
  } else if (w.endsWith('s')) w = w.slice(0, -1);

  // Step 1b: -ed, -ing
  if (w.endsWith('eed')) {
    if (w.length > 4) w = w.slice(0, -1);
  } else if (w.endsWith('ed')) {
    const base = w.slice(0, -2);
    if (/[aeiou]/.test(base)) w = base;
  } else if (w.endsWith('ing')) {
    const base = w.slice(0, -3);
    if (/[aeiou]/.test(base)) w = base;
  }

  // Step 2: common suffixes
  const suffixes: [string, string][] = [
    ['ational', 'ate'],
    ['tional', 'tion'],
    ['ization', 'ize'],
    ['ation', 'ate'],
    ['fulness', 'ful'],
    ['ousness', 'ous'],
    ['iveness', 'ive'],
    ['ement', 'e'],
    ['ment', ''],
    ['ness', ''],
    ['able', ''],
    ['ible', ''],
    ['ful', ''],
    ['less', ''],
    ['ive', ''],
    ['ize', ''],
    ['ise', ''],
    ['ly', ''],
    ['er', ''],
    ['or', ''],
  ];

  for (const [suffix, replacement] of suffixes) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 2) {
      w = w.slice(0, -suffix.length) + replacement;
      break;
    }
  }

  return w;
}

/**
 * Docs tokenizer with stemming
 * For natural language in markdown files
 */
export function tokenizeDocs(text: string): string[] {
  // Remove markdown syntax
  let processed = text
    .replace(/```[\s\S]*?```/g, ' ') // code blocks
    .replace(/`[^`]+`/g, ' ') // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links -> text
    .replace(/[#*_~>|]/g, ' ') // markdown chars
    .replace(/\n/g, ' ');

  // Keep alphanumeric
  processed = processed.replace(/[^a-zA-Z0-9\s]/g, ' ');

  // Lowercase, split, filter short words, stem
  const words = processed
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .map(stem);

  // Also keep original words (without stemming) for exact matches
  const original = processed
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);

  return [...new Set([...words, ...original])];
}

// ============================================================================
// BM25 Index
// ============================================================================

export type TokenizerType = 'code' | 'docs';

/**
 * Build BM25 index from documents
 */
export function buildIndex(
  docs: { id: number; content: string }[],
  tokenizer: TokenizerType = 'code'
): BM25Index {
  const tokenizeFn = tokenizer === 'code' ? tokenizeCode : tokenizeDocs;
  const invertedIndex = new Map<string, Map<number, number>>();
  const docLengths = new Map<number, number>();
  const rawContent = new Map<number, string>();
  let totalLength = 0;

  for (const doc of docs) {
    const tokens = tokenizeFn(doc.content);
    docLengths.set(doc.id, tokens.length);
    rawContent.set(doc.id, doc.content.toLowerCase());
    totalLength += tokens.length;

    const termFreq = new Map<string, number>();
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
    }

    for (const [term, freq] of termFreq) {
      if (!invertedIndex.has(term)) {
        invertedIndex.set(term, new Map());
      }
      invertedIndex.get(term)!.set(doc.id, freq);
    }
  }

  return {
    invertedIndex,
    docLengths,
    avgDocLength: docs.length > 0 ? totalLength / docs.length : 0,
    totalDocs: docs.length,
    rawContent,
  };
}

/**
 * Add single document to existing index
 */
export function addToIndex(
  index: BM25Index,
  doc: { id: number; content: string },
  tokenizer: TokenizerType = 'code'
): void {
  const tokenizeFn = tokenizer === 'code' ? tokenizeCode : tokenizeDocs;
  const tokens = tokenizeFn(doc.content);

  // Update avg doc length
  const oldTotal = index.avgDocLength * index.totalDocs;
  index.totalDocs += 1;
  index.avgDocLength = (oldTotal + tokens.length) / index.totalDocs;

  index.docLengths.set(doc.id, tokens.length);
  index.rawContent.set(doc.id, doc.content.toLowerCase());

  const termFreq = new Map<string, number>();
  for (const token of tokens) {
    termFreq.set(token, (termFreq.get(token) || 0) + 1);
  }

  for (const [term, freq] of termFreq) {
    if (!index.invertedIndex.has(term)) {
      index.invertedIndex.set(term, new Map());
    }
    index.invertedIndex.get(term)!.set(doc.id, freq);
  }
}

/**
 * Remove document from index
 */
export function removeFromIndex(index: BM25Index, docId: number): void {
  const docLength = index.docLengths.get(docId);
  if (docLength === undefined) return;

  // Update avg doc length
  const oldTotal = index.avgDocLength * index.totalDocs;
  index.totalDocs -= 1;
  index.avgDocLength = index.totalDocs > 0 ? (oldTotal - docLength) / index.totalDocs : 0;

  index.docLengths.delete(docId);
  index.rawContent.delete(docId);

  // Remove from inverted index
  for (const [, docsMap] of index.invertedIndex) {
    docsMap.delete(docId);
  }
}

// ============================================================================
// Search
// ============================================================================

/**
 * IDF with smoothing
 */
function idf(term: string, index: BM25Index): number {
  const docsWithTerm = index.invertedIndex.get(term)?.size || 0;
  if (docsWithTerm === 0) return 0;
  return Math.log((index.totalDocs - docsWithTerm + 0.5) / (docsWithTerm + 0.5) + 1);
}

/**
 * Check if query looks like an identifier (for exact match boost)
 */
function isIdentifierLike(query: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(query.trim()) && query.trim().length > 2 && !query.includes(' ');
}

/**
 * BM25 search with exact match boost
 */
export function search(
  query: string,
  index: BM25Index,
  tokenizer: TokenizerType = 'code',
  limit: number = 10
): BM25Result[] {
  const tokenizeFn = tokenizer === 'code' ? tokenizeCode : tokenizeDocs;
  const queryTokens = tokenizeFn(query);
  const scores = new Map<number, number>();
  const queryLower = query.toLowerCase().trim();
  const isIdentifier = isIdentifierLike(query);

  // BM25 scoring
  for (const token of queryTokens) {
    const termIdf = idf(token, index);
    const docsWithTerm = index.invertedIndex.get(token);
    if (!docsWithTerm) continue;

    for (const [docId, termFreq] of docsWithTerm) {
      const docLength = index.docLengths.get(docId) || 0;
      const numerator = termFreq * (K1 + 1);
      const denominator = termFreq + K1 * (1 - B + B * (docLength / index.avgDocLength));
      const termScore = termIdf * (numerator / denominator);
      scores.set(docId, (scores.get(docId) || 0) + termScore);
    }
  }

  // Exact match boost (critical for identifier search)
  if (isIdentifier && tokenizer === 'code') {
    for (const [docId, content] of index.rawContent) {
      if (content.includes(queryLower)) {
        const currentScore = scores.get(docId) || 0;
        // Boost: 2x for contains, 3x for word boundary match
        const wordBoundary = new RegExp(`\\b${escapeRegex(queryLower)}\\b`);
        const boost = wordBoundary.test(content) ? 3.0 : 2.0;
        scores.set(docId, currentScore * boost + 5); // +5 base boost
      }
    }
  }

  return Array.from(scores.entries())
    .map(([docId, score]) => ({ docId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// Hybrid Search (RRF)
// ============================================================================

/**
 * Reciprocal Rank Fusion - combines BM25 and vector search results
 * Formula: RRF(d) = Σ 1/(k + rank(d))
 *
 * @param bm25Results - Results from BM25 search
 * @param vectorResults - Results from vector search
 * @param alpha - Weight: 0 = pure BM25, 1 = pure vector, 0.5 = equal
 * @param limit - Max results to return
 */
export function reciprocalRankFusion(
  bm25Results: BM25Result[],
  vectorResults: BM25Result[],
  alpha: number = 0.5,
  limit: number = 10
): BM25Result[] {
  const combined = new Map<number, number>();

  // BM25 contribution (weighted by 1-alpha)
  bm25Results.forEach((r, rank) => {
    const rrfScore = (1 - alpha) / (RRF_K + rank + 1);
    combined.set(r.docId, (combined.get(r.docId) || 0) + rrfScore);
  });

  // Vector contribution (weighted by alpha)
  vectorResults.forEach((r, rank) => {
    const rrfScore = alpha / (RRF_K + rank + 1);
    combined.set(r.docId, (combined.get(r.docId) || 0) + rrfScore);
  });

  return Array.from(combined.entries())
    .map(([docId, score]) => ({ docId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ============================================================================
// Serialization (for SQLite storage)
// ============================================================================

interface SerializedIndex {
  invertedIndex: [string, [number, number][]][];
  docLengths: [number, number][];
  rawContent: [number, string][];
  avgDocLength: number;
  totalDocs: number;
}

/**
 * Serialize index for storage in SQLite
 */
export function serializeIndex(index: BM25Index): string {
  const data: SerializedIndex = {
    invertedIndex: Array.from(index.invertedIndex.entries()).map(([term, docs]) => [
      term,
      Array.from(docs.entries()),
    ]),
    docLengths: Array.from(index.docLengths.entries()),
    rawContent: Array.from(index.rawContent.entries()),
    avgDocLength: index.avgDocLength,
    totalDocs: index.totalDocs,
  };
  return JSON.stringify(data);
}

/**
 * Deserialize index from SQLite
 */
export function deserializeIndex(data: string): BM25Index {
  const p: SerializedIndex = JSON.parse(data);
  return {
    invertedIndex: new Map(p.invertedIndex.map(([t, d]) => [t, new Map(d)])),
    docLengths: new Map(p.docLengths),
    rawContent: new Map(p.rawContent),
    avgDocLength: p.avgDocLength,
    totalDocs: p.totalDocs,
  };
}

/**
 * Create empty index
 */
export function createEmptyIndex(): BM25Index {
  return {
    invertedIndex: new Map(),
    docLengths: new Map(),
    rawContent: new Map(),
    avgDocLength: 0,
    totalDocs: 0,
  };
}

// ============================================================================
// Ronin-style Word Segmentation (for flatcase identifiers)
// ============================================================================

/**
 * Check if a word looks like flatcase (all lowercase, no separators)
 */
export function isFlatcase(word: string): boolean {
  // Must be lowercase, only letters, length > 3 (to avoid false positives)
  return /^[a-z]{4,}$/.test(word);
}

/**
 * Ronin-style DP segmentation for flatcase identifiers.
 * Uses token frequencies from indexed code to find optimal split.
 *
 * Algorithm (based on Peter Norvig's word segmentation):
 * - For each position, try all possible splits
 * - Score = sum of log(frequency) for each token
 * - Prefer longer tokens (reward = log(freq) * sqrt(length))
 * - Use DP to find globally optimal segmentation
 *
 * @param word - The flatcase word to segment (e.g., "getusername")
 * @param getFrequency - Function to get token frequency from DB
 * @param totalTokens - Total token count for probability calculation
 * @param minTokenLength - Minimum token length (default: 2)
 * @returns Array of tokens (e.g., ["get", "user", "name"])
 */
export function segmentFlatcase(
  word: string,
  getFrequency: (token: string) => number,
  totalTokens: number,
  minTokenLength: number = 2
): string[] {
  const n = word.length;
  if (n <= minTokenLength) return [word];

  // DP arrays
  // bestScore[i] = best score for segmenting word[0:i]
  // bestSplit[i] = position of last split for word[0:i]
  const bestScore: number[] = new Array(n + 1).fill(-Infinity);
  const bestSplit: number[] = new Array(n + 1).fill(0);
  bestScore[0] = 0;

  // Small constant for unknown tokens (prevents -Infinity)
  const unknownScore = Math.log10(0.1 / Math.max(totalTokens, 1));

  for (let i = 1; i <= n; i++) {
    // Try all possible last tokens ending at position i
    for (let j = Math.max(0, i - 15); j < i; j++) {
      // Max token length 15
      const tokenLen = i - j;
      if (tokenLen < minTokenLength) continue;

      const token = word.slice(j, i);
      const freq = getFrequency(token);

      // Score: log probability with length bonus
      // Longer known tokens get higher scores
      let tokenScore: number;
      if (freq > 0) {
        // Known token: log(freq/total) + length bonus
        const prob = freq / Math.max(totalTokens, 1);
        tokenScore = Math.log10(prob) + Math.sqrt(tokenLen) * 0.5;
      } else {
        // Unknown token: penalize, but less for longer tokens
        tokenScore = unknownScore - (15 - tokenLen) * 0.1;
      }

      const totalScore = bestScore[j] + tokenScore;
      if (totalScore > bestScore[i]) {
        bestScore[i] = totalScore;
        bestSplit[i] = j;
      }
    }
  }

  // Backtrack to find the optimal segmentation
  const tokens: string[] = [];
  let pos = n;
  while (pos > 0) {
    const splitPos = bestSplit[pos];
    tokens.unshift(word.slice(splitPos, pos));
    pos = splitPos;
  }

  return tokens;
}

/**
 * Enhanced tokenizeCode that handles flatcase using Ronin-style segmentation.
 * This version accepts a frequency lookup function for dynamic segmentation.
 *
 * @param text - The text to tokenize
 * @param getFrequency - Optional function to get token frequency (for flatcase segmentation)
 * @param totalTokens - Optional total token count
 */
export function tokenizeCodeWithSegmentation(
  text: string,
  getFrequency?: (token: string) => number,
  totalTokens?: number
): string[] {
  // First, apply standard tokenization rules
  const standardTokens = tokenizeCode(text);

  // If no frequency function provided, return standard tokens
  if (!getFrequency || !totalTokens || totalTokens === 0) {
    return standardTokens;
  }

  // Process each token - if it looks like flatcase, try to segment it
  const result: string[] = [];
  const seen = new Set<string>();

  for (const token of standardTokens) {
    if (seen.has(token)) continue;
    seen.add(token);

    if (isFlatcase(token) && token.length >= 6) {
      // Try to segment flatcase
      const segments = segmentFlatcase(token, getFrequency, totalTokens);

      // Only use segmentation if it found meaningful splits
      if (segments.length > 1 && segments.every((s) => s.length >= 2)) {
        for (const seg of segments) {
          if (!seen.has(seg)) {
            result.push(seg);
            seen.add(seg);
          }
        }
        // Also keep original for exact match
        result.push(token);
      } else {
        result.push(token);
      }
    } else {
      result.push(token);
    }
  }

  return result;
}
