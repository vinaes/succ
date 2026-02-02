/**
 * Benchmark Metrics Library
 *
 * Provides standard IR (Information Retrieval) metrics for evaluating
 * succ's search and memory recall quality:
 * - Recall@K: What fraction of relevant items were retrieved in top K
 * - MRR (Mean Reciprocal Rank): Average of reciprocal ranks of first relevant result
 * - NDCG (Normalized Discounted Cumulative Gain): Measures ranking quality
 * - Latency metrics: Embedding time, search time, full pipeline time
 */

// ============================================================================
// Types
// ============================================================================

export interface BenchmarkQuery {
  /** The search query */
  query: string;
  /** IDs of relevant items (ground truth) */
  relevantIds: number[];
  /** Optional: relevance scores (for NDCG), default all 1.0 */
  relevanceScores?: Map<number, number>;
}

export interface SearchResult {
  id: number;
  score: number;
}

export interface AccuracyMetrics {
  /** Recall@K: fraction of relevant items in top K (0-1) */
  recallAtK: number;
  /** K value used for Recall@K */
  k: number;
  /** Mean Reciprocal Rank (0-1) */
  mrr: number;
  /** Normalized Discounted Cumulative Gain (0-1) */
  ndcg: number;
  /** Total queries evaluated */
  queryCount: number;
  /** Queries with at least one hit */
  queriesWithHits: number;
}

export interface LatencyMetrics {
  /** Embedding generation time (ms) */
  embedding: LatencyStats;
  /** Database search time (ms) */
  search: LatencyStats;
  /** Full pipeline time: embedding + search (ms) */
  pipeline: LatencyStats;
}

export interface LatencyStats {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  samples: number;
}

export interface BenchmarkResults {
  accuracy: AccuracyMetrics;
  latency: LatencyMetrics;
  timestamp: string;
  config: {
    embeddingModel: string;
    embeddingMode: string;
    totalMemories: number;
    testQueries: number;
  };
}

// ============================================================================
// Accuracy Metrics
// ============================================================================

/**
 * Calculate Recall@K
 *
 * What fraction of relevant items appear in the top K results?
 * Recall@K = |relevant ∩ retrieved@K| / |relevant|
 *
 * @param results - Ranked search results (ordered by score desc)
 * @param relevantIds - Set of relevant item IDs (ground truth)
 * @param k - Number of top results to consider
 */
export function recallAtK(results: SearchResult[], relevantIds: Set<number>, k: number): number {
  if (relevantIds.size === 0) return 0;

  const topK = results.slice(0, k);
  const retrievedRelevant = topK.filter((r) => relevantIds.has(r.id)).length;

  return retrievedRelevant / relevantIds.size;
}

/**
 * Calculate Reciprocal Rank
 *
 * RR = 1 / rank of first relevant result
 * Returns 0 if no relevant result found
 *
 * @param results - Ranked search results
 * @param relevantIds - Set of relevant item IDs
 */
export function reciprocalRank(results: SearchResult[], relevantIds: Set<number>): number {
  for (let i = 0; i < results.length; i++) {
    if (relevantIds.has(results[i].id)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Calculate Mean Reciprocal Rank across multiple queries
 *
 * MRR = (1/|Q|) * Σ RR(q) for each query q
 *
 * @param queries - Array of benchmark queries with results
 */
export function meanReciprocalRank(
  queries: Array<{ results: SearchResult[]; relevantIds: Set<number> }>
): number {
  if (queries.length === 0) return 0;

  const sumRR = queries.reduce((sum, q) => sum + reciprocalRank(q.results, q.relevantIds), 0);

  return sumRR / queries.length;
}

/**
 * Calculate DCG (Discounted Cumulative Gain)
 *
 * DCG@K = Σ (2^rel(i) - 1) / log2(i + 1) for i = 1 to K
 *
 * @param results - Ranked search results
 * @param relevanceScores - Map of item ID to relevance score (default 1.0 for relevant)
 * @param k - Number of results to consider
 */
export function dcg(
  results: SearchResult[],
  relevanceScores: Map<number, number>,
  k: number
): number {
  let dcgScore = 0;

  for (let i = 0; i < Math.min(k, results.length); i++) {
    const rel = relevanceScores.get(results[i].id) ?? 0;
    // Using the standard DCG formula: (2^rel - 1) / log2(rank + 1)
    dcgScore += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }

  return dcgScore;
}

/**
 * Calculate NDCG (Normalized DCG)
 *
 * NDCG@K = DCG@K / IDCG@K
 * where IDCG is the ideal DCG (perfect ranking)
 *
 * @param results - Ranked search results
 * @param relevanceScores - Map of item ID to relevance score
 * @param k - Number of results to consider
 */
export function ndcg(
  results: SearchResult[],
  relevanceScores: Map<number, number>,
  k: number
): number {
  // Calculate actual DCG
  const actualDcg = dcg(results, relevanceScores, k);

  // Calculate ideal DCG (perfect ranking)
  // Sort all relevance scores descending to get ideal order
  const idealRanking = [...relevanceScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id, score]) => ({ id, score }));

  const idealDcg = dcg(idealRanking, relevanceScores, k);

  if (idealDcg === 0) return 0;
  return actualDcg / idealDcg;
}

/**
 * Calculate all accuracy metrics for a set of queries
 */
export function calculateAccuracyMetrics(
  queries: Array<{
    results: SearchResult[];
    relevantIds: Set<number>;
    relevanceScores?: Map<number, number>;
  }>,
  k: number = 5
): AccuracyMetrics {
  if (queries.length === 0) {
    return {
      recallAtK: 0,
      k,
      mrr: 0,
      ndcg: 0,
      queryCount: 0,
      queriesWithHits: 0,
    };
  }

  let totalRecall = 0;
  let totalNdcg = 0;
  let queriesWithHits = 0;

  for (const q of queries) {
    // For relevance scores, use provided or default to 1.0 for all relevant items
    const relScores =
      q.relevanceScores ?? new Map([...q.relevantIds].map((id) => [id, 1.0]));

    totalRecall += recallAtK(q.results, q.relevantIds, k);
    totalNdcg += ndcg(q.results, relScores, k);

    // Check if any relevant item was found
    if (q.results.some((r) => q.relevantIds.has(r.id))) {
      queriesWithHits++;
    }
  }

  return {
    recallAtK: totalRecall / queries.length,
    k,
    mrr: meanReciprocalRank(queries),
    ndcg: totalNdcg / queries.length,
    queryCount: queries.length,
    queriesWithHits,
  };
}

// ============================================================================
// Latency Metrics
// ============================================================================

/**
 * Calculate latency statistics from an array of measurements
 */
export function calculateLatencyStats(measurements: number[]): LatencyStats {
  if (measurements.length === 0) {
    return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0, samples: 0 };
  }

  const sorted = [...measurements].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    samples: sorted.length,
  };
}

