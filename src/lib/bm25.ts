/**
 * BM25 + Hybrid Search
 *
 * Two modes:
 * - Code search: exact tokenizer for identifiers (camelCase, snake_case)
 * - Docs search: stemming for natural language
 *
 * Features:
 * - RRF (Reciprocal Rank Fusion) for combining results
 * - k1=1.3, b=0.75 - optimal BM25 parameters
 * - Exact match boost for identifier searches
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
 * Enrich BM25 tokens with AST-derived identifiers.
 * AST identifiers are boosted by repeating them (doubles their TF score).
 * Symbol names are tokenized through the same pipeline for consistency.
 */
export function tokenizeCodeWithAST(
  text: string,
  astIdentifiers: string[],
  symbolName?: string
): string[] {
  const baseTokens = tokenizeCode(text);

  // Tokenize and boost AST identifiers
  const astTokens: string[] = [];
  for (const id of astIdentifiers) {
    // Apply same tokenization as code tokens
    const subTokens = tokenizeCode(id);
    astTokens.push(...subTokens);
    // Also keep the original identifier for exact match
    if (id.length > 1) astTokens.push(id.toLowerCase());
  }

  // Symbol name gets extra boost (3x: once from content, twice here)
  if (symbolName) {
    const nameTokens = tokenizeCode(symbolName);
    astTokens.push(...nameTokens, ...nameTokens);
  }

  // Intentionally no dedup — repeated AST tokens boost their TF score in BM25
  return [...baseTokens, ...astTokens];
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

/** Document with optional AST metadata for BM25 indexing */
export interface BM25Doc {
  id: number;
  content: string;
  symbolName?: string;
  signature?: string;
}

/**
 * Build BM25 index from documents.
 * For code documents with AST metadata, uses tokenizeCodeWithAST for TF boost.
 */
export function buildIndex(docs: BM25Doc[], tokenizer: TokenizerType = 'code'): BM25Index {
  const invertedIndex = new Map<string, Map<number, number>>();
  const docLengths = new Map<number, number>();
  const rawContent = new Map<number, string>();
  let totalLength = 0;

  // Only store rawContent for code indexes (used for exact match boost).
  // Docs/memories indexes never use rawContent — saves ~2x memory and serialization size.
  const storeRawContent = tokenizer === 'code';

  for (const doc of docs) {
    // Use AST-enriched tokenizer when metadata is available (code search)
    let tokens: string[];
    if (tokenizer === 'code' && (doc.symbolName || doc.signature)) {
      const sigTokens = doc.signature ? tokenizeCode(doc.signature) : [];
      tokens = tokenizeCodeWithAST(doc.content, sigTokens, doc.symbolName);
    } else {
      const tokenizeFn = tokenizer === 'code' ? tokenizeCode : tokenizeDocs;
      tokens = tokenizeFn(doc.content);
    }

    docLengths.set(doc.id, tokens.length);
    if (storeRawContent) rawContent.set(doc.id, doc.content.toLowerCase());
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
 * Add single document to existing index.
 * For code documents with AST metadata, uses tokenizeCodeWithAST for TF boost.
 */
export function addToIndex(
  index: BM25Index,
  doc: BM25Doc,
  tokenizer: TokenizerType = 'code'
): void {
  // Use AST-enriched tokenizer when metadata is available
  let tokens: string[];
  if (tokenizer === 'code' && (doc.symbolName || doc.signature)) {
    const sigTokens = doc.signature ? tokenizeCode(doc.signature) : [];
    tokens = tokenizeCodeWithAST(doc.content, sigTokens, doc.symbolName);
  } else {
    const tokenizeFn = tokenizer === 'code' ? tokenizeCode : tokenizeDocs;
    tokens = tokenizeFn(doc.content);
  }

  // Update avg doc length
  const oldTotal = index.avgDocLength * index.totalDocs;
  index.totalDocs += 1;
  index.avgDocLength = (oldTotal + tokens.length) / index.totalDocs;

  index.docLengths.set(doc.id, tokens.length);
  // Only store rawContent for code indexes (exact match boost)
  if (tokenizer === 'code') index.rawContent.set(doc.id, doc.content.toLowerCase());

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
  return (
    /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(query.trim()) && query.trim().length > 2 && !query.includes(' ')
  );
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
 * Base dictionary of common programming terms.
 * Used as fallback when token frequencies are low.
 * Frequencies are approximate based on typical codebases.
 */
const BASE_CODE_DICTIONARY: Record<string, number> = {
  // Actions
  get: 500,
  set: 400,
  add: 300,
  remove: 250,
  delete: 200,
  create: 200,
  update: 200,
  find: 150,
  fetch: 150,
  load: 150,
  save: 150,
  read: 150,
  write: 150,
  parse: 100,
  init: 100,
  start: 100,
  stop: 100,
  run: 100,
  execute: 80,
  handle: 100,
  process: 100,
  check: 100,
  validate: 80,
  format: 80,
  convert: 80,
  transform: 80,
  build: 100,
  render: 100,
  display: 80,
  show: 80,
  hide: 80,
  open: 80,
  close: 80,
  connect: 80,
  send: 80,
  receive: 60,
  emit: 60,
  listen: 60,
  subscribe: 60,
  publish: 60,

  // Nouns
  user: 200,
  name: 200,
  data: 300,
  file: 300,
  path: 300,
  config: 200,
  error: 250,
  request: 200,
  response: 200,
  result: 150,
  value: 250,
  key: 200,
  index: 200,
  list: 150,
  array: 150,
  map: 150,
  object: 200,
  string: 300,
  number: 200,
  type: 200,
  id: 300,
  code: 150,
  text: 150,
  content: 200,
  message: 150,
  event: 150,
  state: 150,
  status: 100,
  context: 100,
  options: 100,
  params: 100,
  args: 100,
  callback: 100,
  handler: 150,
  listener: 100,
  component: 150,
  element: 100,
  node: 100,
  item: 150,
  entry: 100,
  record: 100,
  row: 100,
  column: 80,
  field: 100,
  token: 100,
  buffer: 80,
  stream: 80,
  chunk: 80,
  batch: 80,
  queue: 80,
  stack: 80,
  cache: 100,
  store: 100,
  db: 150,
  database: 100,
  table: 100,
  query: 150,
  url: 150,
  uri: 80,
  api: 150,
  http: 100,
  json: 150,
  xml: 80,
  html: 100,
  css: 80,
  server: 100,
  client: 100,
  socket: 80,
  port: 80,
  host: 80,
  endpoint: 80,

  // Modifiers
  async: 200,
  sync: 80,
  local: 100,
  global: 100,
  public: 80,
  private: 80,
  static: 80,
  final: 60,
  default: 150,
  custom: 80,
  new: 150,
  old: 80,
  first: 100,
  last: 100,
  next: 100,
  prev: 80,
  current: 100,
  all: 150,
  single: 80,
  multi: 80,
  max: 100,
  min: 100,
  total: 100,
  count: 150,
  is: 200,
  has: 150,
  can: 100,
  should: 80,
  will: 80,
  did: 60,

  // Common suffixes/prefixes as words
  by: 150,
  to: 200,
  from: 200,
  with: 200,
  for: 250,
  of: 200,
  on: 150,
  in: 150,
  at: 100,
  or: 100,
  and: 150,
  not: 100,
  if: 250,
  else: 150,
  then: 80,
};

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
// LRU cache for segmentation results (DP is expensive per token)
const segmentationCache = new Map<string, string[]>();
const SEGMENTATION_CACHE_MAX = 2000;

export function segmentFlatcase(
  word: string,
  getFrequency: (token: string) => number,
  totalTokens: number,
  minTokenLength: number = 2
): string[] {
  const n = word.length;
  if (n <= minTokenLength) return [word];

  // Check cache (keyed on word + totalTokens to detect corpus changes)
  const cacheKey = `${word}:${totalTokens}`;
  const cached = segmentationCache.get(cacheKey);
  if (cached) return cached;

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
      let freq = getFrequency(token);

      // Fallback to base dictionary if token not found in indexed code
      // Scale base dictionary frequencies to match indexed corpus
      if (freq === 0 && BASE_CODE_DICTIONARY[token]) {
        // Scale: if total is 34000 and base dict max is 500, scale by ~68
        const scaleFactor = Math.max(1, totalTokens / 5000);
        freq = BASE_CODE_DICTIONARY[token] * scaleFactor;
      }

      // Score: log probability with length bonus
      // But penalize long flatcase tokens that look like compounds
      let tokenScore: number;
      if (freq > 0) {
        // Known token: log(freq/total) + length bonus
        const prob = freq / Math.max(totalTokens, 1);
        tokenScore = Math.log10(prob);

        // Length bonus only for tokens <= 8 chars
        // Longer flatcase tokens are likely compounds and should be split
        if (tokenLen <= 8) {
          tokenScore += Math.sqrt(tokenLen) * 0.5;
        } else {
          // Penalize long flatcase tokens to encourage splitting
          tokenScore -= (tokenLen - 8) * 0.3;
        }
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

  // Cache result (LRU eviction)
  if (segmentationCache.size >= SEGMENTATION_CACHE_MAX) {
    const firstKey = segmentationCache.keys().next().value;
    if (firstKey) segmentationCache.delete(firstKey);
  }
  segmentationCache.set(cacheKey, tokens);

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
