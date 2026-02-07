import { getEmbedding, getEmbeddingInfo, cleanupEmbeddings } from '../lib/embeddings.js';
import { saveMemory, searchMemories, hybridSearchMemories, deleteMemory, closeDb, getMemoryStats } from '../lib/storage/index.js';
import {
  setConfigOverride,
  hasOpenRouterKey,
  LOCAL_MODEL,
  OPENROUTER_MODEL,
  getConfig,
  getSuccDir,
} from '../lib/config.js';
import {
  calculateAccuracyMetrics,
  calculateLatencyStats,
  formatAccuracyMetrics,
  formatLatencyMetrics,
  generateTestDataset,
  generateBenchmarkId,
  compareBenchmarks,
  formatBenchmarkComparison,
  compareHybridModes,
  formatHybridComparison,
  type AccuracyMetrics,
  type LatencyMetrics,
  type LatencyStats,
  type SearchResult as BenchmarkSearchResult,
  type BenchmarkResults,
  type BenchmarkHistory,
  type BenchmarkHistoryEntry,
  type HybridSearchMetrics,
} from '../lib/benchmark.js';
import * as fs from 'fs';
import * as path from 'path';

interface BenchmarkResult {
  name: string;
  operations: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  opsPerSecond: number;
}

interface AccuracyResult {
  name: string;
  total: number;
  correct: number;
  accuracy: number;
}

interface ModeResults {
  mode: string;
  model: string;
  dimensions: number | undefined;
  results: BenchmarkResult[];
  accuracy: AccuracyResult;
  advancedAccuracy?: AccuracyMetrics;
  latency?: LatencyMetrics;
}

// Test data for quick benchmark
const testMemories = [
  {
    content: 'TypeScript is a strongly typed programming language that builds on JavaScript',
    tags: ['typescript', 'programming'],
  },
  {
    content: 'React is a JavaScript library for building user interfaces',
    tags: ['react', 'frontend'],
  },
  {
    content: 'PostgreSQL is a powerful open source relational database',
    tags: ['database', 'sql'],
  },
  {
    content: 'Docker containers package software into standardized units',
    tags: ['docker', 'devops'],
  },
  { content: 'Git is a distributed version control system', tags: ['git', 'versioning'] },
  {
    content: 'Node.js is a JavaScript runtime built on Chrome V8 engine',
    tags: ['nodejs', 'backend'],
  },
  { content: 'GraphQL is a query language for APIs', tags: ['graphql', 'api'] },
  { content: 'Redis is an in-memory data structure store', tags: ['redis', 'cache'] },
  {
    content: 'Kubernetes orchestrates containerized applications',
    tags: ['k8s', 'orchestration'],
  },
  { content: 'Webpack is a static module bundler for JavaScript', tags: ['webpack', 'build'] },
];

const queries = [
  'typed language javascript',
  'frontend UI components',
  'relational database SQL',
  'container deployment',
  'version control history',
];

const accuracyTests = [
  { query: 'strongly typed javascript superset', expected: 'typescript' },
  { query: 'UI component library facebook', expected: 'react' },
  { query: 'SQL database open source', expected: 'database' },
  { query: 'container packaging software', expected: 'docker' },
  { query: 'source code versioning', expected: 'git' },
  { query: 'server-side javascript runtime', expected: 'nodejs' },
  { query: 'API query language alternative to REST', expected: 'graphql' },
  { query: 'in-memory cache key-value', expected: 'redis' },
  { query: 'container orchestration platform', expected: 'k8s' },
  { query: 'javascript bundler module', expected: 'webpack' },
];

/**
 * Run benchmark for a single embedding mode
 */
