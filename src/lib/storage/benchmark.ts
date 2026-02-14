/**
 * Storage backend benchmarks.
 *
 * Compares performance across different backend combinations:
 * - SQLite + sqlite-vec (default)
 * - PostgreSQL + pgvector
 * - Qdrant vector store
 *
 * Usage:
 *   npx tsx src/lib/storage/benchmark.ts
 *
 * Requirements:
 *   docker compose -f docker/docker-compose.yml up -d
 */

import { performance } from 'perf_hooks';

// Benchmark configuration
const DIMENSIONS = 384;
const DOCUMENT_COUNT = 1000;
const SEARCH_ITERATIONS = 100;
const BATCH_SIZE = 100;

interface BenchmarkResult {
  name: string;
  operation: string;
  count: number;
  totalMs: number;
  avgMs: number;
  opsPerSec: number;
}

const results: BenchmarkResult[] = [];

function recordResult(name: string, operation: string, count: number, totalMs: number) {
  const avgMs = totalMs / count;
  const opsPerSec = (count / totalMs) * 1000;
  results.push({ name, operation, count, totalMs, avgMs, opsPerSec });
  console.log(
    `  ${operation}: ${totalMs.toFixed(2)}ms total, ${avgMs.toFixed(2)}ms avg, ${opsPerSec.toFixed(1)} ops/sec`
  );
}

function generateEmbedding(): number[] {
  return new Array(DIMENSIONS).fill(0).map(() => Math.random());
}

// ============================================================================
// SQLite + sqlite-vec benchmark
// ============================================================================

