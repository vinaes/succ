/**
 * Tests for scan-code module
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(),
    statSync: vi.fn(),
    readdirSync: vi.fn(),
    existsSync: vi.fn(),
  },
  readFileSync: vi.fn(),
  statSync: vi.fn(),
  readdirSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('minimatch', () => ({
  minimatch: vi.fn((filePath: string, pattern: string) => {
    // Simple glob matching for tests
    if (pattern === '*.log') return filePath.endsWith('.log');
    if (pattern === 'dist/**') return filePath.startsWith('dist/');
    if (pattern === 'generated/**') return filePath.startsWith('generated/');
    if (pattern === 'dist/index.js') return filePath === 'dist/index.js';
    return false;
  }),
}));

vi.mock('../lib/tree-sitter/types.js', () => ({
  EXTENSION_TO_LANGUAGE: {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    py: 'python',
    go: 'go',
    rs: 'rust',
  },
}));

vi.mock('../lib/storage/index.js', () => ({
  getAllFileHashes: vi.fn(),
}));

vi.mock('../lib/config.js', () => ({
  getProjectRoot: vi.fn(() => '/project'),
  getConfig: vi.fn(() => ({})),
}));

vi.mock('./index-code.js', () => ({
  indexCodeFile: vi.fn(),
  computeHash: vi.fn((content: string) => `hash_${content.length}`),
}));

vi.mock('../lib/fault-logger.js', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('p-limit', () => ({
  default: vi.fn((concurrency: number) => {
    // Real p-limit behavior: wraps functions with concurrency control
    const limit = (fn: () => Promise<any>) => fn();
    (limit as any)._concurrency = concurrency;
    return limit;
  }),
}));

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { getAllFileHashes } from '../lib/storage/index.js';
import { getConfig } from '../lib/config.js';
import { indexCodeFile } from './index-code.js';
import { logInfo } from '../lib/fault-logger.js';
import pLimit from 'p-limit';

import {
  loadIgnorePatterns,
  isIgnored,
  discoverCodeFiles,
  categorizeFiles,
  scanCode,
} from './scan-code.js';

// ============================================================================
// loadIgnorePatterns
// ============================================================================

describe('loadIgnorePatterns', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty array when no .succignore exists', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = loadIgnorePatterns('/project');
    expect(result).toEqual([]);
  });

  it('parses glob patterns, skips comments and blank lines', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('# comment\n\n*.log\ndist/**\n!dist/index.js\n');

    const result = loadIgnorePatterns('/project');
    expect(result).toEqual(['*.log', 'dist/**', '!dist/index.js']);
  });
});

// ============================================================================
// isIgnored
// ============================================================================

describe('isIgnored', () => {
  it('matches files against patterns', () => {
    const patterns = ['*.log', 'dist/**'];
    expect(isIgnored('app.log', patterns)).toBe(true);
    expect(isIgnored('src/main.ts', patterns)).toBe(false);
    expect(isIgnored('dist/bundle.js', patterns)).toBe(true);
  });

  it('handles negation patterns', () => {
    const patterns = ['dist/**', '!dist/index.js'];
    expect(isIgnored('dist/bundle.js', patterns)).toBe(true);
    expect(isIgnored('dist/index.js', patterns)).toBe(false);
  });
});

// ============================================================================
// discoverCodeFiles
// ============================================================================

describe('discoverCodeFiles', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns only files with supported extensions', () => {
    vi.mocked(execFileSync).mockReturnValue(
      'src/app.ts\nREADME.md\nlogo.png\nsrc/main.py\nMakefile'
    );
    vi.mocked(fs.statSync).mockReturnValue({ size: 1000 } as any);

    const result = discoverCodeFiles({ projectRoot: '/project' });

    expect(result.source).toBe('git');
    expect(result.files.length).toBe(2);
    expect(result.files.some((f) => f.includes('app.ts'))).toBe(true);
    expect(result.files.some((f) => f.includes('main.py'))).toBe(true);
    expect(result.skippedExtension).toBe(3);
  });

  it('filters files exceeding max size', () => {
    vi.mocked(execFileSync).mockReturnValue('small.ts\nhuge.ts');
    vi.mocked(fs.statSync).mockImplementation((p: any) => {
      if (String(p).includes('huge')) return { size: 600 * 1024 } as any;
      return { size: 100 * 1024 } as any;
    });

    const result = discoverCodeFiles({ projectRoot: '/project', maxFileSizeKb: 500 });

    expect(result.files.length).toBe(1);
    expect(result.skippedSize).toBe(1);
  });

  it('filters by path prefix', () => {
    vi.mocked(execFileSync).mockReturnValue('src/a.ts\nsrc/b.ts\nlib/c.ts\ntest/d.ts');
    vi.mocked(fs.statSync).mockReturnValue({ size: 1000 } as any);

    const result = discoverCodeFiles({ projectRoot: '/project', filterPath: 'src' });

    expect(result.files.length).toBe(2);
    expect(result.skippedPath).toBe(2);
  });

  it('applies .succignore patterns', () => {
    vi.mocked(execFileSync).mockReturnValue('src/a.ts\ngenerated/b.ts\nsrc/c.ts');
    vi.mocked(fs.statSync).mockReturnValue({ size: 1000 } as any);

    const result = discoverCodeFiles({
      projectRoot: '/project',
      ignorePatterns: ['generated/**'],
    });

    expect(result.files.length).toBe(2);
    expect(result.skippedIgnore).toBe(1);
  });

  it('falls back to recursive walk for non-git projects', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not a git repository');
    });

    // Mock readdirSync for recursive walk
    vi.mocked(fs.readdirSync).mockImplementation((dir: any) => {
      const d = String(dir);
      if (d === '/project') {
        return [
          { name: 'src', isDirectory: () => true, isFile: () => false },
          { name: 'node_modules', isDirectory: () => true, isFile: () => false },
          { name: 'readme.md', isDirectory: () => false, isFile: () => true },
        ] as any;
      }
      if (d.endsWith('src')) {
        return [
          { name: 'app.ts', isDirectory: () => false, isFile: () => true },
          { name: 'util.py', isDirectory: () => false, isFile: () => true },
        ] as any;
      }
      return [];
    });
    vi.mocked(fs.statSync).mockReturnValue({ size: 1000 } as any);

    const result = discoverCodeFiles({ projectRoot: '/project' });

    expect(result.source).toBe('walk');
    expect(result.files.length).toBe(2); // app.ts + util.py (readme.md skipped by extension)
    expect(result.files.some((f) => f.includes('app.ts'))).toBe(true);
  });

  it('handles empty git output', () => {
    vi.mocked(execFileSync).mockReturnValue('');

    const result = discoverCodeFiles({ projectRoot: '/project' });

    expect(result.files).toEqual([]);
    expect(result.totalScanned).toBe(0);
  });

  it('skips default ignore dirs in recursive walk (node_modules, .git, dist)', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not a git repo');
    });

    vi.mocked(fs.readdirSync).mockImplementation((dir: any) => {
      const d = String(dir);
      if (d === '/project') {
        return [
          { name: 'src', isDirectory: () => true, isFile: () => false },
          { name: 'node_modules', isDirectory: () => true, isFile: () => false },
          { name: '.git', isDirectory: () => true, isFile: () => false },
          { name: 'dist', isDirectory: () => true, isFile: () => false },
        ] as any;
      }
      if (d.endsWith('src')) {
        return [{ name: 'a.ts', isDirectory: () => false, isFile: () => true }] as any;
      }
      // Should NOT be called for node_modules/.git/dist
      return [{ name: 'b.ts', isDirectory: () => false, isFile: () => true }] as any;
    });
    vi.mocked(fs.statSync).mockReturnValue({ size: 1000 } as any);

    const result = discoverCodeFiles({ projectRoot: '/project' });

    expect(result.files.length).toBe(1);
    expect(result.files[0]).toContain('a.ts');
  });
});

// ============================================================================
// categorizeFiles
// ============================================================================

describe('categorizeFiles', () => {
  beforeEach(() => vi.clearAllMocks());

  it('identifies new files not in hash map', async () => {
    vi.mocked(getAllFileHashes).mockResolvedValue(new Map([['code:src/a.ts', 'hash1']]));

    const result = await categorizeFiles(['/project/src/b.ts'], '/project', false);

    expect(result.toIndex).toHaveLength(1);
    expect(result.newCount).toBe(1);
  });

  it('identifies modified files with different hash', async () => {
    vi.mocked(getAllFileHashes).mockResolvedValue(new Map([['code:src/a.ts', 'oldhash']]));
    vi.mocked(fs.readFileSync).mockReturnValue('modified content');
    // computeHash mock returns 'hash_16' for 'modified content' (length 16)
    // which differs from 'oldhash'

    const result = await categorizeFiles(['/project/src/a.ts'], '/project', false);

    expect(result.toIndex).toHaveLength(1);
    expect(result.modifiedCount).toBe(1);
  });

  it('marks files as unchanged when hashes match', async () => {
    vi.mocked(getAllFileHashes).mockResolvedValue(new Map([['code:src/a.ts', 'hash_7']]));
    vi.mocked(fs.readFileSync).mockReturnValue('content'); // length 7 → computeHash returns 'hash_7'

    const result = await categorizeFiles(['/project/src/a.ts'], '/project', false);

    expect(result.toIndex).toHaveLength(0);
    expect(result.unchangedCount).toBe(1);
  });

  it('with force=true includes everything for indexing', async () => {
    vi.mocked(getAllFileHashes).mockResolvedValue(new Map([['code:src/a.ts', 'hash_7']]));

    const result = await categorizeFiles(['/project/src/a.ts'], '/project', true);

    expect(result.toIndex).toHaveLength(1);
    expect(result.modifiedCount).toBe(1);
    expect(result.unchangedCount).toBe(0);
  });

  it('handles readFileSync error gracefully', async () => {
    vi.mocked(getAllFileHashes).mockResolvedValue(new Map([['code:src/a.ts', 'somehash']]));
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('EACCES');
    });

    const result = await categorizeFiles(['/project/src/a.ts'], '/project', false);

    expect(result.toIndex).toHaveLength(0);
    expect(result.readErrors).toBe(1);
  });
});

// ============================================================================
// scanCode
// ============================================================================

describe('scanCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConfig).mockReturnValue({} as any);
    // Default: no .succignore
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes('.succignore')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return 'file content';
    });
  });

  it('returns correct counts for successful scan', async () => {
    // Setup: git returns 5 files, 3 supported extensions
    vi.mocked(execFileSync).mockReturnValue('a.ts\nb.py\nc.md\nd.ts\ne.txt');
    vi.mocked(fs.statSync).mockReturnValue({ size: 1000 } as any);

    // 2 new, 1 modified (different hash)
    vi.mocked(getAllFileHashes).mockResolvedValue(new Map([['code:d.ts', 'oldhash']]));

    // computeHash for readFileSync('file content') returns 'hash_12'
    // 'oldhash' !== 'hash_12' so d.ts is modified

    vi.mocked(indexCodeFile).mockResolvedValue({ success: true, chunks: 5 });

    const result = await scanCode({});

    expect(result.totalScanned).toBe(5);
    expect(result.totalCode).toBe(3); // a.ts, b.py, d.ts
    expect(result.indexed).toBe(3);
    expect(result.newCount).toBe(2); // a.ts, b.py
    expect(result.updatedCount).toBe(1); // d.ts
    expect(result.chunks).toBe(15); // 3 × 5
    expect(result.errors).toBe(0);
  });

  it('handles indexCodeFile failures', async () => {
    vi.mocked(execFileSync).mockReturnValue('a.ts\nb.ts\nc.ts');
    vi.mocked(fs.statSync).mockReturnValue({ size: 1000 } as any);
    vi.mocked(getAllFileHashes).mockResolvedValue(new Map());

    vi.mocked(indexCodeFile)
      .mockResolvedValueOnce({ success: true, chunks: 3 })
      .mockResolvedValueOnce({ success: false, error: 'parse error' })
      .mockResolvedValueOnce({ success: true, chunks: 3 });

    const result = await scanCode({});

    expect(result.indexed).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.chunks).toBe(6);
    expect(result.errorDetails).toHaveLength(1);
    expect(result.errorDetails[0]).toContain('parse error');
  });

  it('uses p-limit with configured concurrency', async () => {
    vi.mocked(getConfig).mockReturnValue({ indexing: { concurrency: 5 } } as any);
    vi.mocked(execFileSync).mockReturnValue('a.ts');
    vi.mocked(fs.statSync).mockReturnValue({ size: 1000 } as any);
    vi.mocked(getAllFileHashes).mockResolvedValue(new Map());
    vi.mocked(indexCodeFile).mockResolvedValue({ success: true, chunks: 1 });

    await scanCode({});

    expect(pLimit).toHaveBeenCalledWith(5);
  });

  it('logs progress every 50 files', async () => {
    const files = Array.from({ length: 120 }, (_, i) => `file${i}.ts`).join('\n');
    vi.mocked(execFileSync).mockReturnValue(files);
    vi.mocked(fs.statSync).mockReturnValue({ size: 1000 } as any);
    vi.mocked(getAllFileHashes).mockResolvedValue(new Map());
    vi.mocked(indexCodeFile).mockResolvedValue({ success: true, chunks: 1 });

    await scanCode({});

    // Should log progress at 50 and 100
    const progressCalls = vi
      .mocked(logInfo)
      .mock.calls.filter(
        (call) => call[0] === 'scan-code' && String(call[1]).includes('Progress:')
      );
    expect(progressCalls.length).toBe(2);
  });

  it('passes force and filterPath through', async () => {
    vi.mocked(execFileSync).mockReturnValue('src/a.ts\nlib/b.ts');
    vi.mocked(fs.statSync).mockReturnValue({ size: 1000 } as any);
    vi.mocked(getAllFileHashes).mockResolvedValue(new Map([['code:src/a.ts', 'hash_12']]));
    vi.mocked(indexCodeFile).mockResolvedValue({ success: true, chunks: 1 });

    const result = await scanCode({ filterPath: 'src', force: true });

    // Only src/a.ts passes path filter, force=true so it gets indexed despite matching hash
    expect(result.indexed).toBe(1);
    expect(result.updatedCount).toBe(1); // force treats existing as modified
  });

  it('returns early when no files to index', async () => {
    vi.mocked(execFileSync).mockReturnValue('a.ts');
    vi.mocked(fs.statSync).mockReturnValue({ size: 1000 } as any);
    vi.mocked(getAllFileHashes).mockResolvedValue(new Map([['code:a.ts', 'hash_12']]));
    // readFileSync returns 'file content' (length 12) → hash_12 matches

    const result = await scanCode({});

    expect(result.indexed).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(indexCodeFile).not.toHaveBeenCalled();
  });

  it('reads max_file_size_kb from config', async () => {
    vi.mocked(getConfig).mockReturnValue({ indexing: { max_file_size_kb: 200 } } as any);
    vi.mocked(execFileSync).mockReturnValue('small.ts\nbig.ts');
    vi.mocked(fs.statSync).mockImplementation((p: any) => {
      if (String(p).includes('big')) return { size: 300 * 1024 } as any;
      return { size: 100 * 1024 } as any;
    });
    vi.mocked(getAllFileHashes).mockResolvedValue(new Map());
    vi.mocked(indexCodeFile).mockResolvedValue({ success: true, chunks: 1 });

    const result = await scanCode({});

    expect(result.skippedSize).toBe(1);
    expect(result.indexed).toBe(1);
  });

  it('reports source as walk for non-git projects', async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not a git repo');
    });
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'app.ts', isDirectory: () => false, isFile: () => true },
    ] as any);
    vi.mocked(fs.statSync).mockReturnValue({ size: 1000 } as any);
    vi.mocked(getAllFileHashes).mockResolvedValue(new Map());
    vi.mocked(indexCodeFile).mockResolvedValue({ success: true, chunks: 1 });

    const result = await scanCode({});

    expect(result.source).toBe('walk');
  });
});
