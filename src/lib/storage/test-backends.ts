/**
 * Test all storage backend combinations with real data.
 *
 * Usage:
 *   npx tsx src/lib/storage/test-backends.ts
 *
 * Requirements:
 *   docker compose -f docker/docker-compose.yml up -d
 */

import { performance } from 'perf_hooks';

interface BackendTestResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  memorySaveMs?: number;
  memorySearchMs?: number;
  memoryCount?: number;
  error?: string;
}

const results: BackendTestResult[] = [];

// Test data - sample memories with embeddings
function generateEmbedding(seed: number): number[] {
  // Deterministic pseudo-random based on seed
  const embedding = new Array(384).fill(0);
  for (let i = 0; i < 384; i++) {
    embedding[i] = Math.sin(seed * (i + 1) * 0.1) * 0.5 + 0.5;
  }
  return embedding;
}

const TEST_MEMORIES = [
  { content: 'Storage abstraction supports multiple backends', tags: ['decision', 'architecture'], type: 'decision' as const },
  { content: 'PostgreSQL with pgvector for production deployments', tags: ['learning', 'postgres'], type: 'learning' as const },
  { content: 'Qdrant for high-performance vector search', tags: ['learning', 'qdrant'], type: 'learning' as const },
  { content: 'SQLite remains default for local development', tags: ['decision'], type: 'decision' as const },
  { content: 'Export/import enables migration between backends', tags: ['feature'], type: 'observation' as const },
];

// ============================================================================
// Test 1: SQLite + sqlite-vec (default)
// ============================================================================

async function testSqliteDefault(): Promise<BackendTestResult> {
  console.log('\n========================================');
  console.log('Test 1: SQLite + sqlite-vec (default)');
  console.log('========================================');

  try {
    const { getDb, closeDb, saveMemory, searchMemories, getMemoryStats, deleteMemory } = await import('../db/index.js');
    const { getEmbedding } = await import('../embeddings.js');

    // Save test memories
    console.log('\nSaving test memories...');
    const saveStart = performance.now();
    const savedIds: number[] = [];

    for (let i = 0; i < TEST_MEMORIES.length; i++) {
      const m = TEST_MEMORIES[i];
      const embedding = await getEmbedding(m.content);
      const result = saveMemory(m.content, embedding, m.tags, 'test-backends', { type: m.type, deduplicate: false });
      savedIds.push(result.id);
    }

    const saveMs = performance.now() - saveStart;
    console.log(`  Saved ${savedIds.length} memories in ${saveMs.toFixed(0)}ms`);

    // Search memories
    console.log('\nSearching memories...');
    const searchStart = performance.now();
    const queryEmbedding = await getEmbedding('PostgreSQL production');
    const searchResults = await searchMemories(queryEmbedding, 5, 0.0);
    const searchMs = performance.now() - searchStart;

    console.log(`  Found ${searchResults.length} results in ${searchMs.toFixed(0)}ms`);
    if (searchResults.length > 0) {
      console.log(`  Top result: "${searchResults[0].content.substring(0, 50)}..."`);
    }

    // Get stats
    const stats = getMemoryStats();
    console.log(`\n  Total memories in DB: ${stats.total_memories}`);

    // Cleanup test memories
    console.log('\nCleaning up test memories...');
    for (const id of savedIds) {
      await deleteMemory(id);
    }

    closeDb();

    return {
      name: 'SQLite + sqlite-vec',
      status: 'pass',
      memorySaveMs: saveMs,
      memorySearchMs: searchMs,
      memoryCount: stats.total_memories,
    };
  } catch (error: any) {
    console.error(`  Error: ${error.message}`);
    return {
      name: 'SQLite + sqlite-vec',
      status: 'fail',
      error: error.message,
    };
  }
}

// ============================================================================
// Test 2: PostgreSQL + pgvector
// ============================================================================

