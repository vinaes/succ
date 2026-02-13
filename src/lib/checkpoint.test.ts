import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import {
  readCheckpoint,
  formatSize,
  type CheckpointData,
  type CheckpointMemory,
} from './checkpoint.js';

// Mock dependencies
vi.mock('./db.js', () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
      run: vi.fn(() => ({ lastInsertRowid: 1 })),
    })),
    exec: vi.fn(),
    transaction: vi.fn((fn) => fn),
  })),
}));

vi.mock('./config.js', () => ({
  getSuccDir: vi.fn(() => '/mock/.succ'),
}));

describe('Checkpoint Library', () => {
  describe('formatSize', () => {
    it('should format bytes', () => {
      expect(formatSize(0)).toBe('0 B');
      expect(formatSize(500)).toBe('500 B');
      expect(formatSize(1023)).toBe('1023 B');
    });

    it('should format kilobytes', () => {
      expect(formatSize(1024)).toBe('1.0 KB');
      expect(formatSize(1536)).toBe('1.5 KB');
      expect(formatSize(10240)).toBe('10.0 KB');
    });

    it('should format megabytes', () => {
      expect(formatSize(1024 * 1024)).toBe('1.0 MB');
      expect(formatSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
      expect(formatSize(100 * 1024 * 1024)).toBe('100.0 MB');
    });
  });

  describe('readCheckpoint', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-test-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should throw error if file does not exist', () => {
      expect(() => readCheckpoint('/nonexistent/path.json')).toThrow('Checkpoint file not found');
    });

    it('should read JSON checkpoint file', () => {
      const checkpoint: CheckpointData = {
        version: '1.0',
        created_at: '2026-02-02T00:00:00.000Z',
        project_name: 'test-project',
        succ_version: '1.0.0',
        data: {
          memories: [],
          documents: [],
          memory_links: [],
          config: {},
          brain_vault: [],
        },
        stats: {
          memories_count: 0,
          documents_count: 0,
          links_count: 0,
          brain_files_count: 0,
        },
      };

      const filePath = path.join(tempDir, 'test-checkpoint.json');
      fs.writeFileSync(filePath, JSON.stringify(checkpoint));

      const result = readCheckpoint(filePath);

      expect(result.version).toBe('1.0');
      expect(result.project_name).toBe('test-project');
    });

    it('should read gzipped checkpoint file', () => {
      const checkpoint: CheckpointData = {
        version: '1.0',
        created_at: '2026-02-02T00:00:00.000Z',
        project_name: 'compressed-project',
        succ_version: '1.0.0',
        data: {
          memories: [],
          documents: [],
          memory_links: [],
          config: {},
          brain_vault: [],
        },
        stats: {
          memories_count: 0,
          documents_count: 0,
          links_count: 0,
          brain_files_count: 0,
        },
      };

      const filePath = path.join(tempDir, 'test-checkpoint.json.gz');
      const compressed = zlib.gzipSync(JSON.stringify(checkpoint));
      fs.writeFileSync(filePath, compressed);

      const result = readCheckpoint(filePath);

      expect(result.version).toBe('1.0');
      expect(result.project_name).toBe('compressed-project');
    });

    it('should throw error for invalid checkpoint format', () => {
      const filePath = path.join(tempDir, 'invalid.json');
      fs.writeFileSync(filePath, JSON.stringify({ invalid: 'format' }));

      expect(() => readCheckpoint(filePath)).toThrow('Invalid checkpoint format');
    });
  });

  describe('CheckpointMemory serialization', () => {
    it('should handle memory with embedding as number array', () => {
      const memory: CheckpointMemory = {
        id: 1,
        content: 'Test content',
        tags: ['tag1', 'tag2'],
        source: 'test-source',
        embedding: [0.1, 0.2, 0.3, 0.4],
        type: 'observation',
        quality_score: 0.8,
        quality_factors: { specificity: 0.7, clarity: 0.8 },
        access_count: 5,
        last_accessed: '2026-02-01T00:00:00.000Z',
        created_at: '2026-01-01T00:00:00.000Z',
      };

      const json = JSON.stringify(memory);
      const parsed = JSON.parse(json) as CheckpointMemory;

      expect(parsed.id).toBe(1);
      expect(parsed.embedding).toEqual([0.1, 0.2, 0.3, 0.4]);
      expect(parsed.tags).toEqual(['tag1', 'tag2']);
    });

    it('should handle memory without embedding', () => {
      const memory: CheckpointMemory = {
        id: 1,
        content: 'Test content',
        tags: [],
        source: null,
        embedding: null,
        type: null,
        quality_score: null,
        quality_factors: null,
        access_count: 0,
        last_accessed: null,
        created_at: '2026-01-01T00:00:00.000Z',
      };

      const json = JSON.stringify(memory);
      const parsed = JSON.parse(json) as CheckpointMemory;

      expect(parsed.embedding).toBeNull();
      expect(parsed.quality_score).toBeNull();
    });
  });

  describe('CheckpointData structure', () => {
    it('should have correct shape', () => {
      const checkpoint: CheckpointData = {
        version: '1.0',
        created_at: new Date().toISOString(),
        project_name: 'test',
        succ_version: '1.0.55',
        data: {
          memories: [
            {
              id: 1,
              content: 'Memory 1',
              tags: ['test'],
              source: null,
              embedding: [0.1, 0.2],
              type: 'observation',
              quality_score: 0.8,
              quality_factors: {},
              access_count: 2,
              last_accessed: new Date().toISOString(),
              created_at: new Date().toISOString(),
            },
          ],
          documents: [
            {
              id: 1,
              file_path: 'test.md',
              chunk_index: 0,
              content: 'Document content',
              start_line: 1,
              end_line: 10,
              embedding: [0.3, 0.4],
              created_at: new Date().toISOString(),
            },
          ],
          memory_links: [
            {
              id: 1,
              source_id: 1,
              target_id: 2,
              relation: 'relates_to',
              weight: 0.9,
              created_at: new Date().toISOString(),
            },
          ],
          config: { key: 'value' },
          brain_vault: [
            { path: 'CLAUDE.md', content: '# Claude\n\nBrain file content' },
          ],
        },
        stats: {
          memories_count: 1,
          documents_count: 1,
          links_count: 1,
          brain_files_count: 1,
        },
      };

      expect(checkpoint.version).toBe('1.0');
      expect(checkpoint.data.memories).toHaveLength(1);
      expect(checkpoint.data.documents).toHaveLength(1);
      expect(checkpoint.data.memory_links).toHaveLength(1);
      expect(checkpoint.data.brain_vault).toHaveLength(1);
      expect(checkpoint.stats.memories_count).toBe(1);
    });
  });

  describe('Embedding serialization', () => {
    it('should convert Float32Array to number array and back', () => {
      const original = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);

      // Serialize to number array (what checkpoint does)
      const numberArray = Array.from(original);

      // Deserialize back to Float32Array (what restore does)
      const restored = new Float32Array(numberArray);

      expect(Array.from(restored)).toEqual(Array.from(original));
    });

    it('should handle empty embeddings', () => {
      const original = new Float32Array([]);
      const numberArray = Array.from(original);
      const restored = new Float32Array(numberArray);

      expect(Array.from(restored)).toEqual([]);
    });

    it('should preserve precision for typical embedding values', () => {
      const values = [-1, -0.5, 0, 0.5, 1, 0.123456789];
      const original = new Float32Array(values);
      const numberArray = Array.from(original);
      const restored = new Float32Array(numberArray);

      // Float32 has limited precision, but should be close
      for (let i = 0; i < values.length; i++) {
        expect(restored[i]).toBeCloseTo(original[i], 5);
      }
    });
  });

  describe('ID remapping logic', () => {
    it('should correctly remap memory IDs', () => {
      // Simulate the ID remapping that happens during restore
      const oldToNewMap = new Map<number, number>();

      // Old IDs: 5, 10, 15
      // New IDs (from INSERT): 1, 2, 3
      oldToNewMap.set(5, 1);
      oldToNewMap.set(10, 2);
      oldToNewMap.set(15, 3);

      // Test link remapping
      const oldLink = { source_id: 5, target_id: 10, relation: 'relates_to', weight: 0.9 };
      const newSourceId = oldToNewMap.get(oldLink.source_id);
      const newTargetId = oldToNewMap.get(oldLink.target_id);

      expect(newSourceId).toBe(1);
      expect(newTargetId).toBe(2);
    });

    it('should skip links with missing mappings', () => {
      const oldToNewMap = new Map<number, number>();
      oldToNewMap.set(5, 1);

      // Link references a memory that wasn't restored
      const orphanedLink = { source_id: 5, target_id: 999, relation: 'relates_to', weight: 0.9 };

      const newSourceId = oldToNewMap.get(orphanedLink.source_id);
      const newTargetId = oldToNewMap.get(orphanedLink.target_id);

      expect(newSourceId).toBe(1);
      expect(newTargetId).toBeUndefined();

      // Should skip this link
      const shouldSkip = !(newSourceId && newTargetId);
      expect(shouldSkip).toBe(true);
    });
  });
});