async function runModeBenchmark(iterations: number, modeName: string): Promise<ModeResults> {
  const results: BenchmarkResult[] = [];

  // Warm up
  console.log(`\n  Warming up ${modeName} model...`);
  const warmupStart = Date.now();
  await getEmbedding('warmup query');
  console.log(`  Model ready in ${Date.now() - warmupStart}ms`);

  const embeddingInfo = getEmbeddingInfo();

  // ============ EMBEDDING BENCHMARK ============
  console.log(`\n  [1/5] Embedding generation...`);
  const embedTimes: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const text = testMemories[i % testMemories.length].content + ` unique${i}`;
    const start = Date.now();
    await getEmbedding(text);
    embedTimes.push(Date.now() - start);
  }
  results.push(formatResult('Embedding generation', embedTimes));

  // ============ SAVE BENCHMARK ============
  console.log(`  [2/5] Memory save...`);
  const saveTimes: number[] = [];
  const savedIds: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const mem = testMemories[i % testMemories.length];
    const uniqueContent = mem.content + ` (${modeName} test ${i})`;
    const start = Date.now();
    const embedding = await getEmbedding(uniqueContent);
    const result = await saveMemory(uniqueContent, embedding, mem.tags, `benchmark-${modeName}`, { deduplicate: false, autoLink: false });
    saveTimes.push(Date.now() - start);
    savedIds.push(result.id);
  }
  results.push(formatResult('Memory save (full)', saveTimes));

  // ============ RECALL BENCHMARK ============
  console.log(`  [3/5] Memory recall...`);
  const recallTimes: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const query = queries[i % queries.length] + ` unique${i}`;
    const start = Date.now();
    const queryEmbedding = await getEmbedding(query);
    await searchMemories(queryEmbedding, 5, 0.3);
    recallTimes.push(Date.now() - start);
  }
  results.push(formatResult('Memory recall (full)', recallTimes));

  // ============ SEARCH-ONLY BENCHMARK ============
  console.log(`  [4/5] DB search...`);
  const precomputedEmbeddings = await Promise.all(queries.map((q) => getEmbedding(q)));

  const searchTimes: number[] = [];
  for (let i = 0; i < iterations * 10; i++) {
    const embedding = precomputedEmbeddings[i % precomputedEmbeddings.length];
    const start = Date.now();
    await searchMemories(embedding, 5, 0.3);
    searchTimes.push(Date.now() - start);
  }
  results.push(formatResult('DB search only', searchTimes));

  // ============ ACCURACY BENCHMARK ============
  console.log(`  [5/5] Accuracy test...`);
  let correct = 0;

  for (const test of accuracyTests) {
    const queryEmbedding = await getEmbedding(test.query);
    const searchResults = await searchMemories(queryEmbedding, 1, 0.0);

    if (searchResults.length > 0) {
      const topResult = searchResults[0];
      const hasExpectedTag = topResult.tags.some((t: string) =>
        t.toLowerCase().includes(test.expected.toLowerCase())
      );
      if (hasExpectedTag) correct++;
    }
  }

  const accuracy: AccuracyResult = {
    name: 'Semantic accuracy',
    total: accuracyTests.length,
    correct,
    accuracy: (correct / accuracyTests.length) * 100,
  };

  // Cleanup benchmark data
  for (const id of savedIds) {
    await deleteMemory(id);
  }

  return {
    mode: embeddingInfo.mode,
    model: embeddingInfo.model,
    dimensions: embeddingInfo.dimensions,
    results,
    accuracy,
  };
}

/**
 * Run advanced benchmark with IR metrics (Recall@K, MRR, NDCG)
 */
async function runAdvancedBenchmark(
  k: number = 5,
  size: 'small' | 'medium' | 'large' = 'small'
): Promise<{
  accuracy: AccuracyMetrics;
  latency: LatencyMetrics;
}> {
  console.log(`\n  Running advanced accuracy benchmark (${size} dataset)...`);

  const dataset = generateTestDataset(size);
  const savedIds: number[] = [];

  // Insert test memories
  console.log(`  Inserting ${dataset.memories.length} test memories...`);
  for (const mem of dataset.memories) {
    const embedding = await getEmbedding(mem.content);
    const result = await saveMemory(mem.content, embedding, mem.tags, 'benchmark-advanced', {
      deduplicate: false,
      autoLink: false,
    });
    savedIds.push(result.id);
  }

  // Map original indices to saved IDs
  const idMapping = new Map<number, number>();
  for (let i = 0; i < savedIds.length; i++) {
    idMapping.set(i + 1, savedIds[i]); // Original IDs were 1-indexed
  }

  // Run queries and collect results
  const embeddingTimes: number[] = [];
  const searchTimes: number[] = [];
  const pipelineTimes: number[] = [];
  const queryResults: Array<{
    results: BenchmarkSearchResult[];
    relevantIds: Set<number>;
  }> = [];

  console.log(`  Running ${dataset.queries.length} benchmark queries...`);
  for (const q of dataset.queries) {
    // Map original relevant IDs to saved IDs
    const mappedRelevantIds = new Set(
      q.relevantIds.map((id) => idMapping.get(id)).filter((id): id is number => id !== undefined)
    );

    const pipelineStart = Date.now();

    // Embedding timing
    const embedStart = Date.now();
    const queryEmbedding = await getEmbedding(q.query);
    embeddingTimes.push(Date.now() - embedStart);

    // Search timing
    const searchStart = Date.now();
    const searchResults = await searchMemories(queryEmbedding, k * 2, 0.0);
    searchTimes.push(Date.now() - searchStart);

    pipelineTimes.push(Date.now() - pipelineStart);

    // Convert to benchmark format
    const benchmarkResults: BenchmarkSearchResult[] = searchResults.map((r) => ({
      id: r.id,
      score: r.similarity,
    }));

    queryResults.push({
      results: benchmarkResults,
      relevantIds: mappedRelevantIds,
    });
  }

  // Calculate metrics
  const accuracy = calculateAccuracyMetrics(queryResults, k);
  const latency: LatencyMetrics = {
    embedding: calculateLatencyStats(embeddingTimes),
    search: calculateLatencyStats(searchTimes),
    pipeline: calculateLatencyStats(pipelineTimes),
  };

  // Cleanup
  for (const id of savedIds) {
    await deleteMemory(id);
  }

  return { accuracy, latency };
}

