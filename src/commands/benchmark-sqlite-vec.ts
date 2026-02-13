/**
 * Benchmark comparing brute-force vector search vs sqlite-vec indexed search
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { getEmbedding, cleanupEmbeddings } from '../lib/embeddings.js';
import { cosineSimilarity } from '../lib/embeddings.js';
import { setConfigOverride, LOCAL_MODEL } from '../lib/config.js';

interface BenchmarkResult {
  method: string;
  vectorCount: number;
  queryCount: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  queriesPerSecond: number;
}

interface ComparisonResult {
  bruteForce: BenchmarkResult;
  sqliteVec: BenchmarkResult;
  speedup: number;
  memoriesCount: number;
}

// Test data for generating vectors
const testTopics = [
  'TypeScript strongly typed programming language JavaScript superset',
  'React frontend library component-based UI development',
  'PostgreSQL relational database SQL ACID transactions',
  'Docker containers virtualization deployment microservices',
  'Kubernetes orchestration cluster management pods services',
  'GraphQL API query language schema resolvers mutations',
  'Redis in-memory cache key-value store pub-sub',
  'Node.js server-side JavaScript runtime event loop',
  'Python machine learning data science pandas numpy',
  'Rust systems programming memory safety concurrency',
  'Go golang concurrent programming goroutines channels',
  'MongoDB NoSQL document database JSON BSON',
  'Elasticsearch full-text search analytics distributed',
  'RabbitMQ message queue AMQP pub-sub async',
  'Nginx reverse proxy load balancer web server',
  'Terraform infrastructure as code cloud provisioning',
  'GitHub version control collaboration pull requests',
  'Jenkins CI/CD continuous integration deployment pipeline',
  'Prometheus monitoring metrics alerting time-series',
  'Grafana visualization dashboards observability',
];

const testQueries = [
  'typed language for web development',
  'container orchestration platform',
  'in-memory data store caching',
  'message broker asynchronous communication',
  'infrastructure automation cloud',
  'monitoring and alerting system',
  'full-text search engine',
  'serverless functions cloud',
  'database replication sharding',
  'API gateway rate limiting',
];

/**
 * Generate test embeddings
 */
async function generateTestEmbeddings(count: number): Promise<{ content: string; embedding: Float32Array }[]> {
  console.log(`  Generating ${count} test embeddings...`);
  const results: { content: string; embedding: Float32Array }[] = [];

  for (let i = 0; i < count; i++) {
    const topic = testTopics[i % testTopics.length];
    const content = `${topic} - variation ${i} with unique content ${Math.random().toString(36).substring(7)}`;
    const embedding = await getEmbedding(content);
    results.push({ content, embedding: new Float32Array(embedding) });

    if ((i + 1) % 100 === 0) {
      console.log(`    Generated ${i + 1}/${count} embeddings`);
    }
  }

  return results;
}

/**
 * Generate query embeddings
 */
async function generateQueryEmbeddings(count: number): Promise<Float32Array[]> {
  console.log(`  Generating ${count} query embeddings...`);
  const results: Float32Array[] = [];

  for (let i = 0; i < count; i++) {
    const query = testQueries[i % testQueries.length] + ` query${i}`;
    const embedding = await getEmbedding(query);
    results.push(new Float32Array(embedding));
  }

  return results;
}

/**
 * Brute-force search (current implementation)
 */
function bruteForceSearch(
  queryEmbedding: Float32Array,
  allEmbeddings: { id: number; embedding: Float32Array }[],
  k: number
): { id: number; similarity: number }[] {
  const results = allEmbeddings.map(item => ({
    id: item.id,
    similarity: cosineSimilarity(Array.from(queryEmbedding), Array.from(item.embedding)),
  }));

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, k);
}

/**
 * Run brute-force benchmark
 */
function runBruteForce(
  queryEmbeddings: Float32Array[],
  allEmbeddings: { id: number; embedding: Float32Array }[],
  k: number
): BenchmarkResult {
  const times: number[] = [];

  for (const queryEmb of queryEmbeddings) {
    const start = performance.now();
    bruteForceSearch(queryEmb, allEmbeddings, k);
    times.push(performance.now() - start);
  }

  const totalMs = times.reduce((a, b) => a + b, 0);
  return {
    method: 'Brute-force (JS)',
    vectorCount: allEmbeddings.length,
    queryCount: queryEmbeddings.length,
    totalMs,
    avgMs: totalMs / times.length,
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
    queriesPerSecond: (times.length / totalMs) * 1000,
  };
}