/**
 * Calculate percentile from sorted array
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] * (upper - index) + sorted[upper] * (index - lower);
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format accuracy metrics as human-readable string
 */
export function formatAccuracyMetrics(metrics: AccuracyMetrics): string {
  const lines = [
    '┌─────────────────────────────────────────┐',
    '│         Accuracy Metrics                │',
    '├─────────────────────────────────────────┤',
    `│ Recall@${metrics.k}:    ${(metrics.recallAtK * 100).toFixed(1).padStart(6)}%              │`,
    `│ MRR:         ${(metrics.mrr * 100).toFixed(1).padStart(6)}%              │`,
    `│ NDCG@${metrics.k}:     ${(metrics.ndcg * 100).toFixed(1).padStart(6)}%              │`,
    '├─────────────────────────────────────────┤',
    `│ Queries:     ${metrics.queryCount.toString().padStart(6)}               │`,
    `│ With hits:   ${metrics.queriesWithHits.toString().padStart(6)} (${((metrics.queriesWithHits / Math.max(metrics.queryCount, 1)) * 100).toFixed(0)}%)          │`,
    '└─────────────────────────────────────────┘',
  ];
  return lines.join('\n');
}

/**
 * Format latency stats as human-readable string
 */
export function formatLatencyStats(stats: LatencyStats, name: string): string {
  return `${name.padEnd(12)} │ ${stats.avg.toFixed(1).padStart(7)}ms │ ${stats.p50.toFixed(1).padStart(7)}ms │ ${stats.p95.toFixed(1).padStart(7)}ms │ ${stats.p99.toFixed(1).padStart(7)}ms │`;
}

/**
 * Format latency metrics as human-readable string
 */
export function formatLatencyMetrics(metrics: LatencyMetrics): string {
  const lines = [
    '┌─────────────────────────────────────────────────────────────────┐',
    '│                     Latency Metrics                            │',
    '├──────────────┬─────────┬─────────┬─────────┬─────────┤',
    '│ Operation    │   Avg   │   P50   │   P95   │   P99   │',
    '├──────────────┼─────────┼─────────┼─────────┼─────────┤',
    `│ ${formatLatencyStats(metrics.embedding, 'Embedding')}`,
    `│ ${formatLatencyStats(metrics.search, 'Search')}`,
    `│ ${formatLatencyStats(metrics.pipeline, 'Pipeline')}`,
    '└──────────────┴─────────┴─────────┴─────────┴─────────┘',
  ];
  return lines.join('\n');
}

/**
 * Format full benchmark results
 */
export function formatBenchmarkResults(results: BenchmarkResults): string {
  const lines = [
    '═══════════════════════════════════════════════════════════════════',
    '                      SUCC BENCHMARK RESULTS                       ',
    '═══════════════════════════════════════════════════════════════════',
    '',
    `Timestamp: ${results.timestamp}`,
    `Model: ${results.config.embeddingModel} (${results.config.embeddingMode})`,
    `Memories: ${results.config.totalMemories}`,
    `Test queries: ${results.config.testQueries}`,
    '',
    formatAccuracyMetrics(results.accuracy),
    '',
    formatLatencyMetrics(results.latency),
    '',
    '═══════════════════════════════════════════════════════════════════',
  ];
  return lines.join('\n');
}

