/**
 * Retrieval Quality Benchmark — measure and track search quality over time.
 *
 * Uses existing project memories/code as test corpus with tag-based ground truth.
 * Generates diverse query sets, runs through hybrid search pipeline, computes
 * MRR@10, Recall@20, NDCG@10, and latency P50/P95.
 *
 * Saves baselines as JSON for regression detection across improvements.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getEmbedding } from '../embeddings.js';
import { getSuccDir } from '../config.js';
import {
  calculateAccuracyMetrics,
  calculateLatencyStats,
  type AccuracyMetrics,
  type LatencyStats,
  type SearchResult as BenchmarkSearchResult,
} from '../benchmark.js';
import { logWarn, logInfo } from '../fault-logger.js';
import { getErrorMessage } from '../errors.js';

// ============================================================================
// Types
// ============================================================================

export interface RetrievalBenchmarkConfig {
  /** K for Recall@K, Precision@K, and NDCG@K (default: 10) */
  k?: number;
  /** Number of search results to retrieve per query (default: 20) */
  retrievalLimit?: number;
  /** Minimum similarity threshold (default: 0.2) */
  threshold?: number;
}

export interface RetrievalBenchmarkResult {
  accuracy: AccuracyMetrics;
  latency: {
    embedding: LatencyStats;
    search: LatencyStats;
    pipeline: LatencyStats;
  };
  queryBreakdown: Array<{
    query: string;
    category: string;
    mrr: number;
    recall: number;
    latencyMs: number;
    hitsInTopK: number;
    totalRelevant: number;
  }>;
  metadata: {
    timestamp: string;
    totalQueries: number;
    totalMemories: number;
    config: RetrievalBenchmarkConfig;
  };
}

export interface BaselineComparison {
  current: RetrievalBenchmarkResult;
  baseline: RetrievalBenchmarkResult | null;
  regressions: Array<{
    metric: string;
    baseline: number;
    current: number;
    delta: number;
    deltaPct: number;
  }>;
  improvements: Array<{
    metric: string;
    baseline: number;
    current: number;
    delta: number;
    deltaPct: number;
  }>;
}

// ============================================================================
// Query Generation
// ============================================================================

/** Built-in diverse query set covering different retrieval scenarios */
export const BENCHMARK_QUERIES: Array<{ query: string; category: string; tags: string[] }> = [
  // Symbol lookup (exact match, BM25-dominant)
  { query: 'getEmbedding function', category: 'symbol', tags: ['embedding', 'search'] },
  { query: 'saveMemory implementation', category: 'symbol', tags: ['memory', 'storage'] },
  { query: 'hybridSearchMemories', category: 'symbol', tags: ['search', 'memory'] },
  { query: 'callLLM function', category: 'symbol', tags: ['llm'] },
  { query: 'createMemoryLink', category: 'symbol', tags: ['graph', 'link'] },
  { query: 'personalizedPageRank', category: 'symbol', tags: ['graph', 'search'] },
  { query: 'reciprocalRankFusion', category: 'symbol', tags: ['search', 'bm25'] },
  { query: 'scoreMemory quality', category: 'symbol', tags: ['quality'] },
  { query: 'detectInvariant', category: 'symbol', tags: ['memory'] },
  { query: 'sanitizeForContext', category: 'symbol', tags: ['security'] },

  // Natural language (semantic, vector-dominant)
  {
    query: 'how does memory consolidation work',
    category: 'nl-code',
    tags: ['memory', 'consolidation'],
  },
  { query: 'what is the search pipeline flow', category: 'nl-code', tags: ['search'] },
  { query: 'how are embeddings generated and cached', category: 'nl-code', tags: ['embedding'] },
  { query: 'explain the hook system architecture', category: 'nl-code', tags: ['hooks'] },
  {
    query: 'how does the daemon handle sessions',
    category: 'nl-code',
    tags: ['daemon', 'session'],
  },
  {
    query: 'what security checks are performed on input',
    category: 'nl-code',
    tags: ['security', 'injection'],
  },
  {
    query: 'how does temporal decay affect memory ranking',
    category: 'nl-code',
    tags: ['temporal', 'memory'],
  },
  { query: 'explain the knowledge graph structure', category: 'nl-code', tags: ['graph'] },
  {
    query: 'how are MCP tools registered and dispatched',
    category: 'nl-code',
    tags: ['mcp', 'tools'],
  },
  { query: 'what is the working memory pipeline', category: 'nl-code', tags: ['memory'] },

  // Memory recall (temporal + relevance)
  {
    query: 'recent architecture decisions',
    category: 'memory',
    tags: ['decision', 'architecture'],
  },
  { query: 'bugs fixed this week', category: 'memory', tags: ['error', 'fix'] },
  { query: 'performance improvements made', category: 'memory', tags: ['performance'] },
  { query: 'configuration changes', category: 'memory', tags: ['config'] },
  { query: 'security findings and fixes', category: 'memory', tags: ['security'] },
  { query: 'test failures and resolutions', category: 'memory', tags: ['test'] },
  { query: 'database schema changes', category: 'memory', tags: ['schema', 'database'] },
  { query: 'API endpoint modifications', category: 'memory', tags: ['api'] },
  { query: 'dependency updates', category: 'memory', tags: ['dependency'] },
  { query: 'refactoring decisions', category: 'memory', tags: ['refactor'] },

  // Multi-concept (complex, benefits from decomposition)
  {
    query: 'how does BM25 interact with vector search in the RRF fusion pipeline',
    category: 'multi',
    tags: ['bm25', 'search'],
  },
  {
    query: 'memory quality scoring and retention threshold',
    category: 'multi',
    tags: ['quality', 'retention'],
  },
  {
    query: 'graph traversal for PPR and community detection',
    category: 'multi',
    tags: ['graph', 'search'],
  },
  {
    query: 'SQLite storage backend and migration pattern',
    category: 'multi',
    tags: ['storage', 'sqlite'],
  },
  { query: 'embedding model loading and GPU detection', category: 'multi', tags: ['embedding'] },

  // Cross-type (memory about code, code implementing decisions)
  {
    query: 'why was the storage dispatcher pattern chosen',
    category: 'cross',
    tags: ['storage', 'decision'],
  },
  {
    query: 'what led to the hook architecture refactor',
    category: 'cross',
    tags: ['hooks', 'refactor'],
  },
  {
    query: 'reasoning behind config-gating expensive features',
    category: 'cross',
    tags: ['config'],
  },
  {
    query: 'decision to use tree-sitter for AST parsing',
    category: 'cross',
    tags: ['tree-sitter', 'decision'],
  },
  {
    query: 'why onnxruntime-node over transformers.js',
    category: 'cross',
    tags: ['embedding', 'decision'],
  },
];

