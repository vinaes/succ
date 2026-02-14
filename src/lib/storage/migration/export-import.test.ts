/**
 * Tests for data export/import migration utilities.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  exportData,
  exportToFile,
  importData,
  getExportStats,
  type ExportData,
} from './export-import.js';

// Mock the db module
vi.mock('../../db.js', () => {
  const mockDb = {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  };

  return {
    getDb: vi.fn().mockReturnValue(mockDb),
    getGlobalDb: vi.fn().mockReturnValue(mockDb),
    getAllFileHashes: vi.fn().mockReturnValue(new Map()),
  };
});

describe('Export/Import Migration', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'succ-export-test-'));
    tempFile = path.join(tempDir, 'export.json');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  describe('exportData', () => {
    it('should return data with correct version', () => {
      const data = exportData();
      expect(data.version).toBe('1.0');
      expect(data.exportedAt).toBeDefined();
      expect(data.metadata.backend).toBe('sqlite');
    });

    it('should include all data arrays', () => {
      const data = exportData();
      expect(Array.isArray(data.documents)).toBe(true);
      expect(Array.isArray(data.fileHashes)).toBe(true);
      expect(Array.isArray(data.memories)).toBe(true);
      expect(Array.isArray(data.memoryLinks)).toBe(true);
      expect(Array.isArray(data.globalMemories)).toBe(true);
      expect(Array.isArray(data.tokenFrequencies)).toBe(true);
      expect(Array.isArray(data.tokenStats)).toBe(true);
    });
  });

  describe('exportToFile / importFromFile', () => {
    it('should write export to file', () => {
      exportToFile(tempFile);
      expect(fs.existsSync(tempFile)).toBe(true);

      const content = fs.readFileSync(tempFile, 'utf-8');
      const data = JSON.parse(content);
      expect(data.version).toBe('1.0');
    });

    it('should read export stats from file', () => {
      exportToFile(tempFile);
      const stats = getExportStats(tempFile);

      expect(stats.version).toBe('1.0');
      expect(stats.backend).toBe('sqlite');
      expect(stats.counts).toBeDefined();
      expect(typeof stats.counts.documents).toBe('number');
      expect(typeof stats.counts.memories).toBe('number');
    });
  });

  describe('importData', () => {
    it('should reject incompatible version', () => {
      const badData: ExportData = {
        version: '2.0',
        exportedAt: new Date().toISOString(),
        metadata: { backend: 'sqlite' },
        documents: [],
        fileHashes: [],
        memories: [],
        memoryLinks: [],
        globalMemories: [],
        tokenFrequencies: [],
        tokenStats: [],
      };

      expect(() => importData(badData)).toThrow('Unsupported export version');
    });

    it('should accept valid data structure', () => {
      const validData: ExportData = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        metadata: { backend: 'sqlite' },
        documents: [],
        fileHashes: [],
        memories: [],
        memoryLinks: [],
        globalMemories: [],
        tokenFrequencies: [],
        tokenStats: [],
      };

      const result = importData(validData);
      expect(result.documents).toBe(0);
      expect(result.memories).toBe(0);
      expect(result.memoryLinks).toBe(0);
      expect(result.globalMemories).toBe(0);
    });
  });

  describe('getExportStats', () => {
    it('should return counts for all entity types', () => {
      // Create a test export file
      const testData: ExportData = {
        version: '1.0',
        exportedAt: '2024-01-01T00:00:00.000Z',
        metadata: { backend: 'sqlite', embeddingModel: 'test-model' },
        documents: [
          {
            id: 1,
            file_path: '/test.ts',
            chunk_index: 0,
            content: 'test',
            start_line: 1,
            end_line: 10,
            embedding: [0.1, 0.2],
            created_at: '2024-01-01',
            updated_at: '2024-01-01',
          },
        ],
        fileHashes: [{ file_path: '/test.ts', content_hash: 'abc123', indexed_at: '2024-01-01' }],
        memories: [
          {
            id: 1,
            content: 'test memory',
            tags: ['test'],
            source: null,
            type: 'observation',
            quality_score: 0.8,
            quality_factors: null,
            embedding: [0.1, 0.2],
            access_count: 1,
            last_accessed: null,
            valid_from: null,
            valid_until: null,
            created_at: '2024-01-01',
          },
          {
            id: 2,
            content: 'another memory',
            tags: null,
            source: null,
            type: null,
            quality_score: null,
            quality_factors: null,
            embedding: [0.3, 0.4],
            access_count: 0,
            last_accessed: null,
            valid_from: null,
            valid_until: null,
            created_at: '2024-01-01',
          },
        ],
        memoryLinks: [],
        globalMemories: [],
        tokenFrequencies: [{ token: 'test', frequency: 5 }],
        tokenStats: [],
      };

      fs.writeFileSync(tempFile, JSON.stringify(testData, null, 2));

      const stats = getExportStats(tempFile);
      expect(stats.version).toBe('1.0');
      expect(stats.exportedAt).toBe('2024-01-01T00:00:00.000Z');
      expect(stats.backend).toBe('sqlite');
      expect(stats.embeddingModel).toBe('test-model');
      expect(stats.counts.documents).toBe(1);
      expect(stats.counts.memories).toBe(2);
      expect(stats.counts.memoryLinks).toBe(0);
      expect(stats.counts.globalMemories).toBe(0);
      expect(stats.counts.tokenFrequencies).toBe(1);
      expect(stats.counts.tokenStats).toBe(0);
    });
  });
});