// ============================================================================
// Test Dataset Generation
// ============================================================================

export interface TestDataset {
  memories: Array<{
    content: string;
    tags: string[];
    category: string;
  }>;
  queries: BenchmarkQuery[];
}

/**
 * Generate a synthetic test dataset for benchmarking.
 * Uses diverse topics with known relationships for ground truth.
 */
export function generateTestDataset(): TestDataset {
  // Categories with related content
  const categories = {
    typescript: [
      { content: 'TypeScript is a strongly typed programming language that builds on JavaScript', tags: ['typescript', 'programming', 'language'] },
      { content: 'TypeScript interfaces define the shape of objects with type checking', tags: ['typescript', 'interfaces', 'types'] },
      { content: 'TypeScript generics allow creating reusable components with type safety', tags: ['typescript', 'generics', 'reusable'] },
      { content: 'TypeScript decorators are a stage 2 proposal for JavaScript', tags: ['typescript', 'decorators', 'metadata'] },
    ],
    react: [
      { content: 'React is a JavaScript library for building user interfaces', tags: ['react', 'frontend', 'ui'] },
      { content: 'React hooks like useState and useEffect manage component state and side effects', tags: ['react', 'hooks', 'state'] },
      { content: 'React components can be functional or class-based', tags: ['react', 'components', 'functional'] },
      { content: 'React context provides a way to pass data through the component tree', tags: ['react', 'context', 'state'] },
    ],
    database: [
      { content: 'PostgreSQL is a powerful open source relational database', tags: ['database', 'postgresql', 'sql'] },
      { content: 'SQLite is a self-contained, serverless SQL database engine', tags: ['database', 'sqlite', 'embedded'] },
      { content: 'Database indexes improve query performance by creating sorted references', tags: ['database', 'indexes', 'performance'] },
      { content: 'Database transactions ensure ACID properties for data integrity', tags: ['database', 'transactions', 'acid'] },
    ],
    devops: [
      { content: 'Docker containers package software into standardized units', tags: ['docker', 'containers', 'devops'] },
      { content: 'Kubernetes orchestrates containerized applications at scale', tags: ['kubernetes', 'orchestration', 'devops'] },
      { content: 'CI/CD pipelines automate building, testing, and deploying code', tags: ['cicd', 'automation', 'devops'] },
      { content: 'Infrastructure as Code defines infrastructure using configuration files', tags: ['iac', 'terraform', 'devops'] },
    ],
    architecture: [
      { content: 'Microservices architecture splits applications into small, independent services', tags: ['microservices', 'architecture', 'distributed'] },
      { content: 'Event-driven architecture uses events to trigger and communicate between services', tags: ['events', 'architecture', 'async'] },
      { content: 'Domain-Driven Design focuses on the core domain and domain logic', tags: ['ddd', 'architecture', 'domain'] },
      { content: 'Clean Architecture separates concerns into layers with dependency rules', tags: ['clean', 'architecture', 'layers'] },
    ],
  };

  // Flatten memories with category info
  const memories: TestDataset['memories'] = [];
  let idCounter = 1;
  const categoryIds: Record<string, number[]> = {};

  for (const [category, items] of Object.entries(categories)) {
    categoryIds[category] = [];
    for (const item of items) {
      memories.push({ ...item, category });
      categoryIds[category].push(idCounter);
      idCounter++;
    }
  }

  // Generate queries with ground truth
  const queries: BenchmarkQuery[] = [
    // TypeScript queries
    { query: 'strongly typed javascript superset language', relevantIds: categoryIds.typescript },
    { query: 'type checking and interfaces in code', relevantIds: categoryIds.typescript },

    // React queries
    { query: 'UI component library for frontend', relevantIds: categoryIds.react },
    { query: 'managing state in functional components', relevantIds: categoryIds.react },

    // Database queries
    { query: 'SQL relational database open source', relevantIds: categoryIds.database },
    { query: 'query performance optimization indexes', relevantIds: categoryIds.database },

    // DevOps queries
    { query: 'container orchestration deployment', relevantIds: [...categoryIds.devops] },
    { query: 'automate build test deploy pipeline', relevantIds: categoryIds.devops },

    // Architecture queries
    { query: 'distributed services communication patterns', relevantIds: categoryIds.architecture },
    { query: 'domain logic separation layers', relevantIds: categoryIds.architecture },

    // Cross-category queries
    { query: 'building scalable web applications', relevantIds: [...categoryIds.react, ...categoryIds.architecture] },
    { query: 'data storage and retrieval systems', relevantIds: categoryIds.database },
  ];

  return { memories, queries };
}
