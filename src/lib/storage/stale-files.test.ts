/**
 * Tests for getStaleFileCount in storage/index.ts.
 *
 * Verifies:
 * - All files fresh → stale=0, deleted=0
 * - File modified with different hash → stale++
 * - File modified but same hash (touch only) → not stale
 * - File deleted from disk → deleted++
 * - Code-prefixed files (code:src/...) handled correctly
 * - Mixed scenario: some fresh, some stale, some deleted
 * - Empty index → all zeros
 * - Path separator normalization
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// We'll mock the dispatcher to control getAllFileHashesWithTimestamps
const mockGetAllFileHashesWithTimestamps = vi.fn();

vi.mock('./dispatcher.js', () => ({
  getStorageDispatcher: vi.fn(async () => ({
    getAllFileHashesWithTimestamps: mockGetAllFileHashesWithTimestamps,
  })),
}));

// Mock fs for statSync and readFileSync
const mockStatSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      statSync: (...args: any[]) => mockStatSync(...args),
      readFileSync: (...args: any[]) => mockReadFileSync(...args),
    },
    statSync: (...args: any[]) => mockStatSync(...args),
    readFileSync: (...args: any[]) => mockReadFileSync(...args),
  };
});

import { getStaleFileCount } from './index.js';

function md5(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

describe('getStaleFileCount', () => {
  const projectRoot = '/test/project';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return all zeros when index is empty', async () => {
    mockGetAllFileHashesWithTimestamps.mockResolvedValue([]);

    const result = await getStaleFileCount(projectRoot);

    expect(result).toEqual({ stale: 0, deleted: 0, total: 0 });
  });

  it('should detect fresh files (mtime < indexed_at)', async () => {
    const content = 'hello world';
    mockGetAllFileHashesWithTimestamps.mockResolvedValue([
      { file_path: 'src/app.ts', content_hash: md5(content), indexed_at: '2026-01-15T12:00:00Z' },
    ]);
    // File mtime is before indexed_at
    mockStatSync.mockReturnValue({ mtimeMs: new Date('2026-01-14T00:00:00Z').getTime() });

    const result = await getStaleFileCount(projectRoot);

    expect(result).toEqual({ stale: 0, deleted: 0, total: 1 });
    // readFileSync should NOT be called — mtime optimization
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('should detect stale files (modified content after indexing)', async () => {
    const originalContent = 'original';
    const modifiedContent = 'modified';
    mockGetAllFileHashesWithTimestamps.mockResolvedValue([
      { file_path: 'src/app.ts', content_hash: md5(originalContent), indexed_at: '2026-01-15T12:00:00Z' },
    ]);
    // File mtime is after indexed_at
    mockStatSync.mockReturnValue({ mtimeMs: new Date('2026-01-16T00:00:00Z').getTime() });
    mockReadFileSync.mockReturnValue(modifiedContent);

    const result = await getStaleFileCount(projectRoot);

    expect(result).toEqual({ stale: 1, deleted: 0, total: 1 });
  });

  it('should not count as stale when file was touched but content unchanged', async () => {
    const content = 'same content';
    mockGetAllFileHashesWithTimestamps.mockResolvedValue([
      { file_path: 'src/app.ts', content_hash: md5(content), indexed_at: '2026-01-15T12:00:00Z' },
    ]);
    // File mtime is after indexed_at but content is the same
    mockStatSync.mockReturnValue({ mtimeMs: new Date('2026-01-16T00:00:00Z').getTime() });
    mockReadFileSync.mockReturnValue(content);

    const result = await getStaleFileCount(projectRoot);

    expect(result).toEqual({ stale: 0, deleted: 0, total: 1 });
  });

  it('should detect deleted files', async () => {
    mockGetAllFileHashesWithTimestamps.mockResolvedValue([
      { file_path: 'src/removed.ts', content_hash: 'abc123', indexed_at: '2026-01-15T12:00:00Z' },
    ]);
    mockStatSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    const result = await getStaleFileCount(projectRoot);

    expect(result).toEqual({ stale: 0, deleted: 1, total: 1 });
  });

  it('should strip code: prefix for disk path resolution', async () => {
    const content = 'code file';
    mockGetAllFileHashesWithTimestamps.mockResolvedValue([
      { file_path: 'code:src/lib/config.ts', content_hash: md5(content), indexed_at: '2026-01-15T12:00:00Z' },
    ]);
    mockStatSync.mockReturnValue({ mtimeMs: new Date('2026-01-14T00:00:00Z').getTime() });

    await getStaleFileCount(projectRoot);

    // Should resolve path WITHOUT the code: prefix
    const calledPath = mockStatSync.mock.calls[0][0] as string;
    expect(calledPath).not.toContain('code:');
    expect(calledPath).toContain('config.ts');
  });

  it('should handle mixed scenario: fresh + stale + deleted', async () => {
    const freshContent = 'fresh';
    const staleOriginal = 'original';
    const staleModified = 'changed';

    mockGetAllFileHashesWithTimestamps.mockResolvedValue([
      { file_path: 'src/fresh.ts', content_hash: md5(freshContent), indexed_at: '2026-01-15T12:00:00Z' },
      { file_path: 'src/stale.ts', content_hash: md5(staleOriginal), indexed_at: '2026-01-15T12:00:00Z' },
      { file_path: 'src/deleted.ts', content_hash: 'abc', indexed_at: '2026-01-15T12:00:00Z' },
    ]);

    mockStatSync.mockImplementation((fullPath: string) => {
      if (fullPath.includes('fresh')) {
        return { mtimeMs: new Date('2026-01-14T00:00:00Z').getTime() }; // before indexed_at
      }
      if (fullPath.includes('stale')) {
        return { mtimeMs: new Date('2026-01-16T00:00:00Z').getTime() }; // after indexed_at
      }
      throw new Error('ENOENT');
    });

    mockReadFileSync.mockImplementation((fullPath: string) => {
      if ((fullPath as string).includes('stale')) return staleModified;
      return '';
    });

    const result = await getStaleFileCount(projectRoot);

    expect(result).toEqual({ stale: 1, deleted: 1, total: 3 });
  });

  it('should correctly report total count', async () => {
    mockGetAllFileHashesWithTimestamps.mockResolvedValue([
      { file_path: 'a.ts', content_hash: 'h1', indexed_at: '2026-01-15T12:00:00Z' },
      { file_path: 'b.ts', content_hash: 'h2', indexed_at: '2026-01-15T12:00:00Z' },
      { file_path: 'c.ts', content_hash: 'h3', indexed_at: '2026-01-15T12:00:00Z' },
      { file_path: 'code:d.ts', content_hash: 'h4', indexed_at: '2026-01-15T12:00:00Z' },
      { file_path: 'code:e.ts', content_hash: 'h5', indexed_at: '2026-01-15T12:00:00Z' },
    ]);
    // All fresh
    mockStatSync.mockReturnValue({ mtimeMs: new Date('2026-01-14T00:00:00Z').getTime() });

    const result = await getStaleFileCount(projectRoot);

    expect(result.total).toBe(5);
    expect(result.stale).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it('should handle forward-slash paths on any OS', async () => {
    mockGetAllFileHashesWithTimestamps.mockResolvedValue([
      { file_path: 'src/lib/utils.ts', content_hash: 'h1', indexed_at: '2026-01-15T12:00:00Z' },
    ]);
    mockStatSync.mockReturnValue({ mtimeMs: new Date('2026-01-14T00:00:00Z').getTime() });

    const result = await getStaleFileCount(projectRoot);

    expect(result).toEqual({ stale: 0, deleted: 0, total: 1 });
    expect(mockStatSync).toHaveBeenCalledTimes(1);
  });
});
