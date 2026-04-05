import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process.execFile — vi.mock factory is hoisted, so we can't reference
// outer variables. Instead, mock the whole module and set up behavior per-test via vi.mocked.
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// Mock util.promisify to return an async wrapper around our mock execFile
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return {
    ...actual,
    promisify:
      (fn: any) =>
      async (...args: any[]) =>
        fn(...args),
  };
});

vi.mock('../config.js', () => ({
  getErrorReportingConfig: vi.fn().mockReturnValue({ enabled: false }),
  getProjectRoot: vi.fn(() => '/test/project'),
}));

vi.mock('../fault-logger.js', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { execFile } from 'child_process';
import { analyzeCoChanges, getCoChangesForFile } from './co-change.js';

const mockExecFile = vi.mocked(execFile);

function mockGitLog(gitLog: string): void {
  // promisify wraps execFile to return a promise, and our mock promisify
  // just calls the fn directly, so we mock execFile to resolve with { stdout }
  (mockExecFile as any).mockResolvedValue({ stdout: gitLog, stderr: '' });
}

describe('co-change', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('analyzeCoChanges', () => {
    it('should parse commit log and find co-change pairs', async () => {
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

      mockGitLog(gitLog);

      const result = await analyzeCoChanges(200, 2);

      expect(result.totalCommits).toBe(3);
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

    it('should skip large commits (>50 files)', async () => {
      const files = Array.from({ length: 60 }, (_, i) => `file${i}.ts`).join('\n');
      const gitLog = `---COMMIT---\n${files}\n---COMMIT---\nsrc/a.ts\nsrc/b.ts\n`;

      mockGitLog(gitLog);

      const result = await analyzeCoChanges(200, 1);
      expect(result.totalCommits).toBe(1);
    });

    it('should return empty on git failure', async () => {
      (mockExecFile as any).mockRejectedValue(new Error('not a git repository'));

      const result = await analyzeCoChanges();
      expect(result.pairs).toEqual([]);
      expect(result.totalCommits).toBe(0);
    });

    it('should apply minCooccurrence filter', async () => {
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

      mockGitLog(gitLog);

      const result = await analyzeCoChanges(200, 2);
      expect(result.pairs).toHaveLength(0);
    });

    it('should weight recent commits higher', async () => {
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

      mockGitLog(gitLog);

      const result = await analyzeCoChanges(200, 2);
      expect(result.pairs).toHaveLength(1);
      // Recency weight is the average of two commits: one recent (high weight) and one old (low weight)
      // For 3 commits: commit 0 → weight 1.0, commit 2 → weight ~0.4
      // Average should be between 0.4 and 1.0
      expect(result.pairs[0].recencyWeight).toBeGreaterThan(0.4);
      expect(result.pairs[0].recencyWeight).toBeLessThanOrEqual(1.0);
      // The old commit (index 2) should drag the average below 1.0,
      // proving the recency boost gives recent commits more weight
      expect(result.pairs[0].recencyWeight).toBeLessThan(1.0);
    });
  });

  describe('getCoChangesForFile', () => {
    it('should return co-changing files for a specific file', async () => {
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

      mockGitLog(gitLog);

      const result = await getCoChangesForFile('src/lib/auth.ts', 200, 2, 10);
      expect(result.file).toBe('src/lib/auth.ts');
      expect(result.cochanges.length).toBeGreaterThanOrEqual(1);

      const config = result.cochanges.find((c) => c.path === 'src/lib/config.ts');
      expect(config).toBeDefined();
      expect(config!.count).toBe(2);

      const storage = result.cochanges.find((c) => c.path === 'src/lib/storage.ts');
      expect(storage).toBeDefined();
      expect(storage!.count).toBe(2);
    });

    it('should return empty for unknown file', async () => {
      const gitLog = ['---COMMIT---', 'src/a.ts', 'src/b.ts', ''].join('\n');

      mockGitLog(gitLog);

      const result = await getCoChangesForFile('src/unknown.ts', 200, 2, 10);
      expect(result.cochanges).toHaveLength(0);
    });

    it('returns empty cochanges when git log is empty', async () => {
      mockGitLog('');

      const result = await getCoChangesForFile('src/any.ts', 200, 2, 10);
      expect(result.cochanges).toHaveLength(0);
    });

    it('should respect limit parameter', async () => {
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

      mockGitLog(gitLog);

      const result = await getCoChangesForFile('src/main.ts', 200, 2, 1);
      expect(result.cochanges).toHaveLength(1);
    });
  });
});