// ============================================================================
// Benchmark Runner
// ============================================================================

/**
 * Run the retrieval quality benchmark against existing project data.
 *
 * @param searchFn - The search function to benchmark (injected for testability)
 * @param getStatsFn - Function to get memory count
 * @param config - Benchmark configuration
 */
export async function runRetrievalBenchmark(
  searchFn: (
    query: string,
    embedding: number[],
    limit: number,
    threshold: number
  ) => Promise<Array<{ id: number; similarity: number; tags?: string[] }>>,
  getStatsFn: () => Promise<{ total_memories: number }>,
  config: RetrievalBenchmarkConfig = {}
): Promise<RetrievalBenchmarkResult> {
  const k = config.k ?? 10;
  const limit = config.retrievalLimit ?? 20;
  const threshold = config.threshold ?? 0.2;

  const stats = await getStatsFn();
  const queries = BENCHMARK_QUERIES;

  // Accumulate metric inputs in lock-step with queryBreakdown so every query
  // (including failures) contributes to the denominator.
  const accuracyInput: Array<{
    results: BenchmarkSearchResult[];
    relevantIds: Set<number>;
  }> = [];
  const queryBreakdown: RetrievalBenchmarkResult['queryBreakdown'] = [];
  const embeddingTimes: number[] = [];
  const searchTimes: number[] = [];
  const pipelineTimes: number[] = [];

  for (const q of queries) {
    const pipelineStart = Date.now();

    // Embed query
    const embedStart = Date.now();
    let embedding: number[];
    try {
      embedding = await getEmbedding(q.query);
    } catch (err) {
      logWarn('benchmark', `Failed to embed query: ${q.query}`, {
        error: getErrorMessage(err),
      });
      // Record a zero-score entry so failed queries count in the denominator
      accuracyInput.push({ results: [], relevantIds: new Set() });
      queryBreakdown.push({
        query: q.query,
        category: q.category,
        mrr: 0,
        recall: 0,
        latencyMs: Date.now() - pipelineStart,
        hitsInTopK: 0,
        totalRelevant: 0,
      });
      continue;
    }
    embeddingTimes.push(Date.now() - embedStart);

    // Search
    const searchStart = Date.now();
    let results: Array<{ id: number; similarity: number; tags?: string[] }>;
    try {
      results = await searchFn(q.query, embedding, limit, threshold);
    } catch (err) {
      logWarn('benchmark', `Search failed for query: ${q.query}`, {
        error: getErrorMessage(err),
      });
      // Record a zero-score entry so failed queries count in the denominator
      accuracyInput.push({ results: [], relevantIds: new Set() });
      queryBreakdown.push({
        query: q.query,
        category: q.category,
        mrr: 0,
        recall: 0,
        latencyMs: Date.now() - pipelineStart,
        hitsInTopK: 0,
        totalRelevant: 0,
      });
      continue;
    }
    searchTimes.push(Date.now() - searchStart);
    pipelineTimes.push(Date.now() - pipelineStart);

    // Build the real ranked result list for metric calculation — preserves
    // the original ranking order and non-relevant entries.
    const searchResults: BenchmarkSearchResult[] = results.map((r) => ({
      id: r.id,
      score: r.similarity,
    }));

    // Ground truth: a result is relevant if it shares at least one tag with
    // the query's expected tags.  This uses independent labels defined in
    // BENCHMARK_QUERIES instead of self-referential similarity thresholds.
    const queryTags = new Set(q.tags);
    const relevantIds = new Set<number>(
      results.filter((r) => r.tags?.some((t) => queryTags.has(t))).map((r) => r.id)
    );

    // Feed the real ranked list (including non-relevant hits) so
    // calculateAccuracyMetrics computes MRR/NDCG/Recall correctly.
    accuracyInput.push({ results: searchResults, relevantIds });

    // Per-query metrics
    const hitsInTopK = searchResults.slice(0, k).filter((r) => relevantIds.has(r.id)).length;
    const firstRelevantRank = searchResults.findIndex((r) => relevantIds.has(r.id));
    const mrr = firstRelevantRank >= 0 ? 1 / (firstRelevantRank + 1) : 0;

    queryBreakdown.push({
      query: q.query,
      category: q.category,
      mrr,
      recall: relevantIds.size > 0 ? hitsInTopK / relevantIds.size : 0,
      latencyMs: Date.now() - pipelineStart,
      hitsInTopK,
      totalRelevant: relevantIds.size,
    });
  }

  const accuracy = calculateAccuracyMetrics(accuracyInput, k);

  return {
    accuracy,
    latency: {
      embedding: calculateLatencyStats(embeddingTimes),
      search: calculateLatencyStats(searchTimes),
      pipeline: calculateLatencyStats(pipelineTimes),
    },
    queryBreakdown,
    metadata: {
      timestamp: new Date().toISOString(),
      totalQueries: queries.length,
      totalMemories: stats.total_memories,
      config: { k, retrievalLimit: limit, threshold },
    },
  };
}