async function benchmarkSqliteVec() {
  console.log('\n========================================');
  console.log('SQLite + sqlite-vec (default)');
  console.log('========================================');

  const { getDb, closeDb } = await import('../db/index.js');
  const db = getDb();

  try {
    // Clear existing data
    db.prepare('DELETE FROM documents').run();

    // Benchmark document inserts
    console.log(`\nInserting ${DOCUMENT_COUNT} documents...`);
    const insertStart = performance.now();

    const insertStmt = db.prepare(`
      INSERT INTO documents (file_path, chunk_index, content, start_line, end_line, embedding, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);

    for (let i = 0; i < DOCUMENT_COUNT; i++) {
      const embedding = generateEmbedding();
      const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
      insertStmt.run(`/test/file${i}.ts`, 0, `content ${i}`, 1, 10, embeddingBlob);
    }

    const insertMs = performance.now() - insertStart;
    recordResult('sqlite-vec', 'document_insert', DOCUMENT_COUNT, insertMs);

    // Benchmark vector search
    console.log(`\nSearching ${SEARCH_ITERATIONS} times...`);
    const searchStart = performance.now();

    for (let i = 0; i < SEARCH_ITERATIONS; i++) {
      const queryEmbedding = generateEmbedding();
      const queryBlob = Buffer.from(new Float32Array(queryEmbedding).buffer);

      db.prepare(
        `
        SELECT id, file_path, content,
               vec_distance_cosine(embedding, ?) as distance
        FROM documents
        ORDER BY distance ASC
        LIMIT 10
      `
      ).all(queryBlob);
    }

    const searchMs = performance.now() - searchStart;
    recordResult('sqlite-vec', 'vector_search', SEARCH_ITERATIONS, searchMs);

    // Cleanup
    db.prepare('DELETE FROM documents').run();
  } finally {
    closeDb();
  }
}

// ============================================================================
// PostgreSQL + pgvector benchmark
// ============================================================================

async function benchmarkPostgres() {
  console.log('\n========================================');
  console.log('PostgreSQL + pgvector');
  console.log('========================================');

  try {
    const { createPostgresBackend } = await import('./backends/postgresql.js');

    const backend = createPostgresBackend({
      backend: 'postgresql',
      postgresql: {
        connection_string: 'postgresql://succ:succ_test_password@localhost:5433/succ',
      },
    });

    // Clear existing data
    await backend.clearDocuments();

    // Benchmark document batch inserts
    console.log(`\nBatch inserting ${DOCUMENT_COUNT} documents (batch size ${BATCH_SIZE})...`);

    const batchStart = performance.now();
    const batches = Math.ceil(DOCUMENT_COUNT / BATCH_SIZE);

    for (let b = 0; b < batches; b++) {
      const docs = [];
      for (let i = 0; i < BATCH_SIZE && b * BATCH_SIZE + i < DOCUMENT_COUNT; i++) {
        const idx = b * BATCH_SIZE + i;
        docs.push({
          filePath: `/test/file${idx}.ts`,
          chunkIndex: 0,
          content: `content ${idx}`,
          startLine: 1,
          endLine: 10,
          embedding: generateEmbedding(),
        });
      }
      await backend.upsertDocumentsBatch(docs);
    }

    const batchMs = performance.now() - batchStart;
    recordResult('pgvector', 'document_batch_insert', DOCUMENT_COUNT, batchMs);

    // Benchmark vector search
    console.log(`\nSearching ${SEARCH_ITERATIONS} times...`);
    const searchStart = performance.now();

    for (let i = 0; i < SEARCH_ITERATIONS; i++) {
      await backend.searchDocuments(generateEmbedding(), 10, 0.0);
    }

    const searchMs = performance.now() - searchStart;
    recordResult('pgvector', 'vector_search', SEARCH_ITERATIONS, searchMs);

    // Cleanup
    await backend.clearDocuments();
    await backend.close();
  } catch (error: any) {
    console.log(`  Skipped: ${error.message}`);
  }
}

// ============================================================================
// Qdrant benchmark
// ============================================================================

async function benchmarkQdrant() {
  console.log('\n========================================');
  console.log('Qdrant Vector Store');
  console.log('========================================');

  try {
    // Check if Qdrant is available
    const response = await fetch('http://localhost:6333/');
    if (!response.ok) throw new Error('Qdrant not ready');

    const { createQdrantVectorStore } = await import('./vector/qdrant.js');

    const store = createQdrantVectorStore({
      backend: 'sqlite',
      vector: 'qdrant',
      qdrant: {
        url: 'http://localhost:6333',
        collection_prefix: 'succ_bench_',
      },
    });

    await store.init(DIMENSIONS);

    // Benchmark batch inserts
    console.log(`\nBatch inserting ${DOCUMENT_COUNT} vectors (batch size ${BATCH_SIZE})...`);
    const batchStart = performance.now();

    const batches = Math.ceil(DOCUMENT_COUNT / BATCH_SIZE);
    for (let b = 0; b < batches; b++) {
      const items = [];
      for (let i = 0; i < BATCH_SIZE && b * BATCH_SIZE + i < DOCUMENT_COUNT; i++) {
        const idx = b * BATCH_SIZE + i;
        items.push({ id: idx, embedding: generateEmbedding() });
      }
      await store.upsertDocumentVectorsBatch(items);
    }

    const batchMs = performance.now() - batchStart;
    recordResult('qdrant', 'vector_batch_insert', DOCUMENT_COUNT, batchMs);

    // Benchmark search
    console.log(`\nSearching ${SEARCH_ITERATIONS} times...`);
    const searchStart = performance.now();

    for (let i = 0; i < SEARCH_ITERATIONS; i++) {
      await store.searchDocuments(generateEmbedding(), 10, 0.0);
    }

    const searchMs = performance.now() - searchStart;
    recordResult('qdrant', 'vector_search', SEARCH_ITERATIONS, searchMs);

    // Cleanup - access private client via type assertion for benchmark cleanup
    const client = (store as any).client;
    await client.deleteCollection('succ_bench_documents').catch(() => {});
    await store.close();
  } catch (error: any) {
    console.log(`  Skipped: ${error.message}`);
  }
}

// ============================================================================
// Summary
// ============================================================================

function printSummary() {
  console.log('\n========================================');
  console.log('BENCHMARK SUMMARY');
  console.log('========================================\n');

  // Group by operation
  const operations = [...new Set(results.map((r) => r.operation))];

  for (const op of operations) {
    console.log(`${op}:`);
    const opResults = results.filter((r) => r.operation === op);
    opResults.sort((a, b) => a.avgMs - b.avgMs);

    for (const r of opResults) {
      const bar = '█'.repeat(Math.min(50, Math.round(r.opsPerSec / 10)));
      console.log(
        `  ${r.name.padEnd(15)} ${r.avgMs.toFixed(2).padStart(8)}ms  ${r.opsPerSec.toFixed(1).padStart(8)} ops/sec  ${bar}`
      );
    }
    console.log();
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('Storage Backend Benchmarks');
  console.log(
    `Documents: ${DOCUMENT_COUNT}, Searches: ${SEARCH_ITERATIONS}, Dimensions: ${DIMENSIONS}`
  );

  await benchmarkSqliteVec();
  await benchmarkPostgres();
  await benchmarkQdrant();

  printSummary();
}

main().catch(console.error);