/**
 * Run sqlite-vec benchmark
 */
function runSqliteVec(
  db: Database.Database,
  queryEmbeddings: Float32Array[],
  k: number
): BenchmarkResult {
  const times: number[] = [];

  const stmt = db.prepare(`
    SELECT rowid, distance
    FROM vec_benchmark
    WHERE embedding MATCH ?
      AND k = ?
    ORDER BY distance
  `);

  for (const queryEmb of queryEmbeddings) {
    const start = performance.now();
    stmt.all(float32ToBuffer(queryEmb), k);
    times.push(performance.now() - start);
  }

  const totalMs = times.reduce((a, b) => a + b, 0);
  const vectorCount = (db.prepare('SELECT COUNT(*) as cnt FROM vec_benchmark').get() as { cnt: number }).cnt;

  return {
    method: 'sqlite-vec (indexed)',
    vectorCount,
    queryCount: queryEmbeddings.length,
    totalMs,
    avgMs: totalMs / times.length,
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
    queriesPerSecond: (times.length / totalMs) * 1000,
  };
}

/**
 * Convert Float32Array to Buffer for sqlite-vec
 */
function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Setup sqlite-vec database with test data
 */
function setupSqliteVecDb(embeddings: { content: string; embedding: Float32Array }[]): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);

  // Get vector dimensions from first embedding
  const dims = embeddings[0].embedding.length;

  // Create vec0 virtual table with cosine distance
  db.exec(`
    CREATE VIRTUAL TABLE vec_benchmark USING vec0(
      embedding float[${dims}] distance_metric=cosine
    )
  `);

  // Insert all embeddings (rowid is auto-assigned if not specified)
  const insertStmt = db.prepare('INSERT INTO vec_benchmark(embedding) VALUES (?)');
  const insertMany = db.transaction((items: { content: string; embedding: Float32Array }[]) => {
    for (let i = 0; i < items.length; i++) {
      insertStmt.run(float32ToBuffer(items[i].embedding));
    }
  });

  insertMany(embeddings);

  return db;
}

export interface SqliteVecBenchmarkOptions {
  sizes?: number[];
  queries?: number;
  k?: number;
  json?: boolean;
  model?: string;
}

/**
 * Run sqlite-vec benchmark comparison
 */
