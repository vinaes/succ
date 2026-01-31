import { getEmbedding } from '../lib/embeddings.js';
import {
  saveMemory,
  searchMemories,
  deleteMemory,
  closeDb,
} from '../lib/db.js';

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

/**
 * Run succ benchmarks
 */
export async function benchmark(options: { iterations?: number } = {}): Promise<void> {
  const iterations = options.iterations || 10;

  console.log('═══════════════════════════════════════════════════════════');
  console.log('                     SUCC BENCHMARK                         ');
  console.log('═══════════════════════════════════════════════════════════');
  console.log();

  // Warm up embedding model
  console.log('Warming up embedding model...');
  const warmupStart = Date.now();
  await getEmbedding('warmup query');
  const warmupTime = Date.now() - warmupStart;
  console.log(`Model loaded in ${warmupTime}ms`);
  console.log();

  const results: BenchmarkResult[] = [];
  const accuracyResults: AccuracyResult[] = [];

  // Test data
  const testMemories = [
    { content: 'TypeScript is a strongly typed programming language that builds on JavaScript', tags: ['typescript', 'programming'] },
    { content: 'React is a JavaScript library for building user interfaces', tags: ['react', 'frontend'] },
    { content: 'PostgreSQL is a powerful open source relational database', tags: ['database', 'sql'] },
    { content: 'Docker containers package software into standardized units', tags: ['docker', 'devops'] },
    { content: 'Git is a distributed version control system', tags: ['git', 'versioning'] },
    { content: 'Node.js is a JavaScript runtime built on Chrome V8 engine', tags: ['nodejs', 'backend'] },
    { content: 'GraphQL is a query language for APIs', tags: ['graphql', 'api'] },
    { content: 'Redis is an in-memory data structure store', tags: ['redis', 'cache'] },
    { content: 'Kubernetes orchestrates containerized applications', tags: ['k8s', 'orchestration'] },
    { content: 'Webpack is a static module bundler for JavaScript', tags: ['webpack', 'build'] },
  ];

  // ============ EMBEDDING BENCHMARK ============
  console.log('─────────────────────────────────────────────────────────────');
  console.log('1. EMBEDDING GENERATION');
  console.log('─────────────────────────────────────────────────────────────');

  const embedTimes: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const text = testMemories[i % testMemories.length].content;
    const start = Date.now();
    await getEmbedding(text);
    embedTimes.push(Date.now() - start);
  }

  results.push(formatResult('Embedding generation', embedTimes));
  printResult(results[results.length - 1]);

  // ============ SAVE BENCHMARK ============
  console.log();
  console.log('─────────────────────────────────────────────────────────────');
  console.log('2. MEMORY SAVE (embedding + DB write)');
  console.log('─────────────────────────────────────────────────────────────');

  const saveTimes: number[] = [];
  const savedIds: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const mem = testMemories[i % testMemories.length];
    const start = Date.now();
    const embedding = await getEmbedding(mem.content);
    const id = saveMemory(mem.content + ` (test ${i})`, embedding, mem.tags, 'benchmark');
    saveTimes.push(Date.now() - start);
    savedIds.push(id);
  }

  results.push(formatResult('Memory save (full)', saveTimes));
  printResult(results[results.length - 1]);

  // ============ RECALL BENCHMARK ============
  console.log();
  console.log('─────────────────────────────────────────────────────────────');
  console.log('3. MEMORY RECALL (embedding + search)');
  console.log('─────────────────────────────────────────────────────────────');

  const recallTimes: number[] = [];
  const queries = [
    'typed language javascript',
    'frontend UI components',
    'relational database SQL',
    'container deployment',
    'version control history',
  ];

  for (let i = 0; i < iterations; i++) {
    const query = queries[i % queries.length];
    const start = Date.now();
    const queryEmbedding = await getEmbedding(query);
    searchMemories(queryEmbedding, 5, 0.3);
    recallTimes.push(Date.now() - start);
  }

  results.push(formatResult('Memory recall (full)', recallTimes));
  printResult(results[results.length - 1]);

  // ============ SEARCH-ONLY BENCHMARK ============
  console.log();
  console.log('─────────────────────────────────────────────────────────────');
  console.log('4. SEARCH ONLY (no embedding, DB only)');
  console.log('─────────────────────────────────────────────────────────────');

  // Pre-compute embeddings for queries
  const precomputedEmbeddings = await Promise.all(queries.map((q) => getEmbedding(q)));

  const searchTimes: number[] = [];
  for (let i = 0; i < iterations * 10; i++) {
    const embedding = precomputedEmbeddings[i % precomputedEmbeddings.length];
    const start = Date.now();
    searchMemories(embedding, 5, 0.3);
    searchTimes.push(Date.now() - start);
  }

  results.push(formatResult('DB search only', searchTimes));
  printResult(results[results.length - 1]);

  // ============ ACCURACY BENCHMARK ============
  console.log();
  console.log('─────────────────────────────────────────────────────────────');
  console.log('5. SEMANTIC SEARCH ACCURACY');
  console.log('─────────────────────────────────────────────────────────────');

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

  let correct = 0;
  for (const test of accuracyTests) {
    const queryEmbedding = await getEmbedding(test.query);
    const results = searchMemories(queryEmbedding, 1, 0.0);

    if (results.length > 0) {
      const topResult = results[0];
      const hasExpectedTag = topResult.tags.some((t) =>
        t.toLowerCase().includes(test.expected.toLowerCase())
      );

      if (hasExpectedTag) {
        correct++;
        console.log(`  ✓ "${test.query.substring(0, 30)}..." → [${topResult.tags.join(', ')}]`);
      } else {
        console.log(`  ✗ "${test.query.substring(0, 30)}..." → [${topResult.tags.join(', ')}] (expected: ${test.expected})`);
      }
    } else {
      console.log(`  ✗ "${test.query.substring(0, 30)}..." → no results`);
    }
  }

  accuracyResults.push({
    name: 'Semantic search accuracy',
    total: accuracyTests.length,
    correct,
    accuracy: (correct / accuracyTests.length) * 100,
  });

  console.log();
  console.log(`  Accuracy: ${correct}/${accuracyTests.length} (${((correct / accuracyTests.length) * 100).toFixed(1)}%)`);

  // ============ CLEANUP ============
  console.log();
  console.log('Cleaning up benchmark data...');
  for (const id of savedIds) {
    deleteMemory(id);
  }
  closeDb();

  // ============ SUMMARY ============
  console.log();
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                        SUMMARY                             ');
  console.log('═══════════════════════════════════════════════════════════');
  console.log();
  console.log('Performance:');
  console.log('┌─────────────────────────┬──────────┬──────────┬──────────┐');
  console.log('│ Operation               │ Avg (ms) │ Min (ms) │ Max (ms) │');
  console.log('├─────────────────────────┼──────────┼──────────┼──────────┤');

  for (const r of results) {
    const name = r.name.padEnd(23);
    const avg = r.avgMs.toFixed(1).padStart(8);
    const min = r.minMs.toFixed(1).padStart(8);
    const max = r.maxMs.toFixed(1).padStart(8);
    console.log(`│ ${name} │ ${avg} │ ${min} │ ${max} │`);
  }

  console.log('└─────────────────────────┴──────────┴──────────┴──────────┘');
  console.log();
  console.log('Accuracy:');

  for (const a of accuracyResults) {
    console.log(`  ${a.name}: ${a.accuracy.toFixed(1)}% (${a.correct}/${a.total})`);
  }

  console.log();
  console.log('Model: Xenova/all-MiniLM-L6-v2 (local, 384 dimensions)');
  console.log('Database: SQLite (better-sqlite3)');
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
    opsPerSecond: (times.length / total) * 1000,
  };
}

function printResult(r: BenchmarkResult): void {
  console.log(`  Operations: ${r.operations}`);
  console.log(`  Average:    ${r.avgMs.toFixed(2)}ms`);
  console.log(`  Min/Max:    ${r.minMs.toFixed(2)}ms / ${r.maxMs.toFixed(2)}ms`);
  console.log(`  Throughput: ${r.opsPerSecond.toFixed(2)} ops/sec`);
}
