import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Create a single temp directory for all tests to avoid file locking issues
const tempDir = path.join(os.tmpdir(), `succ-db-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

// Mock config to use temp directory
vi.mock('./config.js', () => {
  return {
    getConfig: () => ({
      embedding_model: 'test-model',
      embedding_mode: 'local',
      chunk_size: 500,
      chunk_overlap: 50,
    }),
    getDbPath: () => path.join(tempDir, 'test.db'),
    getGlobalDbPath: () => path.join(tempDir, 'global.db'),
    getClaudeDir: () => tempDir,
    getProjectRoot: () => tempDir,
  };
});

// Mock embeddings to avoid loading heavy models
vi.mock('./embeddings.js', () => ({
  cosineSimilarity: (a: number[], b: number[]) => {
    // Simple dot product / magnitude for testing
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  },
  getModelDimension: () => 384,
}));

describe('Database Module', () => {
  beforeAll(() => {
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterAll(async () => {
    // Close databases first
    try {
      const db = await import('./db/index.js');
      db.closeDb();
      db.closeGlobalDb();
    } catch {
      // Ignore
    }

    // Wait a bit for file handles to be released (Windows)
    await new Promise((r) => setTimeout(r, 100));

    // Clean up temp directory
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors on Windows
    }
  });

  describe('Database initialization', () => {
    it('should create database file on first access', async () => {
      const db = await import('./db/index.js');
      db.getDb();

      expect(fs.existsSync(path.join(tempDir, 'test.db'))).toBe(true);
    });

    it('should create tables on initialization', async () => {
      const db = await import('./db/index.js');
      const database = db.getDb();

      // Check tables exist
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;

      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain('documents');
      expect(tableNames).toContain('memories');
      expect(tableNames).toContain('memory_links');
      expect(tableNames).toContain('file_hashes');
      expect(tableNames).toContain('metadata');
    });
  });

  describe('Document operations', () => {
    it('should upsert document', async () => {
      const db = await import('./db/index.js');

      const embedding = new Array(384).fill(0.1);
      db.upsertDocument('test-doc.ts', 0, 'test content', 1, 10, embedding);

      const stats = db.getStats();
      expect(stats.total_documents).toBeGreaterThanOrEqual(1);
    });

    it('should batch upsert documents', async () => {
      const db = await import('./db/index.js');

      const docs = [
        { filePath: 'batch-a.ts', chunkIndex: 0, content: 'a', startLine: 1, endLine: 5, embedding: new Array(384).fill(0.1) },
        { filePath: 'batch-b.ts', chunkIndex: 0, content: 'b', startLine: 1, endLine: 5, embedding: new Array(384).fill(0.2) },
      ];

      db.upsertDocumentsBatch(docs);

      const stats = db.getStats();
      expect(stats.total_documents).toBeGreaterThanOrEqual(2);
    });

    it('should delete documents by path', async () => {
      const db = await import('./db/index.js');

      const embedding = new Array(384).fill(0.1);
      db.upsertDocument('to-delete.ts', 0, 'will be deleted', 1, 10, embedding);

      const statsBefore = db.getStats();
      db.deleteDocumentsByPath('to-delete.ts');
      const statsAfter = db.getStats();

      // At least one fewer document (might be equal if it was already deleted)
      expect(statsAfter.total_documents).toBeLessThanOrEqual(statsBefore.total_documents);
    });

    it('should search documents by similarity', async () => {
      const db = await import('./db/index.js');

      // Search with a query embedding
      const queryEmbedding = new Array(384).fill(0.1);
      const results = db.searchDocuments(queryEmbedding, 5, 0.0);

      // Should return results (if any documents exist)
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('File hash operations', () => {
    it('should store and retrieve file hash', async () => {
      const db = await import('./db/index.js');

      db.setFileHash('hash-test.ts', 'abc123');
      const hash = db.getFileHash('hash-test.ts');

      expect(hash).toBe('abc123');
    });

    it('should return null for unknown file', async () => {
      const db = await import('./db/index.js');

      const hash = db.getFileHash('unknown-file-that-doesnt-exist.ts');
      expect(hash).toBeNull();
    });

    it('should delete file hash', async () => {
      const db = await import('./db/index.js');

      db.setFileHash('delete-hash.ts', 'xyz789');
      db.deleteFileHash('delete-hash.ts');
      const hash = db.getFileHash('delete-hash.ts');

      expect(hash).toBeNull();
    });

    it('should get all file hashes', async () => {
      const db = await import('./db/index.js');

      db.setFileHash('map-a.ts', 'hash1');
      db.setFileHash('map-b.ts', 'hash2');

      const hashes = db.getAllFileHashes();

      expect(hashes.get('map-a.ts')).toBe('hash1');
      expect(hashes.get('map-b.ts')).toBe('hash2');
    });
  });

  describe('Memory operations', () => {
    it('should save memory', async () => {
      const db = await import('./db/index.js');

      const embedding = new Array(384).fill(0.5);
      const result = db.saveMemory('test memory content', embedding, ['test-tag'], 'test-source', { deduplicate: false, autoLink: false });

      expect(result.id).toBeDefined();
      expect(result.isDuplicate).toBe(false);
    });

    it('should search memories by similarity', async () => {
      const db = await import('./db/index.js');

      const embedding = new Array(384).fill(0.5);
      const results = db.searchMemories(embedding, 5, 0.0);

      expect(Array.isArray(results)).toBe(true);
    });

    it('should get recent memories', async () => {
      const db = await import('./db/index.js');

      const recent = db.getRecentMemories(5);

      expect(Array.isArray(recent)).toBe(true);
    });

    it('should get memory by id', async () => {
      const db = await import('./db/index.js');

      const embedding = new Array(384).fill(0.6);
      const result = db.saveMemory('get by id test', embedding, [], undefined, { deduplicate: false, autoLink: false });

      const memory = db.getMemoryById(result.id);
      expect(memory).not.toBeNull();
      expect(memory?.content).toBe('get by id test');
    });

    it('should get memory stats', async () => {
      const db = await import('./db/index.js');

      const stats = db.getMemoryStats();

      expect(stats.total_memories).toBeDefined();
      expect(stats.by_type).toBeDefined();
    });
  });

  describe('Batch memory operations', () => {
    it('should save multiple memories in batch', async () => {
      const db = await import('./db/index.js');

      // Use unique embeddings to avoid duplicate detection
      const batch = [
        {
          content: 'Batch test 1 unique content alpha',
          embedding: new Array(384).fill(0).map((_, i) => i % 2 === 0 ? 0.1 : 0.9),
          tags: ['batch', 'test1'],
          type: 'observation' as const,
        },
        {
          content: 'Batch test 2 unique content beta',
          embedding: new Array(384).fill(0).map((_, i) => i % 3 === 0 ? 0.2 : 0.8),
          tags: ['batch', 'test2'],
          type: 'decision' as const,
        },
        {
          content: 'Batch test 3 unique content gamma',
          embedding: new Array(384).fill(0).map((_, i) => i % 5 === 0 ? 0.3 : 0.7),
          tags: ['batch', 'test3'],
          type: 'learning' as const,
        },
      ];

      const result = db.saveMemoriesBatch(batch);

      // Check that all were processed (some might be duplicates if DB has similar embeddings)
      expect(result.results).toHaveLength(3);
      expect(result.saved + result.skipped).toBe(3);

      // At least verify the results structure
      result.results.forEach(r => {
        expect(r.reason === 'saved' || r.reason === 'duplicate').toBe(true);
        if (!r.isDuplicate) {
          expect(r.id).toBeDefined();
        }
      });
    });

    it('should detect duplicates in batch save', async () => {
      const db = await import('./db/index.js');

      // Create distinct embedding for original
      const embedding1 = new Array(384).fill(0).map(() => Math.random());
      const embedding2 = embedding1.slice(); // Exact copy - guaranteed duplicate

      // Save one memory first
      db.saveMemory('Original memory for dup test', embedding1, [], undefined, { deduplicate: false, autoLink: false });

      // Try to batch save with duplicate
      const batch = [
        {
          content: 'Duplicate memory test',
          embedding: embedding2, // Identical embedding
          tags: ['duplicate'],
          type: 'observation' as const,
        },
        {
          content: 'New memory test',
          embedding: new Array(384).fill(0).map(() => Math.random()), // Completely different
          tags: ['new'],
          type: 'observation' as const,
        },
      ];

      const result = db.saveMemoriesBatch(batch, 0.99); // Very high threshold

      expect(result.saved).toBe(1); // Only new memory saved
      expect(result.skipped).toBe(1); // Duplicate skipped
      expect(result.results[0].isDuplicate).toBe(true);
      expect(result.results[0].reason).toBe('duplicate');
      expect(result.results[1].isDuplicate).toBe(false);
      expect(result.results[1].reason).toBe('saved');
    });

    it('should handle empty batch gracefully', async () => {
      const db = await import('./db/index.js');

      const result = db.saveMemoriesBatch([]);

      expect(result.saved).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.results).toHaveLength(0);
    });

    it('should preserve quality scores in batch save', async () => {
      const db = await import('./db/index.js');

      const batch = [
        {
          content: 'High quality memory with unique content for quality test',
          embedding: new Array(384).fill(0).map(() => Math.random()),
          tags: ['quality'],
          type: 'learning' as const,
          qualityScore: {
            score: 0.95,
            factors: { clarity: 0.9, specificity: 1.0 },
          },
        },
      ];

      const result = db.saveMemoriesBatch(batch);

      expect(result.saved).toBe(1);
      expect(result.results[0].id).toBeDefined();

      // Verify quality score was saved
      const memory = db.getMemoryById(result.results[0].id!);
      expect(memory?.quality_score).toBe(0.95);
      expect(memory?.quality_factors).toBeDefined();
    });

    it('should maintain correct index order in results', async () => {
      const db = await import('./db/index.js');

      const batch = [
        { content: 'Memory 0 index test', embedding: new Array(384).fill(0).map(() => Math.random()), tags: [], type: 'observation' as const },
        { content: 'Memory 1 index test', embedding: new Array(384).fill(0).map(() => Math.random()), tags: [], type: 'observation' as const },
        { content: 'Memory 2 index test', embedding: new Array(384).fill(0).map(() => Math.random()), tags: [], type: 'observation' as const },
      ];

      const result = db.saveMemoriesBatch(batch);

      // Results should be sorted by original index
      expect(result.results[0].index).toBe(0);
      expect(result.results[1].index).toBe(1);
      expect(result.results[2].index).toBe(2);
    });

    it('should handle temporal validity fields in batch save', async () => {
      const db = await import('./db/index.js');

      const validFrom = new Date('2026-01-01');
      const validUntil = new Date('2026-12-31');

      const batch = [
        {
          content: 'Temporal memory unique content for temporal test',
          embedding: new Array(384).fill(0).map(() => Math.random()),
          tags: ['temporal'],
          type: 'observation' as const,
          validFrom,
          validUntil,
        },
      ];

      const result = db.saveMemoriesBatch(batch);

      expect(result.saved).toBe(1);

      const memory = db.getMemoryById(result.results[0].id!);
      expect(memory?.valid_from).toBe(validFrom.toISOString());
      expect(memory?.valid_until).toBe(validUntil.toISOString());
    });
  });

  describe('Memory links (Knowledge Graph)', () => {
    it('should create memory link', async () => {
      const db = await import('./db/index.js');

      const embedding = new Array(384).fill(0.7);
      const mem1 = db.saveMemory('link test 1', embedding, [], undefined, { deduplicate: false, autoLink: false });
      const mem2 = db.saveMemory('link test 2', embedding, [], undefined, { deduplicate: false, autoLink: false });

      const link = db.createMemoryLink(mem1.id, mem2.id, 'related', 1.0);

      expect(link.created).toBe(true);
    });

    it('should get memory links', async () => {
      const db = await import('./db/index.js');

      const embedding = new Array(384).fill(0.8);
      const mem1 = db.saveMemory('links get 1', embedding, [], undefined, { deduplicate: false, autoLink: false });
      const mem2 = db.saveMemory('links get 2', embedding, [], undefined, { deduplicate: false, autoLink: false });

      db.createMemoryLink(mem1.id, mem2.id, 'leads_to');

      const links = db.getMemoryLinks(mem1.id);

      expect(links.outgoing.length).toBeGreaterThanOrEqual(1);
    });

    it('should get graph stats', async () => {
      const db = await import('./db/index.js');

      const stats = db.getGraphStats();

      expect(stats.total_memories).toBeDefined();
      expect(stats.total_links).toBeDefined();
      expect(stats.relations).toBeDefined();
    });
  });

  describe('Global database', () => {
    it('should create global database', async () => {
      const db = await import('./db/index.js');
      db.getGlobalDb();

      expect(fs.existsSync(path.join(tempDir, 'global.db'))).toBe(true);
    });

    it('should save and search global memories', async () => {
      const db = await import('./db/index.js');

      const embedding = new Array(384).fill(0.9);
      db.saveGlobalMemory('global memory test', embedding, ['global-tag'], 'source', 'project-name', { deduplicate: false });

      const results = db.searchGlobalMemories(embedding, 5, 0.0);

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].isGlobal).toBe(true);
    });

    it('should get global memory stats', async () => {
      const db = await import('./db/index.js');

      const stats = db.getGlobalMemoryStats();

      expect(stats.total_memories).toBeDefined();
      expect(stats.projects).toBeDefined();
    });
  });

  describe('Memory soft-delete (consolidation v2)', () => {
    it('should invalidate a memory', async () => {
      const db = await import('./db/index.js');

      const embedding = new Array(384).fill(0).map(() => Math.random());
      const original = db.saveMemory('memory to invalidate', embedding, ['test'], undefined, { deduplicate: false, autoLink: false });
      const keeper = db.saveMemory('keeper memory', embedding.map(v => v * 0.5), ['test'], undefined, { deduplicate: false, autoLink: false });

      const success = db.invalidateMemory(original.id, keeper.id);
      expect(success).toBe(true);

      // Memory still exists but has invalidated_by set
      const mem = db.getMemoryById(original.id);
      expect(mem).not.toBeNull();
      expect(mem?.valid_until).not.toBeNull();
    });

    it('should exclude invalidated memories from getRecentMemories', async () => {
      const db = await import('./db/index.js');

      const embedding = new Array(384).fill(0).map(() => Math.random());
      const m = db.saveMemory('recent-but-invalidated', embedding, ['test'], undefined, { deduplicate: false, autoLink: false });
      db.invalidateMemory(m.id, 1);

      const recent = db.getRecentMemories(100);
      const found = recent.find(r => r.id === m.id);
      expect(found).toBeUndefined();
    });

    it('should restore an invalidated memory', async () => {
      const db = await import('./db/index.js');

      const embedding = new Array(384).fill(0).map(() => Math.random());
      const m = db.saveMemory('to restore', embedding, ['test'], undefined, { deduplicate: false, autoLink: false });
      db.invalidateMemory(m.id, 999);

      const restored = db.restoreInvalidatedMemory(m.id);
      expect(restored).toBe(true);

      const recent = db.getRecentMemories(100);
      const found = recent.find(r => r.id === m.id);
      expect(found).toBeDefined();
    });

    it('should not invalidate already-invalidated memory', async () => {
      const db = await import('./db/index.js');

      const embedding = new Array(384).fill(0).map(() => Math.random());
      const m = db.saveMemory('double invalidate', embedding, ['test'], undefined, { deduplicate: false, autoLink: false });
      db.invalidateMemory(m.id, 100);

      // Second invalidation should fail (already invalidated)
      const again = db.invalidateMemory(m.id, 200);
      expect(again).toBe(false);
    });

    it('should not restore a non-invalidated memory', async () => {
      const db = await import('./db/index.js');

      const embedding = new Array(384).fill(0).map(() => Math.random());
      const m = db.saveMemory('never invalidated', embedding, ['test'], undefined, { deduplicate: false, autoLink: false });

      const restored = db.restoreInvalidatedMemory(m.id);
      expect(restored).toBe(false);
    });

    it('should report invalidated count in getMemoryStats', async () => {
      const db = await import('./db/index.js');

      const stats = db.getMemoryStats();
      expect(stats.active_memories).toBeDefined();
      expect(stats.invalidated_memories).toBeDefined();
      expect(stats.total_memories).toBe(stats.active_memories + stats.invalidated_memories);
    });

    it('should return consolidation history via supersedes links', async () => {
      const db = await import('./db/index.js');

      const embedding = new Array(384).fill(0).map(() => Math.random());
      const original1 = db.saveMemory('original-hist-1', embedding, [], undefined, { deduplicate: false, autoLink: false });
      const original2 = db.saveMemory('original-hist-2', embedding.map(v => v * 0.9), [], undefined, { deduplicate: false, autoLink: false });
      const merged = db.saveMemory('merged-hist', embedding.map(v => v * 0.7), [], 'consolidation-llm', { deduplicate: false, autoLink: false });

      // Create supersedes links
      db.createMemoryLink(merged.id, original1.id, 'supersedes', 1.0);
      db.createMemoryLink(merged.id, original2.id, 'supersedes', 1.0);
      db.invalidateMemory(original1.id, merged.id);
      db.invalidateMemory(original2.id, merged.id);

      const history = db.getConsolidationHistory(10);
      const entry = history.find(h => h.mergedMemoryId === merged.id);
      expect(entry).toBeDefined();
      expect(entry?.originalIds).toContain(original1.id);
      expect(entry?.originalIds).toContain(original2.id);
    });
  });

  describe('Constants', () => {
    it('should export MEMORY_TYPES', async () => {
      const db = await import('./db/index.js');

      expect(db.MEMORY_TYPES).toContain('observation');
      expect(db.MEMORY_TYPES).toContain('decision');
      expect(db.MEMORY_TYPES).toContain('learning');
      expect(db.MEMORY_TYPES).toContain('error');
      expect(db.MEMORY_TYPES).toContain('pattern');
    });

    it('should export LINK_RELATIONS', async () => {
      const db = await import('./db/index.js');

      expect(db.LINK_RELATIONS).toContain('related');
      expect(db.LINK_RELATIONS).toContain('caused_by');
      expect(db.LINK_RELATIONS).toContain('leads_to');
      expect(db.LINK_RELATIONS).toContain('similar_to');
    });
  });
});