async function testPostgresPgvector(): Promise<BackendTestResult> {
  console.log('\n========================================');
  console.log('Test 2: PostgreSQL + pgvector');
  console.log('========================================');

  try {
    const { createPostgresBackend } = await import('./backends/postgresql.js');
    const { getEmbedding } = await import('../embeddings.js');

    const backend = createPostgresBackend({
      backend: 'postgresql',
      postgresql: {
        connection_string: 'postgresql://succ:succ_test_password@localhost:5433/succ',
      },
    });

    // Save test memories
    console.log('\nSaving test memories...');
    const saveStart = performance.now();
    const savedIds: number[] = [];

    for (let i = 0; i < TEST_MEMORIES.length; i++) {
      const m = TEST_MEMORIES[i];
      const embedding = await getEmbedding(m.content);
      const id = await backend.saveMemory(m.content, embedding, m.tags, 'test-backends', m.type);
      savedIds.push(id);
    }

    const saveMs = performance.now() - saveStart;
    console.log(`  Saved ${savedIds.length} memories in ${saveMs.toFixed(0)}ms`);

    // Search memories
    console.log('\nSearching memories...');
    const searchStart = performance.now();
    const queryEmbedding = await getEmbedding('PostgreSQL production');
    const searchResults = await backend.searchMemories(queryEmbedding, 5, 0.0);
    const searchMs = performance.now() - searchStart;

    console.log(`  Found ${searchResults.length} results in ${searchMs.toFixed(0)}ms`);
    if (searchResults.length > 0) {
      console.log(`  Top result: "${searchResults[0].content.substring(0, 50)}..."`);
    }

    // Get recent to count
    const recent = await backend.getRecentMemories(1000);
    console.log(`\n  Total memories in DB: ${recent.length}`);

    // Cleanup test memories
    console.log('\nCleaning up test memories...');
    for (const id of savedIds) {
      await backend.deleteMemory(id);
    }

    await backend.close();

    return {
      name: 'PostgreSQL + pgvector',
      status: 'pass',
      memorySaveMs: saveMs,
      memorySearchMs: searchMs,
      memoryCount: recent.length,
    };
  } catch (error: any) {
    console.error(`  Error: ${error.message}`);
    return {
      name: 'PostgreSQL + pgvector',
      status: 'fail',
      error: error.message,
    };
  }
}

// ============================================================================
// Test 3: PostgreSQL + Qdrant
// ============================================================================

async function testPostgresQdrant(): Promise<BackendTestResult> {
  console.log('\n========================================');
  console.log('Test 3: PostgreSQL + Qdrant');
  console.log('========================================');

  try {
    // Check Qdrant availability
    const qdrantResponse = await fetch('http://localhost:6333/');
    if (!qdrantResponse.ok) {
      return { name: 'PostgreSQL + Qdrant', status: 'skip', error: 'Qdrant not available' };
    }

    const { createPostgresBackend } = await import('./backends/postgresql.js');
    const { createQdrantVectorStore } = await import('./vector/qdrant.js');
    const { getEmbedding } = await import('../embeddings.js');

    const backend = createPostgresBackend({
      backend: 'postgresql',
      postgresql: {
        connection_string: 'postgresql://succ:succ_test_password@localhost:5433/succ',
      },
    });

    const vectorStore = createQdrantVectorStore({
      backend: 'postgresql',
      vector: 'qdrant',
      qdrant: {
        url: 'http://localhost:6333',
        collection_prefix: 'succ_pg_',
      },
    });

    await vectorStore.init(384);

    // Save test memories (to both PostgreSQL and Qdrant)
    console.log('\nSaving test memories...');
    const saveStart = performance.now();
    const savedIds: number[] = [];

    for (let i = 0; i < TEST_MEMORIES.length; i++) {
      const m = TEST_MEMORIES[i];
      const embedding = await getEmbedding(m.content);

      // Save to PostgreSQL (metadata)
      const id = await backend.saveMemory(m.content, embedding, m.tags, 'test-backends', m.type);
      savedIds.push(id);

      // Save to Qdrant (vector)
      await vectorStore.upsertMemoryVector(id, embedding);
    }

    const saveMs = performance.now() - saveStart;
    console.log(`  Saved ${savedIds.length} memories in ${saveMs.toFixed(0)}ms`);

    // Search using Qdrant vectors
    console.log('\nSearching memories via Qdrant...');
    const searchStart = performance.now();
    const queryEmbedding = await getEmbedding('PostgreSQL production');
    const vectorResults = await vectorStore.searchMemories(queryEmbedding, 5, 0.0);
    const searchMs = performance.now() - searchStart;

    console.log(`  Found ${vectorResults.length} vector results in ${searchMs.toFixed(0)}ms`);

    // Get memory details from PostgreSQL
    if (vectorResults.length > 0) {
      const memory = await backend.getMemoryById(vectorResults[0].id);
      if (memory) {
        console.log(`  Top result: "${memory.content.substring(0, 50)}..."`);
      }
    }

    // Cleanup
    console.log('\nCleaning up test memories...');
    for (const id of savedIds) {
      await backend.deleteMemory(id);
      await vectorStore.deleteMemoryVector(id);
    }

    await backend.close();
    await vectorStore.close();

    return {
      name: 'PostgreSQL + Qdrant',
      status: 'pass',
      memorySaveMs: saveMs,
      memorySearchMs: searchMs,
      memoryCount: savedIds.length,
    };
  } catch (error: any) {
    console.error(`  Error: ${error.message}`);
    return {
      name: 'PostgreSQL + Qdrant',
      status: 'fail',
      error: error.message,
    };
  }
}