export interface BenchmarkOptions {
  iterations?: number;
  advanced?: boolean;
  k?: number;
  json?: boolean;
  model?: string;
  size?: 'small' | 'medium' | 'large';
  save?: boolean;
  compare?: boolean;
  hybrid?: boolean;
}

// Available local models for benchmarking
export const LOCAL_MODELS = [
  'Xenova/all-MiniLM-L6-v2',      // 384d, fast, default
  'Xenova/bge-small-en-v1.5',     // 384d, better accuracy
  'Xenova/bge-base-en-v1.5',      // 768d, best local accuracy
  'Xenova/bge-large-en-v1.5',     // 1024d, highest quality
] as const;

/**
 * Run succ benchmarks (local + optionally OpenRouter)
 */
export async function benchmark(options: BenchmarkOptions = {}): Promise<void> {
  const iterations = options.iterations || 10;
  const k = options.k || 5;
  const localModel = options.model || LOCAL_MODEL;
  const datasetSize = options.size || 'small';

  console.log('═══════════════════════════════════════════════════════════');
  console.log('                     SUCC BENCHMARK                         ');
  console.log('═══════════════════════════════════════════════════════════');

  const allModeResults: ModeResults[] = [];

  // ============ LOCAL BENCHMARK ============
  const modelShort = localModel.split('/').pop() || localModel;
  console.log(`\n┌─────────────────────────────────────────────────────────────┐`);
  console.log(`│ LOCAL EMBEDDINGS (${modelShort.padEnd(39)}) │`);
  console.log(`└─────────────────────────────────────────────────────────────┘`);

  setConfigOverride({
    embedding_mode: 'local',
    embedding_model: localModel,
  });
  cleanupEmbeddings(); // Reset pipeline

  const localResults = await runModeBenchmark(iterations, 'local');

  // Run advanced benchmark if requested
  if (options.advanced) {
    const { accuracy, latency } = await runAdvancedBenchmark(k, datasetSize);
    localResults.advancedAccuracy = accuracy;
    localResults.latency = latency;
  }

  allModeResults.push(localResults);

  // ============ OPENROUTER BENCHMARK ============
  if (hasOpenRouterKey()) {
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│ OPENROUTER API (openai/text-embedding-3-small)              │');
    console.log('└─────────────────────────────────────────────────────────────┘');

    // Get API key from config before override
    const baseConfig = getConfig();
    setConfigOverride({
      embedding_mode: 'openrouter',
      embedding_model: OPENROUTER_MODEL,
      openrouter_api_key: baseConfig.openrouter_api_key,
    });
    cleanupEmbeddings(); // Reset cache

    const openrouterResults = await runModeBenchmark(iterations, 'openrouter');

    if (options.advanced) {
      const { accuracy, latency } = await runAdvancedBenchmark(k, datasetSize);
      openrouterResults.advancedAccuracy = accuracy;
      openrouterResults.latency = latency;
    }

    allModeResults.push(openrouterResults);
  } else {
    console.log('\n  ⓘ OpenRouter benchmark skipped (no API key)');
    console.log('    Set OPENROUTER_API_KEY or add to ~/.succ/config.json');
  }

  // Reset config override
  setConfigOverride(null);
  closeDb();

  // ============ JSON OUTPUT ============
  if (options.json) {
    const jsonResults = allModeResults.map((mr) => ({
      mode: mr.mode,
      model: mr.model,
      dimensions: mr.dimensions,
      latency: mr.results.map((r) => ({
        operation: r.name,
        avgMs: r.avgMs,
        minMs: r.minMs,
        maxMs: r.maxMs,
        opsPerSecond: r.opsPerSecond,
      })),
      accuracy: {
        basic: {
          correct: mr.accuracy.correct,
          total: mr.accuracy.total,
          percentage: mr.accuracy.accuracy,
        },
        advanced: mr.advancedAccuracy
          ? {
              recallAtK: mr.advancedAccuracy.recallAtK,
              precisionAtK: mr.advancedAccuracy.precisionAtK,
              f1AtK: mr.advancedAccuracy.f1AtK,
              k: mr.advancedAccuracy.k,
              mrr: mr.advancedAccuracy.mrr,
              ndcg: mr.advancedAccuracy.ndcg,
              queryCount: mr.advancedAccuracy.queryCount,
              queriesWithHits: mr.advancedAccuracy.queriesWithHits,
            }
          : null,
      },
      latencyStats: mr.latency
        ? {
            embedding: mr.latency.embedding,
            search: mr.latency.search,
            pipeline: mr.latency.pipeline,
          }
        : null,
    }));
    console.log(JSON.stringify(jsonResults, null, 2));
    return;
  }

  // ============ SUMMARY ============
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('                        SUMMARY                             ');
  console.log('═══════════════════════════════════════════════════════════');

  for (const modeResult of allModeResults) {
    const dimStr = modeResult.dimensions ? `${modeResult.dimensions}d` : '?d';
    console.log(`\n${modeResult.mode.toUpperCase()} (${modeResult.model}, ${dimStr}):`);
    console.log('┌─────────────────────────┬──────────┬──────────┬──────────┐');
    console.log('│ Operation               │ Avg (ms) │ Min (ms) │ Max (ms) │');
    console.log('├─────────────────────────┼──────────┼──────────┼──────────┤');

    for (const r of modeResult.results) {
      const name = r.name.padEnd(23);
      const avg = r.avgMs.toFixed(1).padStart(8);
      const min = r.minMs.toFixed(1).padStart(8);
      const max = r.maxMs.toFixed(1).padStart(8);
      console.log(`│ ${name} │ ${avg} │ ${min} │ ${max} │`);
    }

    console.log('└─────────────────────────┴──────────┴──────────┴──────────┘');
    console.log(`  Throughput: ${modeResult.results[0].opsPerSecond.toFixed(1)} embed/sec`);
    console.log(
      `  Basic Accuracy: ${modeResult.accuracy.accuracy.toFixed(0)}% (${modeResult.accuracy.correct}/${modeResult.accuracy.total})`
    );

    // Show advanced metrics if available
    if (modeResult.advancedAccuracy) {
      console.log('\n  Advanced IR Metrics:');
      console.log(formatAccuracyMetrics(modeResult.advancedAccuracy));
    }

    if (modeResult.latency) {
      console.log('\n  Latency Statistics:');
      console.log(formatLatencyMetrics(modeResult.latency));
    }
  }

  // ============ COMPARISON ============
  if (allModeResults.length > 1) {
    console.log('\n─────────────────────────────────────────────────────────────');
    console.log('COMPARISON:');
    const local = allModeResults[0];
    const openrouter = allModeResults[1];

    const localEmbed = local.results[0].avgMs;
    const orEmbed = openrouter.results[0].avgMs;
    const speedup = orEmbed / Math.max(localEmbed, 0.1);

    console.log(`  Local embedding:     ${localEmbed.toFixed(1)}ms avg`);
    console.log(`  OpenRouter embedding: ${orEmbed.toFixed(1)}ms avg`);
    console.log(`  → Local is ${speedup.toFixed(1)}x faster (no network latency)`);
    console.log(`  → Both achieve ${local.accuracy.accuracy.toFixed(0)}% semantic accuracy`);

    if (local.advancedAccuracy && openrouter.advancedAccuracy) {
      console.log('\n  Advanced Metrics Comparison:');
      console.log(
        `  Local MRR:      ${(local.advancedAccuracy.mrr * 100).toFixed(1)}%`
      );
      console.log(
        `  OpenRouter MRR: ${(openrouter.advancedAccuracy.mrr * 100).toFixed(1)}%`
      );
      console.log(
        `  Local NDCG:     ${(local.advancedAccuracy.ndcg * 100).toFixed(1)}%`
      );
      console.log(
        `  OpenRouter NDCG: ${(openrouter.advancedAccuracy.ndcg * 100).toFixed(1)}%`
      );
    }
  }

  console.log('\nDatabase: SQLite (better-sqlite3)');
  console.log();
}

