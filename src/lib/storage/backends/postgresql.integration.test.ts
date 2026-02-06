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

const TEST_PROJECT_ID = 'test/project';

// Check if PostgreSQL is available by actually connecting
async function isPostgresAvailable(): Promise<boolean> {
  try {
    const backend = createPostgresBackend(TEST_CONFIG);
    backend.setProjectId(TEST_PROJECT_ID);
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
    backend.setProjectId(TEST_PROJECT_ID);
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

  // ==========================================================================
  // NEW: Global Memory Operations
  // ==========================================================================

  describe('Global Memory Operations', () => {
    it('should save and search global memories', async () => {
      const embedding = new Array(384).fill(0.3);

      const id = await backend.saveGlobalMemory(
        'Global knowledge about TypeScript patterns',
        embedding,
        ['typescript', 'patterns'],
        'learning'
      );

      expect(id).toBeGreaterThan(0);

      const results = await backend.searchGlobalMemories(embedding, 5, 0.0);
      expect(results.length).toBeGreaterThan(0);
      expect(results.some(r => r.content.includes('TypeScript patterns'))).toBe(true);

      // Cleanup
      await backend.deleteGlobalMemory(id);
    });

    it('should get recent global memories', async () => {
      const embedding = new Array(384).fill(0.4);

      const id1 = await backend.saveGlobalMemory('Global mem 1', embedding, ['test']);
      const id2 = await backend.saveGlobalMemory('Global mem 2', embedding, ['test']);

      const recent = await backend.getRecentGlobalMemories(10);
      expect(recent.length).toBeGreaterThanOrEqual(2);

      // Cleanup
      await backend.deleteGlobalMemory(id1);
      await backend.deleteGlobalMemory(id2);
    });

    it('should delete global memory', async () => {
      const embedding = new Array(384).fill(0.5);

      const id = await backend.saveGlobalMemory('To delete globally', embedding);
      const deleted = await backend.deleteGlobalMemory(id);
      expect(deleted).toBe(true);

      // Verify it's gone from recent
      const recent = await backend.getRecentGlobalMemories(100);
      expect(recent.some(r => r.id === id)).toBe(false);
    });

    it('should get global memory stats', async () => {
      const embedding = new Array(384).fill(0.5);

      const id = await backend.saveGlobalMemory('Stats test', embedding, ['stats']);

      const stats = await backend.getGlobalMemoryStats();
      expect(stats.total).toBeGreaterThanOrEqual(1);
      expect(typeof stats.by_type).toBe('object');

      // Cleanup
      await backend.deleteGlobalMemory(id);
    });
  });

  // ==========================================================================
  // NEW: Skills Operations
  // ==========================================================================

  describe('Skills Operations', () => {
    const testSkillName = `test-skill-${Date.now()}`;

    afterAll(async () => {
      // Clean up test skill
      try { await backend.deleteSkill(testSkillName); } catch {}
    });

    it('should upsert and get all skills', async () => {
      await backend.upsertSkill({
        name: testSkillName,
        description: 'A test skill for integration testing',
        source: 'local',
      });

      const skills = await backend.getAllSkills();
      const found = skills.find(s => s.name === testSkillName);
      expect(found).toBeDefined();
      expect(found!.description).toContain('test skill');
    });

    it('should search skills', async () => {
      // Ensure test skill exists
      await backend.upsertSkill({
        name: testSkillName,
        description: 'A test skill for searching',
        source: 'local',
      });

      const results = await backend.searchSkills('test skill', 10);
      expect(results.length).toBeGreaterThan(0);
    });

    it('should get skill by name', async () => {
      const skill = await backend.getSkillByName(testSkillName);
      expect(skill).not.toBeNull();
      expect(skill!.name).toBe(testSkillName);
    });

    it('should track skill usage', async () => {
      // Get usage from getAllSkills (which returns usageCount)
      const beforeSkills = await backend.getAllSkills();
      const before = beforeSkills.find(s => s.name === testSkillName);
      const beforeCount = before?.usageCount || 0;

      await backend.trackSkillUsage(testSkillName);

      const afterSkills = await backend.getAllSkills();
      const after = afterSkills.find(s => s.name === testSkillName);
      expect(after!.usageCount).toBe(beforeCount + 1);
    });

    it('should delete skill', async () => {
      const tempName = `temp-skill-${Date.now()}`;
      await backend.upsertSkill({
        name: tempName,
        description: 'Temporary skill to delete',
        source: 'local',
      });

      const deleted = await backend.deleteSkill(tempName);
      expect(deleted).toBe(true);

      const skill = await backend.getSkillByName(tempName);
      expect(skill).toBeNull();
    });
  });

  // ==========================================================================
  // NEW: Metadata Operations
  // ==========================================================================

  describe('Metadata Operations', () => {
    it('should set and get metadata', async () => {
      await backend.setMetadata('test_key', 'test_value_123');

      const value = await backend.getMetadata('test_key');
      expect(value).toBe('test_value_123');

      // Cleanup by overwriting
      await backend.setMetadata('test_key', '');
    });

    it('should return null for non-existent metadata key', async () => {
      const value = await backend.getMetadata('nonexistent_key_xyz');
      expect(value).toBeNull();
    });
  });

  // ==========================================================================
  // NEW: Graph Stats
  // ==========================================================================

  describe('Graph Stats', () => {
    it('should return graph statistics', async () => {
      const stats = await backend.getGraphStats();

      expect(typeof stats.total_memories).toBe('number');
      expect(typeof stats.total_links).toBe('number');
      expect(typeof stats.avg_links_per_memory).toBe('number');
    });
  });

  // ==========================================================================
  // NEW: Additional Document & Memory Operations
  // ==========================================================================

  describe('Additional Operations', () => {
    it('should clear all documents', async () => {
      const embedding = new Array(384).fill(0.1);

      await backend.upsertDocumentsBatch([{
        filePath: '/test/clear.ts',
        chunkIndex: 0,
        content: 'to be cleared',
        startLine: 1,
        endLine: 1,
        embedding,
      }]);

      await backend.clearDocuments();

      const stats = await backend.getDocumentStats();
      expect(stats.total_documents).toBe(0);
    });

    it('should return document stats', async () => {
      const stats = await backend.getDocumentStats();

      expect(typeof stats.total_documents).toBe('number');
      expect(typeof stats.total_files).toBe('number');
    });

    it('should increment memory access count', async () => {
      const embedding = new Array(384).fill(0.5);

      const id = await backend.saveMemory('Access count test', embedding);

      await backend.incrementMemoryAccess(id, 1.0);
      await backend.incrementMemoryAccess(id, 0.5);

      const memory = await backend.getMemoryById(id);
      expect(memory!.access_count).toBeGreaterThanOrEqual(2);

      // Cleanup
      await backend.deleteMemory(id);
    });

    it('should return null for non-existent memory ID', async () => {
      const memory = await backend.getMemoryById(999999);
      expect(memory).toBeNull();
    });
  });
});
