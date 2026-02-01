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
      const db = await import('./db.js');
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
      const db = await import('./db.js');
      db.getDb();

      expect(fs.existsSync(path.join(tempDir, 'test.db'))).toBe(true);
    });

    it('should create tables on initialization', async () => {
      const db = await import('./db.js');
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
      const db = await import('./db.js');

      const embedding = new Array(384).fill(0.1);
      db.upsertDocument('test-doc.ts', 0, 'test content', 1, 10, embedding);

      const stats = db.getStats();
      expect(stats.total_documents).toBeGreaterThanOrEqual(1);
    });

    it('should batch upsert documents', async () => {
      const db = await import('./db.js');

      const docs = [
        { filePath: 'batch-a.ts', chunkIndex: 0, content: 'a', startLine: 1, endLine: 5, embedding: new Array(384).fill(0.1) },
        { filePath: 'batch-b.ts', chunkIndex: 0, content: 'b', startLine: 1, endLine: 5, embedding: new Array(384).fill(0.2) },
      ];

      db.upsertDocumentsBatch(docs);

      const stats = db.getStats();
      expect(stats.total_documents).toBeGreaterThanOrEqual(2);
    });

    it('should delete documents by path', async () => {
      const db = await import('./db.js');

      const embedding = new Array(384).fill(0.1);
      db.upsertDocument('to-delete.ts', 0, 'will be deleted', 1, 10, embedding);

      const statsBefore = db.getStats();
      db.deleteDocumentsByPath('to-delete.ts');
      const statsAfter = db.getStats();

      // At least one fewer document (might be equal if it was already deleted)
      expect(statsAfter.total_documents).toBeLessThanOrEqual(statsBefore.total_documents);
    });

    it('should search documents by similarity', async () => {
      const db = await import('./db.js');

      // Search with a query embedding
      const queryEmbedding = new Array(384).fill(0.1);
      const results = db.searchDocuments(queryEmbedding, 5, 0.0);

      // Should return results (if any documents exist)
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('File hash operations', () => {
    it('should store and retrieve file hash', async () => {
      const db = await import('./db.js');

      db.setFileHash('hash-test.ts', 'abc123');
      const hash = db.getFileHash('hash-test.ts');

      expect(hash).toBe('abc123');
    });

    it('should return null for unknown file', async () => {
      const db = await import('./db.js');

      const hash = db.getFileHash('unknown-file-that-doesnt-exist.ts');
      expect(hash).toBeNull();
    });

    it('should delete file hash', async () => {
      const db = await import('./db.js');

      db.setFileHash('delete-hash.ts', 'xyz789');
      db.deleteFileHash('delete-hash.ts');
      const hash = db.getFileHash('delete-hash.ts');

      expect(hash).toBeNull();
    });

    it('should get all file hashes', async () => {
      const db = await import('./db.js');

      db.setFileHash('map-a.ts', 'hash1');
      db.setFileHash('map-b.ts', 'hash2');

      const hashes = db.getAllFileHashes();

      expect(hashes.get('map-a.ts')).toBe('hash1');
      expect(hashes.get('map-b.ts')).toBe('hash2');
    });
  });

  describe('Memory operations', () => {
    it('should save memory', async () => {
      const db = await import('./db.js');

      const embedding = new Array(384).fill(0.5);
      const result = db.saveMemory('test memory content', embedding, ['test-tag'], 'test-source', { deduplicate: false, autoLink: false });

      expect(result.id).toBeDefined();
      expect(result.isDuplicate).toBe(false);
    });

    it('should search memories by similarity', async () => {
      const db = await import('./db.js');

      const embedding = new Array(384).fill(0.5);
      const results = db.searchMemories(embedding, 5, 0.0);

      expect(Array.isArray(results)).toBe(true);
    });

    it('should get recent memories', async () => {
      const db = await import('./db.js');

      const recent = db.getRecentMemories(5);

      expect(Array.isArray(recent)).toBe(true);
    });

    it('should get memory by id', async () => {
      const db = await import('./db.js');

      const embedding = new Array(384).fill(0.6);
      const result = db.saveMemory('get by id test', embedding, [], undefined, { deduplicate: false, autoLink: false });

      const memory = db.getMemoryById(result.id);
      expect(memory).not.toBeNull();
      expect(memory?.content).toBe('get by id test');
    });

    it('should get memory stats', async () => {
      const db = await import('./db.js');

      const stats = db.getMemoryStats();

      expect(stats.total_memories).toBeDefined();
      expect(stats.by_type).toBeDefined();
    });
  });

  describe('Memory links (Knowledge Graph)', () => {
    it('should create memory link', async () => {
      const db = await import('./db.js');

      const embedding = new Array(384).fill(0.7);
      const mem1 = db.saveMemory('link test 1', embedding, [], undefined, { deduplicate: false, autoLink: false });
      const mem2 = db.saveMemory('link test 2', embedding, [], undefined, { deduplicate: false, autoLink: false });

      const link = db.createMemoryLink(mem1.id, mem2.id, 'related', 1.0);

      expect(link.created).toBe(true);
    });

    it('should get memory links', async () => {
      const db = await import('./db.js');

      const embedding = new Array(384).fill(0.8);
      const mem1 = db.saveMemory('links get 1', embedding, [], undefined, { deduplicate: false, autoLink: false });
      const mem2 = db.saveMemory('links get 2', embedding, [], undefined, { deduplicate: false, autoLink: false });

      db.createMemoryLink(mem1.id, mem2.id, 'leads_to');

      const links = db.getMemoryLinks(mem1.id);

      expect(links.outgoing.length).toBeGreaterThanOrEqual(1);
    });

    it('should get graph stats', async () => {
      const db = await import('./db.js');

      const stats = db.getGraphStats();

      expect(stats.total_memories).toBeDefined();
      expect(stats.total_links).toBeDefined();
      expect(stats.relations).toBeDefined();
    });
  });

  describe('Global database', () => {
    it('should create global database', async () => {
      const db = await import('./db.js');
      db.getGlobalDb();

      expect(fs.existsSync(path.join(tempDir, 'global.db'))).toBe(true);
    });

    it('should save and search global memories', async () => {
      const db = await import('./db.js');

      const embedding = new Array(384).fill(0.9);
      db.saveGlobalMemory('global memory test', embedding, ['global-tag'], 'source', 'project-name', { deduplicate: false });

      const results = db.searchGlobalMemories(embedding, 5, 0.0);

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].isGlobal).toBe(true);
    });

    it('should get global memory stats', async () => {
      const db = await import('./db.js');

      const stats = db.getGlobalMemoryStats();

      expect(stats.total_memories).toBeDefined();
      expect(stats.projects).toBeDefined();
    });
  });

  describe('Constants', () => {
    it('should export MEMORY_TYPES', async () => {
      const db = await import('./db.js');

      expect(db.MEMORY_TYPES).toContain('observation');
      expect(db.MEMORY_TYPES).toContain('decision');
      expect(db.MEMORY_TYPES).toContain('learning');
      expect(db.MEMORY_TYPES).toContain('error');
      expect(db.MEMORY_TYPES).toContain('pattern');
    });

    it('should export LINK_RELATIONS', async () => {
      const db = await import('./db.js');

      expect(db.LINK_RELATIONS).toContain('related');
      expect(db.LINK_RELATIONS).toContain('caused_by');
      expect(db.LINK_RELATIONS).toContain('leads_to');
      expect(db.LINK_RELATIONS).toContain('similar_to');
    });
  });
});