function formatResult(name: string, times: number[]): BenchmarkResult {
  const total = times.reduce((a, b) => a + b, 0);
  return {
    name,
    operations: times.length,
    totalMs: total,
    avgMs: total / times.length,
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
    opsPerSecond: times.length > 0 && total > 0 ? (times.length / total) * 1000 : 0,
  };
}

/**
 * Run quick benchmark on existing memories (no test data insertion)
 * Uses the actual project's memories for realistic performance measurement
 */
export async function benchmarkExisting(options: { k?: number; json?: boolean } = {}): Promise<void> {
  const k = options.k || 5;

  console.log('═══════════════════════════════════════════════════════════');
  console.log('                SUCC BENCHMARK (Existing Data)              ');
  console.log('═══════════════════════════════════════════════════════════');

  const stats = await getMemoryStats();
  console.log(`\nMemories in database: ${stats.total_memories}`);

  if (stats.total_memories === 0) {
    console.log('\n  No memories found. Use `succ remember` to add some first.');
    return;
  }

  // Sample queries for latency testing
  const sampleQueries = [
    'important decision about architecture',
    'error handling implementation',
    'configuration settings',
    'authentication flow',
    'database optimization',
  ];

  const embeddingTimes: number[] = [];
  const searchTimes: number[] = [];
  const pipelineTimes: number[] = [];

  console.log('\nRunning latency benchmark...');
  for (const query of sampleQueries) {
    for (let i = 0; i < 10; i++) {
      const pipelineStart = Date.now();

      const embedStart = Date.now();
      const embedding = await getEmbedding(query + ` variation ${i}`);
      embeddingTimes.push(Date.now() - embedStart);

      const searchStart = Date.now();
      await searchMemories(embedding, k, 0.3);
      searchTimes.push(Date.now() - searchStart);

      pipelineTimes.push(Date.now() - pipelineStart);
    }
  }

  const latency: LatencyMetrics = {
    embedding: calculateLatencyStats(embeddingTimes),
    search: calculateLatencyStats(searchTimes),
    pipeline: calculateLatencyStats(pipelineTimes),
  };

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          totalMemories: stats.total_memories,
          latency: {
            embedding: latency.embedding,
            search: latency.search,
            pipeline: latency.pipeline,
          },
        },
        null,
        2
      )
    );
    return;
  }

  console.log('\n' + formatLatencyMetrics(latency));

  const embeddingInfo = getEmbeddingInfo();
  console.log(`\nModel: ${embeddingInfo.model} (${embeddingInfo.mode})`);
  console.log(`Dimensions: ${embeddingInfo.dimensions || 'unknown'}`);
  console.log(`Search limit: top ${k} results`);
  console.log();

  closeDb();
}