// ============================================================================
// Baseline Management
// ============================================================================

function getBaselinePath(): string {
  const succDir = getSuccDir();
  return path.join(succDir, 'benchmark-baseline.json');
}

/** Save benchmark results as the new baseline */
export function saveBaseline(result: RetrievalBenchmarkResult): void {
  try {
    const baselinePath = getBaselinePath();
    const dir = path.dirname(baselinePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(baselinePath, JSON.stringify(result, null, 2), 'utf8');
    logInfo(
      'benchmark',
      `Baseline saved: MRR=${result.accuracy.mrr.toFixed(3)}, Recall@${result.accuracy.k}=${result.accuracy.recallAtK.toFixed(3)}`
    );
  } catch (err) {
    logWarn('benchmark', 'Failed to save baseline', {
      error: getErrorMessage(err),
    });
  }
}

/** Load the saved baseline, or null if none exists */
export function loadBaseline(): RetrievalBenchmarkResult | null {
  try {
    const baselinePath = getBaselinePath();
    if (!fs.existsSync(baselinePath)) return null;
    return JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as RetrievalBenchmarkResult;
  } catch (err) {
    logWarn('benchmark', 'Failed to load baseline', {
      error: getErrorMessage(err),
    });
    return null;
  }
}

/** Compare current results against baseline, flag regressions >5% */
export function compareToBaseline(
  current: RetrievalBenchmarkResult,
  baseline: RetrievalBenchmarkResult | null,
  regressionThreshold: number = 0.05
): BaselineComparison {
  const regressions: BaselineComparison['regressions'] = [];
  const improvements: BaselineComparison['improvements'] = [];

  if (!baseline) {
    return { current, baseline, regressions, improvements };
  }

  // Reject comparisons when the benchmark configs differ — numeric deltas
  // across unlike runs are misleading.
  const curCfg = current.metadata.config;
  const baseCfg = baseline.metadata.config;
  if (
    curCfg.k !== baseCfg.k ||
    curCfg.retrievalLimit !== baseCfg.retrievalLimit ||
    curCfg.threshold !== baseCfg.threshold
  ) {
    logWarn(
      'benchmark',
      `Baseline config mismatch (k=${baseCfg.k}→${curCfg.k}, limit=${baseCfg.retrievalLimit}→${curCfg.retrievalLimit}, threshold=${baseCfg.threshold}→${curCfg.threshold}) — comparison skipped`
    );
    return { current, baseline, regressions, improvements };
  }

  const metrics: Array<{ name: string; cur: number; base: number }> = [
    { name: 'MRR', cur: current.accuracy.mrr, base: baseline.accuracy.mrr },
    {
      name: `Recall@${current.accuracy.k}`,
      cur: current.accuracy.recallAtK,
      base: baseline.accuracy.recallAtK,
    },
    { name: 'NDCG', cur: current.accuracy.ndcg, base: baseline.accuracy.ndcg },
    {
      name: `Precision@${current.accuracy.k}`,
      cur: current.accuracy.precisionAtK,
      base: baseline.accuracy.precisionAtK,
    },
    { name: 'Latency P50', cur: current.latency.pipeline.p50, base: baseline.latency.pipeline.p50 },
    { name: 'Latency P95', cur: current.latency.pipeline.p95, base: baseline.latency.pipeline.p95 },
  ];

  for (const m of metrics) {
    if (m.base === 0) continue;
    const delta = m.cur - m.base;
    const deltaPct = delta / m.base;

    // For latency, higher is worse (regression if current > baseline)
    const isLatency = m.name.startsWith('Latency');
    const isRegression = isLatency
      ? deltaPct > regressionThreshold
      : deltaPct < -regressionThreshold;
    const isImprovement = isLatency
      ? deltaPct < -regressionThreshold
      : deltaPct > regressionThreshold;

    if (isRegression) {
      regressions.push({ metric: m.name, baseline: m.base, current: m.cur, delta, deltaPct });
    } else if (isImprovement) {
      improvements.push({ metric: m.name, baseline: m.base, current: m.cur, delta, deltaPct });
    }
  }

  return { current, baseline, regressions, improvements };
}

// ============================================================================
// Formatting
// ============================================================================

/** Format benchmark results for console output */
export function formatRetrievalResults(result: RetrievalBenchmarkResult): string {
  const lines: string[] = [];
  const a = result.accuracy;

  lines.push('Retrieval Quality Benchmark');
  lines.push('═'.repeat(50));
  lines.push('');
  lines.push('Accuracy Metrics:');
  lines.push(`  MRR:           ${a.mrr.toFixed(3)}`);
  lines.push(`  Recall@${a.k}:     ${a.recallAtK.toFixed(3)}`);
  lines.push(`  Precision@${a.k}:  ${a.precisionAtK.toFixed(3)}`);
  lines.push(`  NDCG:          ${a.ndcg.toFixed(3)}`);
  lines.push(`  Queries:       ${a.queryCount} (${a.queriesWithHits} with hits)`);
  lines.push('');
  lines.push('Latency:');
  lines.push(
    `  Embedding:     P50=${result.latency.embedding.p50}ms  P95=${result.latency.embedding.p95}ms`
  );
  lines.push(
    `  Search:        P50=${result.latency.search.p50}ms  P95=${result.latency.search.p95}ms`
  );
  lines.push(
    `  Pipeline:      P50=${result.latency.pipeline.p50}ms  P95=${result.latency.pipeline.p95}ms`
  );
  lines.push('');

  // Category breakdown
  const categories = new Map<string, { count: number; mrrSum: number; recallSum: number }>();
  for (const q of result.queryBreakdown) {
    const cat = categories.get(q.category) ?? { count: 0, mrrSum: 0, recallSum: 0 };
    cat.count++;
    cat.mrrSum += q.mrr;
    cat.recallSum += q.recall;
    categories.set(q.category, cat);
  }

  lines.push('By Category:');
  for (const [cat, stats] of categories) {
    const avgMrr = (stats.mrrSum / stats.count).toFixed(3);
    const avgRecall = (stats.recallSum / stats.count).toFixed(3);
    lines.push(`  ${cat.padEnd(12)} MRR=${avgMrr}  Recall=${avgRecall}  (${stats.count} queries)`);
  }

  return lines.join('\n');
}

/** Format baseline comparison for console output */
export function formatComparison(comparison: BaselineComparison): string {
  const lines: string[] = [];

  if (!comparison.baseline) {
    lines.push('No baseline found — saving current results as baseline.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('vs Baseline:');

  if (comparison.regressions.length > 0) {
    lines.push('  REGRESSIONS (>5% worse):');
    for (const r of comparison.regressions) {
      lines.push(
        `    ${r.metric}: ${r.baseline.toFixed(3)} → ${r.current.toFixed(3)} (${(r.deltaPct * 100).toFixed(1)}%)`
      );
    }
  }

  if (comparison.improvements.length > 0) {
    lines.push('  IMPROVEMENTS (>5% better):');
    for (const i of comparison.improvements) {
      lines.push(
        `    ${i.metric}: ${i.baseline.toFixed(3)} → ${i.current.toFixed(3)} (${i.deltaPct >= 0 ? '+' : ''}${(i.deltaPct * 100).toFixed(1)}%)`
      );
    }
  }

  if (comparison.regressions.length === 0 && comparison.improvements.length === 0) {
    lines.push('  No significant changes (within 5% of baseline)');
  }

  return lines.join('\n');
}
