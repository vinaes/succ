import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import {
  readBrainVault,
  exportBrainAsJson,
  exportBrainAsMarkdown,
  exportBrainSnapshot,
} from './brain-export.js';

// Mock fs and config
vi.mock('fs');
vi.mock('./config.js', () => ({
  getSuccDir: vi.fn(() => '/mock/.succ'),
}));

const mockFs = vi.mocked(fs);

describe('brain-export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('readBrainVault', () => {
    it('should return empty array when brain dir does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      const result = readBrainVault('/nonexistent');
      expect(result).toEqual([]);
    });

    it('should read markdown files from brain vault', () => {
      const brainDir = '/mock/brain';
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([
        { name: 'overview.md', isDirectory: () => false, isFile: () => true } as any,
        { name: 'readme.txt', isDirectory: () => false, isFile: () => true } as any,
      ]);
      mockFs.readFileSync.mockReturnValue('# Overview\n\nThis is the overview.');
      mockFs.statSync.mockReturnValue({
        mtime: new Date('2026-01-01'),
        size: 32,
      } as any);

      const result = readBrainVault(brainDir);

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Overview');
      expect(result[0].relativePath).toBe('overview.md');
      expect(result[0].sizeBytes).toBe(32);
    });

    it('should parse frontmatter', () => {
      const brainDir = '/mock/brain';
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([
        { name: 'doc.md', isDirectory: () => false, isFile: () => true } as any,
      ]);
      mockFs.readFileSync.mockReturnValue(
        '---\ntitle: My Document\ntags: [arch, design]\nstatus: active\n---\n\n# Content here'
      );
      mockFs.statSync.mockReturnValue({
        mtime: new Date('2026-01-01'),
        size: 100,
      } as any);

      const result = readBrainVault(brainDir);

      expect(result[0].title).toBe('My Document');
      expect(result[0].frontmatter.title).toBe('My Document');
      expect(result[0].frontmatter.tags).toEqual(['arch', 'design']);
      expect(result[0].frontmatter.status).toBe('active');
    });

    it('should recurse into subdirectories', () => {
      const brainDir = '/mock/brain';
      mockFs.existsSync.mockReturnValue(true);

      // First call: root dir
      mockFs.readdirSync.mockReturnValueOnce([
        { name: 'subdir', isDirectory: () => true, isFile: () => false } as any,
      ]);
      // Second call: subdir
      mockFs.readdirSync.mockReturnValueOnce([
        { name: 'nested.md', isDirectory: () => false, isFile: () => true } as any,
      ]);

      mockFs.readFileSync.mockReturnValue('# Nested Doc');
      mockFs.statSync.mockReturnValue({
        mtime: new Date('2026-01-01'),
        size: 12,
      } as any);

      const result = readBrainVault(brainDir);

      expect(result).toHaveLength(1);
      expect(result[0].relativePath).toBe('subdir/nested.md');
    });
  });

  describe('exportBrainAsJson', () => {
    it('should return JSON content when no outputPath', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([
        { name: 'test.md', isDirectory: () => false, isFile: () => true } as any,
      ]);
      mockFs.readFileSync.mockReturnValue('# Test');
      mockFs.statSync.mockReturnValue({
        mtime: new Date('2026-01-01'),
        size: 6,
      } as any);

      const result = exportBrainAsJson(undefined, '/mock/brain');

      expect(result.format).toBe('json');
      expect(result.documentCount).toBe(1);
      expect(result.content).toBeDefined();
      expect(JSON.parse(result.content!)).toHaveProperty('documents');
    });

    it('should write to file when outputPath provided', () => {
      mockFs.existsSync.mockImplementation((p) => {
        return (p as string).includes('brain');
      });
      mockFs.readdirSync.mockReturnValue([]);

      const result = exportBrainAsJson('/out/export.json', '/mock/brain');

      expect(result.format).toBe('json');
      expect(result.outputPath).toBe('/out/export.json');
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('exportBrainAsMarkdown', () => {
    it('should generate markdown pack with TOC', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([
        { name: 'api.md', isDirectory: () => false, isFile: () => true } as any,
        { name: 'arch.md', isDirectory: () => false, isFile: () => true } as any,
      ]);
      mockFs.readFileSync.mockReturnValue('# Test Content\n\nSome text.');
      mockFs.statSync.mockReturnValue({
        mtime: new Date('2026-01-01'),
        size: 30,
      } as any);

      const result = exportBrainAsMarkdown(undefined, '/mock/brain');

      expect(result.format).toBe('markdown');
      expect(result.documentCount).toBe(2);
      expect(result.content).toContain('# Brain Vault Export');
      expect(result.content).toContain('## Table of Contents');
      expect(result.content).toContain('Test Content');
    });
  });

  describe('exportBrainSnapshot', () => {
    it('should include search index metadata', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([
        { name: 'test.md', isDirectory: () => false, isFile: () => true } as any,
      ]);
      mockFs.readFileSync.mockReturnValue(
        '# Architecture\n\n## Components\n\nThe system uses microservices architecture.'
      );
      mockFs.statSync.mockReturnValue({
        mtime: new Date('2026-01-01'),
        size: 70,
      } as any);

      const result = exportBrainSnapshot(undefined, '/mock/brain');

      expect(result.format).toBe('snapshot');
      const snapshot = JSON.parse(result.content!);
      expect(snapshot.searchIndex).toBeDefined();
      expect(snapshot.searchIndex[0].headings).toContain('Architecture');
      expect(snapshot.searchIndex[0].headings).toContain('Components');
      expect(snapshot.searchIndex[0].keyTerms).toBeInstanceOf(Array);
    });
  });
});
