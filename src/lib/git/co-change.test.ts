import { describe, it, expect, vi } from 'vitest';

// Mock execSync before importing module
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getProjectRoot: vi.fn(() => '/test/project'),
}));

vi.mock('../fault-logger.js', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { execSync } from 'child_process';
import { analyzeCoChanges, getCoChangesForFile } from './co-change.js';

const mockExecSync = vi.mocked(execSync);

describe('co-change', () => {
  describe('analyzeCoChanges', () => {
    it('should parse commit log and find co-change pairs', () => {
      // Simulate git log with 3 commits
      const gitLog = [
        '---COMMIT---',
        'src/lib/auth.ts',
        'src/lib/config.ts',
        '',
        '---COMMIT---',
        'src/lib/auth.ts',
        'src/lib/config.ts',
        'src/lib/storage.ts',
        '',
        '---COMMIT---',
        'src/lib/other.ts',
        '',
      ].join('\n');

      mockExecSync.mockReturnValue(gitLog);

      const result = analyzeCoChanges(200, 2);

      expect(result.totalCommits).toBe(3);
      // auth + config appear together twice → should be in pairs
      expect(result.pairs.length).toBeGreaterThanOrEqual(1);

      const authConfig = result.pairs.find(
        (p) =>
          (p.fileA === 'src/lib/auth.ts' && p.fileB === 'src/lib/config.ts') ||
          (p.fileA === 'src/lib/config.ts' && p.fileB === 'src/lib/auth.ts')
      );
      expect(authConfig).toBeDefined();
      expect(authConfig!.count).toBe(2);
      expect(authConfig!.score).toBeGreaterThan(0);
    });

    it('should skip large commits (>50 files)', () => {
      const files = Array.from({ length: 60 }, (_, i) => `file${i}.ts`).join('\n');
      const gitLog = `---COMMIT---\n${files}\n---COMMIT---\nsrc/a.ts\nsrc/b.ts\n`;

      mockExecSync.mockReturnValue(gitLog);

      const result = analyzeCoChanges(200, 1);
      // Should skip the 60-file commit
      expect(result.totalCommits).toBe(1);
    });

    it('should return empty on git failure', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not a git repository');
      });

      const result = analyzeCoChanges();
      expect(result.pairs).toEqual([]);
      expect(result.totalCommits).toBe(0);
    });

    it('should apply minCooccurrence filter', () => {
      const gitLog = [
        '---COMMIT---',
        'src/a.ts',
        'src/b.ts',
        '',
        '---COMMIT---',
        'src/c.ts',
        'src/d.ts',
        '',
      ].join('\n');

      mockExecSync.mockReturnValue(gitLog);

      const result = analyzeCoChanges(200, 2);
      // a+b and c+d only appear once each, so no pairs at minCooccurrence=2
      expect(result.pairs).toHaveLength(0);
    });

    it('should weight recent commits higher', () => {
      // First commit (most recent) and last commit both have same pair
      const gitLog = [
        '---COMMIT---',
        'src/a.ts',
        'src/b.ts',
        '',
        '---COMMIT---',
        'src/other.ts',
        '',
        '---COMMIT---',
        'src/a.ts',
        'src/b.ts',
        '',
      ].join('\n');

      mockExecSync.mockReturnValue(gitLog);

      const result = analyzeCoChanges(200, 2);
      expect(result.pairs).toHaveLength(1);
      expect(result.pairs[0].recencyWeight).toBeGreaterThan(0);
    });
  });

  describe('getCoChangesForFile', () => {
    it('should return co-changing files for a specific file', () => {
      const gitLog = [
        '---COMMIT---',
        'src/lib/auth.ts',
        'src/lib/config.ts',
        '',
        '---COMMIT---',
        'src/lib/auth.ts',
        'src/lib/config.ts',
        'src/lib/storage.ts',
        '',
        '---COMMIT---',
        'src/lib/auth.ts',
        'src/lib/storage.ts',
        '',
      ].join('\n');

      mockExecSync.mockReturnValue(gitLog);

      const result = getCoChangesForFile('src/lib/auth.ts', 200, 2, 10);
      expect(result.file).toBe('src/lib/auth.ts');
      expect(result.cochanges.length).toBeGreaterThanOrEqual(1);

      // config.ts changed with auth.ts twice
      const config = result.cochanges.find((c) => c.path === 'src/lib/config.ts');
      expect(config).toBeDefined();
      expect(config!.count).toBe(2);

      // storage.ts also changed with auth.ts twice
      const storage = result.cochanges.find((c) => c.path === 'src/lib/storage.ts');
      expect(storage).toBeDefined();
      expect(storage!.count).toBe(2);
    });

    it('should return empty for unknown file', () => {
      const gitLog = ['---COMMIT---', 'src/a.ts', 'src/b.ts', ''].join('\n');

      mockExecSync.mockReturnValue(gitLog);

      const result = getCoChangesForFile('src/unknown.ts', 200, 2, 10);
      expect(result.cochanges).toHaveLength(0);
    });

    it('should respect limit parameter', () => {
      const gitLog = [
        '---COMMIT---',
        'src/main.ts',
        'src/a.ts',
        'src/b.ts',
        'src/c.ts',
        '',
        '---COMMIT---',
        'src/main.ts',
        'src/a.ts',
        'src/b.ts',
        'src/c.ts',
        '',
      ].join('\n');

      mockExecSync.mockReturnValue(gitLog);

      const result = getCoChangesForFile('src/main.ts', 200, 2, 1);
      expect(result.cochanges).toHaveLength(1);
    });
  });
});