// ============================================================================
// Test 4: SQLite + Qdrant
// ============================================================================

async function testSqliteQdrant(): Promise<BackendTestResult> {
  console.log('\n========================================');
  console.log('Test 4: SQLite + Qdrant');
  console.log('========================================');

  try {
    // Check Qdrant availability
    const qdrantResponse = await fetch('http://localhost:6333/');
    if (!qdrantResponse.ok) {
      return { name: 'SQLite + Qdrant', status: 'skip', error: 'Qdrant not available' };
    }

    const { getDb, closeDb, saveMemory, deleteMemory, getMemoryById } = await import('../db/index.js');
    const { createQdrantVectorStore } = await import('./vector/qdrant.js');
    const { getEmbedding } = await import('../embeddings.js');

    const vectorStore = createQdrantVectorStore({
      backend: 'sqlite',
      vector: 'qdrant',
      qdrant: {
        url: 'http://localhost:6333',
        collection_prefix: 'succ_sqlite_',
      },
    });

    await vectorStore.init(384);

    // Save test memories (to both SQLite and Qdrant)
    console.log('\nSaving test memories...');
    const saveStart = performance.now();
    const savedIds: number[] = [];

    for (let i = 0; i < TEST_MEMORIES.length; i++) {
      const m = TEST_MEMORIES[i];
      const embedding = await getEmbedding(m.content);

      // Save to SQLite (metadata + embedding)
      const result = saveMemory(m.content, embedding, m.tags, 'test-backends', { type: m.type, deduplicate: false });
      savedIds.push(result.id);

      // Save to Qdrant (vector only)
      await vectorStore.upsertMemoryVector(result.id, embedding);
    }

    const saveMs = performance.now() - saveStart;
    console.log(`  Saved ${savedIds.length} memories in ${saveMs.toFixed(0)}ms`);

    // Search using Qdrant vectors
    console.log('\nSearching memories via Qdrant...');
    const searchStart = performance.now();
    const queryEmbedding = await getEmbedding('PostgreSQL production');
    const vectorResults = await vectorStore.searchMemories(queryEmbedding, 5, 0.0);
    const searchMs = performance.now() - searchStart;

    console.log(`  Found ${vectorResults.length} vector results in ${searchMs.toFixed(0)}ms`);

    // Get memory details from SQLite
    if (vectorResults.length > 0) {
      const memory = getMemoryById(vectorResults[0].id);
      if (memory) {
        console.log(`  Top result: "${memory.content.substring(0, 50)}..."`);
      }
    }

    // Cleanup
    console.log('\nCleaning up test memories...');
    for (const id of savedIds) {
      await deleteMemory(id);
      await vectorStore.deleteMemoryVector(id);
    }

    closeDb();
    await vectorStore.close();

    return {
      name: 'SQLite + Qdrant',
      status: 'pass',
      memorySaveMs: saveMs,
      memorySearchMs: searchMs,
      memoryCount: savedIds.length,
    };
  } catch (error: any) {
    console.error(`  Error: ${error.message}`);
    return {
      name: 'SQLite + Qdrant',
      status: 'fail',
      error: error.message,
    };
  }
}

// ============================================================================
// Summary
// ============================================================================

function printSummary() {
  console.log('\n========================================');
  console.log('BACKEND TEST SUMMARY');
  console.log('========================================\n');

  console.log('| Backend                | Status | Save (ms) | Search (ms) |');
  console.log('|------------------------|--------|-----------|-------------|');

  for (const r of results) {
    const status = r.status === 'pass' ? '✓ PASS' : r.status === 'fail' ? '✗ FAIL' : '○ SKIP';
    const save = r.memorySaveMs ? r.memorySaveMs.toFixed(0).padStart(6) : '     -';
    const search = r.memorySearchMs ? r.memorySearchMs.toFixed(0).padStart(8) : '       -';
    console.log(`| ${r.name.padEnd(22)} | ${status} | ${save}    | ${search}    |`);
  }

  console.log('');

  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const skipped = results.filter(r => r.status === 'skip').length;

  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);

  if (failed > 0) {
    console.log('\nFailures:');
    for (const r of results.filter(r => r.status === 'fail')) {
      console.log(`  ${r.name}: ${r.error}`);
    }
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('Testing All Storage Backend Combinations');
  console.log('========================================');

  results.push(await testSqliteDefault());
  results.push(await testPostgresPgvector());
  results.push(await testPostgresQdrant());
  results.push(await testSqliteQdrant());

  printSummary();
}

main().catch(console.error);
