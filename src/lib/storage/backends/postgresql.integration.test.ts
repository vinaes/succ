/**
 * Integration tests for PostgreSQL backend.
 *
 * These tests require a running PostgreSQL instance with pgvector extension.
 * Start with: docker compose -f docker/docker-compose.yml up postgres -d
 *
 * Tests are skipped if PostgreSQL is not available.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgresBackend, createPostgresBackend } from './postgresql.js';

const TEST_CONFIG = {
  backend: 'postgresql' as const,
  postgresql: {
    connection_string: 'postgresql://succ:succ_test_password@localhost:5433/succ',
  },
};

// Check if PostgreSQL is available by actually connecting
async function isPostgresAvailable(): Promise<boolean> {
  try {
    const backend = createPostgresBackend(TEST_CONFIG);
    // Actually try to connect and query
    await backend.getDocumentStats();
    await backend.close();
    return true;
  } catch {
    return false;
  }
}

describe('PostgreSQL Backend Integration', async () => {
  const available = await isPostgresAvailable();

  if (!available) {
    it.skip('PostgreSQL not available - start with: docker compose -f docker/docker-compose.yml up postgres -d', () => {});
    return;
  }

  let backend: PostgresBackend;

  beforeAll(async () => {
    backend = createPostgresBackend(TEST_CONFIG);
  });

  afterAll(async () => {
    if (backend) {
      await backend.close();
    }
  });

  describe('Document Operations', () => {
    beforeEach(async () => {
      await backend.clearDocuments();
    });

    it('should upsert and search documents', async () => {
      const embedding = new Array(384).fill(0).map(() => Math.random());

      await backend.upsertDocumentsBatch([{
        filePath: '/test/file.ts',
        chunkIndex: 0,
        content: 'const x = 1;',
        startLine: 1,
        endLine: 5,
        embedding,
      }]);

      const results = await backend.searchDocuments(embedding, 10, 0.0);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].file_path).toBe('/test/file.ts');
    });

    it('should batch upsert documents', async () => {
      const docs = [
        {
          filePath: '/test/a.ts',
          chunkIndex: 0,
          content: 'a',
          startLine: 1,
          endLine: 1,
          embedding: new Array(384).fill(0.1),
        },
        {
          filePath: '/test/b.ts',
          chunkIndex: 0,
          content: 'b',
          startLine: 1,
          endLine: 1,
          embedding: new Array(384).fill(0.2),
        },
      ];

      await backend.upsertDocumentsBatch(docs);

      const stats = await backend.getDocumentStats();
      expect(stats.total_documents).toBeGreaterThanOrEqual(2);
    });

    it('should delete documents by path', async () => {
      await backend.upsertDocumentsBatch([{
        filePath: '/test/delete.ts',
        chunkIndex: 0,
        content: 'to delete',
        startLine: 1,
        endLine: 1,
        embedding: new Array(384).fill(0),
      }]);

      const deleted = await backend.deleteDocumentsByPath('/test/delete.ts');
      expect(deleted.length).toBeGreaterThan(0);
    });

    it('should search documents by vector similarity', async () => {
      // Use distinct random embeddings for deterministic matching
      const embedding1 = new Array(384).fill(0).map(() => Math.random());
      const embedding2 = new Array(384).fill(0).map(() => Math.random());

      await backend.upsertDocumentsBatch([
        {
          filePath: '/test/similar.ts',
          chunkIndex: 0,
          content: 'similar content',
          startLine: 1,
          endLine: 1,
          embedding: embedding1,
        },
        {
          filePath: '/test/different.ts',
          chunkIndex: 0,
          content: 'different content',
          startLine: 1,
          endLine: 1,
          embedding: embedding2,
        },
      ]);

      // Search with exact embedding1 - should find /test/similar.ts first
      const results = await backend.searchDocuments(embedding1, 10, 0.0);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].file_path).toBe('/test/similar.ts');
    });
  });

  describe('Memory Operations', () => {
    it('should save and retrieve memory', async () => {
      const embedding = new Array(384).fill(0.5);

      // saveMemory signature: (content, embedding, tags, source, type, ...)
      const id = await backend.saveMemory(
        'Test memory content',
        embedding,
        ['test', 'integration'],
        'test-suite',
        'observation'
      );

      expect(id).toBeGreaterThan(0);

      const memory = await backend.getMemoryById(id);
      expect(memory).not.toBeNull();
      expect(memory!.content).toBe('Test memory content');
      expect(memory!.tags).toEqual(['test', 'integration']);
      expect(memory!.type).toBe('observation');

      // Cleanup
      await backend.deleteMemory(id);
    });

    it('should get recent memories', async () => {
      const embedding = new Array(384).fill(0.5);

      const id1 = await backend.saveMemory('Memory 1', embedding);
      const id2 = await backend.saveMemory('Memory 2', embedding);

      const recent = await backend.getRecentMemories(10);
      expect(recent.length).toBeGreaterThanOrEqual(2);

      // Cleanup
      await backend.deleteMemory(id1);
      await backend.deleteMemory(id2);
    });

    it('should delete memory', async () => {
      const embedding = new Array(384).fill(0.5);

      const id = await backend.saveMemory('To be deleted', embedding);

      const deleted = await backend.deleteMemory(id);
      expect(deleted).toBe(true);

      const memory = await backend.getMemoryById(id);
      expect(memory).toBeNull();
    });

    it('should search memories by vector similarity', async () => {
      const embedding1 = new Array(384).fill(0.2);
      const embedding2 = new Array(384).fill(0.8);

      const id1 = await backend.saveMemory('First memory', embedding1);
      const id2 = await backend.saveMemory('Second memory', embedding2);

      const queryEmbedding = new Array(384).fill(0.2);
      const results = await backend.searchMemories(queryEmbedding, 10, 0.0);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toBe('First memory');

      // Cleanup
      await backend.deleteMemory(id1);
      await backend.deleteMemory(id2);
    });
  });

  describe('Memory Links', () => {
    it('should create and retrieve memory links', async () => {
      const embedding = new Array(384).fill(0.5);

      const id1 = await backend.saveMemory('Memory A', embedding);
      const id2 = await backend.saveMemory('Memory B', embedding);

      const linkResult = await backend.createMemoryLink(
        id1,
        id2,
        'related',
        0.8
      );

      expect(linkResult.id).toBeGreaterThan(0);
      expect(linkResult.created).toBe(true);

      const links = await backend.getMemoryLinks(id1);
      expect(links.outgoing).toHaveLength(1);
      expect(links.outgoing[0].target_id).toBe(id2);
      expect(links.outgoing[0].relation).toBe('related');

      // Cleanup
      await backend.deleteMemoryLink(id1, id2, 'related');
      await backend.deleteMemory(id1);
      await backend.deleteMemory(id2);
    });
  });

  describe('File Hashes', () => {
    it('should set and get file hash', async () => {
      await backend.setFileHash('/test/file.ts', 'abc123');

      const hash = await backend.getFileHash('/test/file.ts');
      expect(hash).toBe('abc123');

      // Cleanup
      await backend.deleteFileHash('/test/file.ts');
    });

    it('should return null for non-existent hash', async () => {
      const hash = await backend.getFileHash('/non/existent.ts');
      expect(hash).toBeNull();
    });

    it('should get all file hashes', async () => {
      await backend.setFileHash('/test/a.ts', 'hash1');
      await backend.setFileHash('/test/b.ts', 'hash2');

      const hashes = await backend.getAllFileHashes();
      expect(hashes.get('/test/a.ts')).toBe('hash1');
      expect(hashes.get('/test/b.ts')).toBe('hash2');

      // Cleanup
      await backend.deleteFileHash('/test/a.ts');
      await backend.deleteFileHash('/test/b.ts');
    });
  });

  describe('Token Stats', () => {
    it('should record and retrieve token stats', async () => {
      await backend.recordTokenStat({
        event_type: 'search',
        query: 'test query',
        returned_tokens: 100,
        full_source_tokens: 1000,
        savings_tokens: 900,
        files_count: 5,
        chunks_count: 10,
        model: 'test-model',
      });

      const summary = await backend.getTokenStatsSummary();
      expect(summary.total_queries).toBeGreaterThanOrEqual(1);
      expect(summary.total_returned_tokens).toBeGreaterThanOrEqual(100);
    });
  });
});
