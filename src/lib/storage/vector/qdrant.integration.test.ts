/**
 * Integration tests for Qdrant vector store.
 *
 * These tests require a running Qdrant instance.
 * Start with: docker compose -f docker/docker-compose.yml up qdrant -d
 *
 * Tests are skipped if Qdrant is not available.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { QdrantVectorStore, createQdrantVectorStore } from './qdrant.js';

// Unique prefix per test run to avoid conflicts when src/ and dist/ tests run in parallel
const TEST_PREFIX = `succ_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_`;

const TEST_CONFIG = {
  backend: 'sqlite' as const,
  vector: 'qdrant' as const,
  qdrant: {
    url: 'http://localhost:6333',
    collection_prefix: TEST_PREFIX,
  },
};

// Check if Qdrant is available
async function isQdrantAvailable(): Promise<boolean> {
  try {
    // Use root endpoint which returns version info
    const response = await fetch('http://localhost:6333/');
    return response.ok;
  } catch {
    return false;
  }
}

describe('Qdrant Vector Store Integration', async () => {
  const available = await isQdrantAvailable();

  if (!available) {
    it.skip('Qdrant not available - start with: docker compose -f docker/docker-compose.yml up qdrant -d', () => {});
    return;
  }

  let store: QdrantVectorStore;
  const DIMENSIONS = 384;

  beforeAll(async () => {
    store = createQdrantVectorStore(TEST_CONFIG);
    await store.init(DIMENSIONS);
  });

  afterAll(async () => {
    if (store) {
      // Clean up test collections
      try {
        const client = (store as any).client;
        if (client) {
          await client.deleteCollection(`${TEST_PREFIX}documents`).catch(() => {});
          await client.deleteCollection(`${TEST_PREFIX}memories`).catch(() => {});
          await client.deleteCollection(`${TEST_PREFIX}global_memories`).catch(() => {});
        }
      } catch {
        // Ignore cleanup errors
      }
      await store.close();
    }
  });

  describe('Document Vectors', () => {
    beforeEach(async () => {
      // Clear documents collection (re-creates with multi-vector schema + payload indexes)
      const client = (store as any).client;
      if (client) {
        try {
          await client.deleteCollection(`${TEST_PREFIX}documents`);
        } catch {
          // Collection might not exist
        }
        // Brief delay for Qdrant to finish deletion before recreating
        await new Promise(r => setTimeout(r, 200));
        await store.init(DIMENSIONS);
      }
    }, 30_000);

    it('should upsert and search document vector', async () => {
      const embedding = new Array(DIMENSIONS).fill(0).map(() => Math.random());

      await store.upsertDocumentVector(1, embedding);

      const results = await store.searchDocuments(embedding, 10, 0.0);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe(1);
      expect(results[0].similarity).toBeGreaterThan(0.9); // Same vector should be very similar
    });

    it('should batch upsert document vectors', async () => {
      // Use distinct random embeddings
      const embedding1 = new Array(DIMENSIONS).fill(0).map(() => Math.random());
      const embedding2 = new Array(DIMENSIONS).fill(0).map(() => Math.random());
      const embedding3 = new Array(DIMENSIONS).fill(0).map(() => Math.random());

      const items = [
        { id: 1, embedding: embedding1 },
        { id: 2, embedding: embedding2 },
        { id: 3, embedding: embedding3 },
      ];

      await store.upsertDocumentVectorsBatch(items);

      // Search for vector identical to embedding1
      const results = await store.searchDocuments(embedding1, 10, 0.0);

      expect(results.length).toBe(3);
      expect(results[0].id).toBe(1); // Exact match should be first
    });

    it('should delete document vector', async () => {
      const embedding = new Array(DIMENSIONS).fill(0.5);

      await store.upsertDocumentVector(100, embedding);

      // Verify it exists
      let results = await store.searchDocuments(embedding, 10, 0.0);
      const found = results.some(r => r.id === 100);
      expect(found).toBe(true);

      // Delete it
      await store.deleteDocumentVector(100);

      // Verify it's gone
      results = await store.searchDocuments(embedding, 10, 0.0);
      const stillFound = results.some(r => r.id === 100);
      expect(stillFound).toBe(false);
    });

    it('should filter by similarity threshold', async () => {
      // Use distinct random embeddings
      const embedding1 = new Array(DIMENSIONS).fill(0).map(() => Math.random());
      const embedding2 = new Array(DIMENSIONS).fill(0).map(() => Math.random());

      await store.upsertDocumentVector(1, embedding1);
      await store.upsertDocumentVector(2, embedding2);

      // Search with high threshold - only exact match should pass
      const results = await store.searchDocuments(embedding1, 10, 0.99);

      expect(results.length).toBe(1);
      expect(results[0].id).toBe(1);
    });
  });

  describe('Memory Vectors', () => {
    beforeEach(async () => {
      const client = (store as any).client;
      if (client) {
        try {
          await client.deleteCollection(`${TEST_PREFIX}memories`);
        } catch {
          // Collection might not exist
        }
        // Brief delay for Qdrant to finish deletion before recreating
        await new Promise(r => setTimeout(r, 200));
        await store.init(DIMENSIONS);
      }
    }, 30_000);

    it('should upsert and search memory vector', async () => {
      const embedding = new Array(DIMENSIONS).fill(0.7);

      await store.upsertMemoryVector(1, embedding);

      const results = await store.searchMemories(embedding, 10, 0.0);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe(1);
    });

    it('should delete memory vector', async () => {
      const embedding = new Array(DIMENSIONS).fill(0.6);

      await store.upsertMemoryVector(200, embedding);
      await store.deleteMemoryVector(200);

      const results = await store.searchMemories(embedding, 10, 0.9);
      const found = results.some(r => r.id === 200);
      expect(found).toBe(false);
    });
  });

  describe('Global Memory Vectors', () => {
    beforeEach(async () => {
      const client = (store as any).client;
      if (client) {
        try {
          await client.deleteCollection(`${TEST_PREFIX}global_memories`);
        } catch {
          // Collection might not exist
        }
        // Brief delay for Qdrant to finish deletion before recreating
        await new Promise(r => setTimeout(r, 200));
        await store.init(DIMENSIONS);
      }
    }, 30_000);

    it('should upsert and search global memory vector', async () => {
      const embedding = new Array(DIMENSIONS).fill(0.3);

      await store.upsertGlobalMemoryVector(1, embedding);

      const results = await store.searchGlobalMemories(embedding, 10, 0.0);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe(1);
    });

    it('should delete global memory vector', async () => {
      const embedding = new Array(DIMENSIONS).fill(0.4);

      await store.upsertGlobalMemoryVector(300, embedding);
      await store.deleteGlobalMemoryVector(300);

      const results = await store.searchGlobalMemories(embedding, 10, 0.9);
      const found = results.some(r => r.id === 300);
      expect(found).toBe(false);
    });
  });

  describe('Performance', () => {
    it('should handle batch of 1000 vectors', async () => {
      const items = Array.from({ length: 1000 }, (_, i) => ({
        id: i + 1,
        embedding: new Array(DIMENSIONS).fill(0).map(() => Math.random()),
      }));

      const start = Date.now();
      await store.upsertDocumentVectorsBatch(items);
      const elapsed = Date.now() - start;

      console.log(`Batch upsert 1000 vectors: ${elapsed}ms`);
      expect(elapsed).toBeLessThan(10000); // Should complete in < 10s
    });

    it('should search quickly', async () => {
      // Insert some vectors first
      const items = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        embedding: new Array(DIMENSIONS).fill(0).map(() => Math.random()),
      }));
      await store.upsertDocumentVectorsBatch(items);

      const queryEmbedding = new Array(DIMENSIONS).fill(0).map(() => Math.random());

      const start = Date.now();
      const results = await store.searchDocuments(queryEmbedding, 10, 0.0);
      const elapsed = Date.now() - start;

      console.log(`Search 100 vectors: ${elapsed}ms, found ${results.length} results`);
      expect(elapsed).toBeLessThan(1000); // Should complete in < 1s
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