// ============================================================================
// Benchmark History Management
// ============================================================================

const BENCHMARK_HISTORY_VERSION = 1;

/**
 * Get the path to the benchmark history file
 */
function getBenchmarkHistoryPath(): string {
  const succDir = getSuccDir();
  return path.join(succDir, 'benchmarks', 'history.json');
}

/**
 * Load benchmark history from disk
 */
export function loadBenchmarkHistory(): BenchmarkHistory {
  const historyPath = getBenchmarkHistoryPath();

  if (!fs.existsSync(historyPath)) {
    return { version: BENCHMARK_HISTORY_VERSION, entries: [] };
  }

  try {
    const content = fs.readFileSync(historyPath, 'utf-8');
    const history = JSON.parse(content) as BenchmarkHistory;
    return history;
  } catch {
    console.warn('  Warning: Could not load benchmark history, starting fresh');
    return { version: BENCHMARK_HISTORY_VERSION, entries: [] };
  }
}

/**
 * Save benchmark history to disk
 */
export function saveBenchmarkHistory(history: BenchmarkHistory): void {
  const historyPath = getBenchmarkHistoryPath();
  const dir = path.dirname(historyPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
}

/**
 * Add a benchmark entry to history
 */
export function addBenchmarkToHistory(
  history: BenchmarkHistory,
  entry: Omit<BenchmarkHistoryEntry, 'id' | 'timestamp'>
): BenchmarkHistoryEntry {
  const newEntry: BenchmarkHistoryEntry = {
    ...entry,
    id: generateBenchmarkId(),
    timestamp: new Date().toISOString(),
  };

  history.entries.push(newEntry);

  // Keep only last 100 entries
  if (history.entries.length > 100) {
    history.entries = history.entries.slice(-100);
  }

  return newEntry;
}

/**
 * Get the most recent benchmark entry matching criteria
 */
export function getLatestBenchmark(
  history: BenchmarkHistory,
  mode?: string,
  model?: string
): BenchmarkHistoryEntry | undefined {
  const filtered = history.entries.filter((e) => {
    if (mode && e.mode !== mode) return false;
    if (model && e.model !== model) return false;
    return true;
  });

  return filtered.length > 0 ? filtered[filtered.length - 1] : undefined;
}

// ============================================================================
// Hybrid Search Benchmark
// ============================================================================

/**
 * Run hybrid search benchmark comparing semantic, BM25, and hybrid modes
 */
export async function runHybridBenchmark(
  k: number = 5,
  size: 'small' | 'medium' | 'large' = 'small'
): Promise<HybridSearchMetrics> {
  console.log(`\n  Running hybrid search benchmark (${size} dataset)...`);

  const dataset = generateTestDataset(size);
  const savedIds: number[] = [];

  // Insert test memories
  console.log(`  Inserting ${dataset.memories.length} test memories...`);
  for (const mem of dataset.memories) {
    const embedding = await getEmbedding(mem.content);
    const result = await saveMemory(mem.content, embedding, mem.tags, 'benchmark-hybrid', {
      deduplicate: false,
      autoLink: false,
    });
    savedIds.push(result.id);
  }

  // Map original indices to saved IDs
  const idMapping = new Map<number, number>();
  for (let i = 0; i < savedIds.length; i++) {
    idMapping.set(i + 1, savedIds[i]);
  }

  // Collect results for all three modes
  const semanticResults: Array<{ results: BenchmarkSearchResult[]; relevantIds: Set<number> }> = [];
  const bm25Results: Array<{ results: BenchmarkSearchResult[]; relevantIds: Set<number> }> = [];
  const hybridResults: Array<{ results: BenchmarkSearchResult[]; relevantIds: Set<number> }> = [];

  console.log(`  Running ${dataset.queries.length} queries in 3 modes...`);

  for (const q of dataset.queries) {
    const mappedRelevantIds = new Set(
      q.relevantIds.map((id) => idMapping.get(id)).filter((id): id is number => id !== undefined)
    );

    const queryEmbedding = await getEmbedding(q.query);

    // Semantic-only search
    const semanticSearch = await searchMemories(queryEmbedding, k * 2, 0.0);
    semanticResults.push({
      results: semanticSearch.map((r) => ({ id: r.id, score: r.similarity })),
      relevantIds: mappedRelevantIds,
    });

    // Hybrid search (RRF fusion) - alpha=0.5 for balanced fusion
    const hybridSearch = await hybridSearchMemories(q.query, queryEmbedding, k * 2, 0.0, 0.5);
    hybridResults.push({
      results: hybridSearch.map((r) => ({ id: r.id, score: r.similarity })),
      relevantIds: mappedRelevantIds,
    });

    // BM25-only search (use hybrid with alpha=0.0 for pure BM25)
    const bm25Search = await hybridSearchMemories(q.query, queryEmbedding, k * 2, 0.0, 0.0);
    bm25Results.push({
      results: bm25Search.map((r) => ({ id: r.id, score: r.similarity })),
      relevantIds: mappedRelevantIds,
    });
  }

  // Calculate metrics for each mode
  const semanticMetrics = calculateAccuracyMetrics(semanticResults, k);
  const bm25Metrics = calculateAccuracyMetrics(bm25Results, k);
  const hybridMetrics = calculateAccuracyMetrics(hybridResults, k);

  // Cleanup
  for (const id of savedIds) {
    await deleteMemory(id);
  }

  return compareHybridModes(semanticMetrics, bm25Metrics, hybridMetrics);
}

/**
 * Run benchmark with save and compare options
 */
export async function benchmarkWithHistory(options: BenchmarkOptions = {}): Promise<void> {
  const k = options.k || 5;
  const datasetSize = options.size || 'small';
  const localModel = options.model || LOCAL_MODEL;

  // Run the standard benchmark first
  await benchmark(options);

  // If hybrid mode requested, run hybrid comparison
  if (options.hybrid && options.advanced) {
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│                  HYBRID SEARCH COMPARISON                    │');
    console.log('└─────────────────────────────────────────────────────────────┘');

    setConfigOverride({
      embedding_mode: 'local',
      embedding_model: localModel,
    });
    cleanupEmbeddings();

    const hybridMetrics = await runHybridBenchmark(k, datasetSize);
    console.log('\n' + formatHybridComparison(hybridMetrics));

    setConfigOverride(null);
  }

  // Handle save/compare
  if (options.save || options.compare) {
    const history = loadBenchmarkHistory();

    if (options.advanced) {
      // We need to re-run to get metrics for saving
      // For simplicity, assume the last run was with local embeddings
      setConfigOverride({
        embedding_mode: 'local',
        embedding_model: localModel,
      });
      cleanupEmbeddings();

      const { accuracy, latency } = await runAdvancedBenchmark(k, datasetSize);

      if (options.compare) {
        const latest = getLatestBenchmark(history, 'local', localModel);
        if (latest) {
          console.log('\n' + formatBenchmarkComparison(accuracy, latest.accuracy, latest.timestamp));
        } else {
          console.log('\n  No previous benchmark found for comparison.');
          console.log('  Run with --save first to establish a baseline.');
        }
      }

      if (options.save) {
        const embeddingInfo = getEmbeddingInfo();
        addBenchmarkToHistory(history, {
          mode: embeddingInfo.mode,
          model: embeddingInfo.model,
          datasetSize,
          searchMode: options.hybrid ? 'hybrid' : 'semantic',
          accuracy,
          latency,
          config: {
            embeddingModel: embeddingInfo.model,
            embeddingMode: embeddingInfo.mode,
            totalMemories: generateTestDataset(datasetSize).memories.length,
            testQueries: generateTestDataset(datasetSize).queries.length,
          },
        });
        saveBenchmarkHistory(history);
        console.log(`\n  ✓ Benchmark saved to history (${history.entries.length} total entries)`);
      }

      setConfigOverride(null);
    } else {
      console.log('\n  Note: --save and --compare require --advanced mode');
    }
  }

  closeDb();
}

/**
 * List benchmark history entries
 */
export async function listBenchmarkHistory(options: { limit?: number; json?: boolean } = {}): Promise<void> {
  const limit = options.limit || 10;
  const history = loadBenchmarkHistory();

  if (history.entries.length === 0) {
    console.log('No benchmark history found.');
    console.log('Run `succ benchmark --advanced --save` to start tracking.');
    return;
  }

  const entries = history.entries.slice(-limit).reverse();

  if (options.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('                   BENCHMARK HISTORY                        ');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('┌────────────────────┬──────────┬──────────┬──────────┬──────────┐');
  console.log('│ Timestamp          │ Recall@K │ Prec@K   │ F1@K     │ MRR      │');
  console.log('├────────────────────┼──────────┼──────────┼──────────┼──────────┤');

  for (const entry of entries) {
    const ts = entry.timestamp.slice(0, 16).replace('T', ' ');
    const recall = `${(entry.accuracy.recallAtK * 100).toFixed(1)}%`.padStart(8);
    const precision = `${(entry.accuracy.precisionAtK * 100).toFixed(1)}%`.padStart(8);
    const f1 = `${(entry.accuracy.f1AtK * 100).toFixed(1)}%`.padStart(8);
    const mrr = `${(entry.accuracy.mrr * 100).toFixed(1)}%`.padStart(8);
    console.log(`│ ${ts} │ ${recall} │ ${precision} │ ${f1} │ ${mrr} │`);
  }

  console.log('└────────────────────┴──────────┴──────────┴──────────┴──────────┘');
  console.log(`\nShowing last ${entries.length} of ${history.entries.length} entries`);
}