export async function benchmarkSqliteVec(options: SqliteVecBenchmarkOptions = {}): Promise<void> {
  const sizes = options.sizes || [100, 500, 1000, 5000];
  const queryCount = options.queries || 50;
  const k = options.k || 10;
  const localModel = options.model || LOCAL_MODEL;

  console.log('═══════════════════════════════════════════════════════════');
  console.log('           SQLITE-VEC vs BRUTE-FORCE BENCHMARK              ');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`\nConfiguration:`);
  console.log(`  Vector sizes: ${sizes.join(', ')}`);
  console.log(`  Queries per size: ${queryCount}`);
  console.log(`  Top-K results: ${k}`);
  console.log(`  Model: ${localModel}`);

  // Setup embedding model
  setConfigOverride({
    llm: { embeddings: { mode: 'local', model: localModel } },
  });
  cleanupEmbeddings();

  // Warm up model
  console.log('\n  Warming up embedding model...');
  await getEmbedding('warmup query');

  // Generate query embeddings once (reused for all sizes)
  const queryEmbeddings = await generateQueryEmbeddings(queryCount);

  const results: ComparisonResult[] = [];

  for (const size of sizes) {
    console.log(`\n┌─────────────────────────────────────────────────────────────┐`);
    console.log(`│ Testing with ${size.toString().padStart(5)} vectors                                 │`);
    console.log(`└─────────────────────────────────────────────────────────────┘`);

    // Generate test embeddings for this size
    const testEmbeddings = await generateTestEmbeddings(size);

    // Prepare data for brute-force
    const bruteForceData = testEmbeddings.map((item, idx) => ({
      id: idx + 1,
      embedding: item.embedding,
    }));

    // Setup sqlite-vec database
    console.log('  Setting up sqlite-vec database...');
    const db = setupSqliteVecDb(testEmbeddings);

    // Run benchmarks
    console.log('  Running brute-force benchmark...');
    const bruteForceResult = runBruteForce(queryEmbeddings, bruteForceData, k);

    console.log('  Running sqlite-vec benchmark...');
    const sqliteVecResult = runSqliteVec(db, queryEmbeddings, k);

    db.close();

    const speedup = bruteForceResult.avgMs / sqliteVecResult.avgMs;
    results.push({
      bruteForce: bruteForceResult,
      sqliteVec: sqliteVecResult,
      speedup,
      memoriesCount: size,
    });

    // Print intermediate results
    console.log(`\n  Results for ${size} vectors:`);
    console.log(`    Brute-force: ${bruteForceResult.avgMs.toFixed(2)}ms avg (${bruteForceResult.queriesPerSecond.toFixed(0)} q/s)`);
    console.log(`    sqlite-vec:  ${sqliteVecResult.avgMs.toFixed(2)}ms avg (${sqliteVecResult.queriesPerSecond.toFixed(0)} q/s)`);
    console.log(`    Speedup:     ${speedup.toFixed(1)}x`);
  }

  // Reset config
  setConfigOverride(null);

  // JSON output
  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Summary table
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('                        SUMMARY                             ');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('\n┌──────────┬─────────────────┬─────────────────┬──────────┐');
  console.log('│ Vectors  │ Brute-force     │ sqlite-vec      │ Speedup  │');
  console.log('├──────────┼─────────────────┼─────────────────┼──────────┤');

  for (const r of results) {
    const vectors = r.memoriesCount.toString().padStart(7);
    const bf = `${r.bruteForce.avgMs.toFixed(2)}ms`.padStart(14);
    const sv = `${r.sqliteVec.avgMs.toFixed(2)}ms`.padStart(14);
    const speedup = `${r.speedup.toFixed(1)}x`.padStart(7);
    console.log(`│ ${vectors} │ ${bf} │ ${sv} │ ${speedup} │`);
  }

  console.log('└──────────┴─────────────────┴─────────────────┴──────────┘');

  // Analysis
  console.log('\nAnalysis:');
  if (results.length > 0) {
    const smallResult = results[0];
    const largeResult = results[results.length - 1];

    console.log(`  At ${smallResult.memoriesCount} vectors: sqlite-vec is ${smallResult.speedup.toFixed(1)}x faster`);
    console.log(`  At ${largeResult.memoriesCount} vectors: sqlite-vec is ${largeResult.speedup.toFixed(1)}x faster`);

    // Calculate scaling
    const bfScaling = largeResult.bruteForce.avgMs / smallResult.bruteForce.avgMs;
    const svScaling = largeResult.sqliteVec.avgMs / smallResult.sqliteVec.avgMs;

    console.log(`  Brute-force scales ${bfScaling.toFixed(1)}x slower (${smallResult.memoriesCount} -> ${largeResult.memoriesCount})`);
    console.log(`  sqlite-vec scales ${svScaling.toFixed(1)}x slower (${smallResult.memoriesCount} -> ${largeResult.memoriesCount})`);

    if (bfScaling > svScaling * 1.5) {
      console.log(`  sqlite-vec has better O() complexity (likely O(log n) vs O(n))`);
    }
  }

  console.log('\nRecommendation:');
  const largeResult = results[results.length - 1];
  if (largeResult && largeResult.speedup > 2) {
    console.log(`  sqlite-vec provides significant speedup at ${largeResult.memoriesCount}+ vectors`);
    console.log(`  Consider migrating to sqlite-vec for production`);
  } else if (largeResult && largeResult.speedup > 1.2) {
    console.log(`  sqlite-vec provides moderate speedup`);
    console.log(`  Migration may be worth it for larger datasets`);
  } else {
    console.log(`  sqlite-vec doesn't provide significant advantage at these sizes`);
    console.log(`  Keep current brute-force implementation`);
  }

  console.log();
}
