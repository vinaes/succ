/**
 * Tests for reindex command.
 *
 * Verifies:
 * - All up to date → early return
 * - Deleted files → deleteDocumentsByPath + deleteFileHash called
 * - Stale doc files → indexDocFile called with force
 * - Stale code files → indexCodeFile called with force
 * - Mixed scenario: stale docs + stale code + deleted
 * - indexDocFile error → counted as error
 * - indexCodeFile throws → caught and counted as error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetStaleFiles = vi.fn();
const mockDeleteDocumentsByPath = vi.fn();
const mockDeleteFileHash = vi.fn();
const mockCloseDb = vi.fn();
const mockIndexDocFile = vi.fn();
const mockIndexCodeFile = vi.fn();

vi.mock('../lib/config.js', () => ({
  getProjectRoot: vi.fn(() => '/test/project'),
}));

vi.mock('../lib/storage/index.js', () => ({
  getStaleFiles: (...args: any[]) => mockGetStaleFiles(...args),
  deleteDocumentsByPath: (...args: any[]) => mockDeleteDocumentsByPath(...args),
  deleteFileHash: (...args: any[]) => mockDeleteFileHash(...args),
  closeDb: (...args: any[]) => mockCloseDb(...args),
}));

vi.mock('./index.js', () => ({
  indexDocFile: (...args: any[]) => mockIndexDocFile(...args),
}));

vi.mock('./index-code.js', () => ({
  indexCodeFile: (...args: any[]) => mockIndexCodeFile(...args),
}));

import { reindex } from './reindex.js';

describe('reindex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress console.log in tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('should return early when all files are up to date', async () => {
    mockGetStaleFiles.mockResolvedValue({ stale: [], deleted: [], total: 100 });

    await reindex();

    expect(mockGetStaleFiles).toHaveBeenCalledWith('/test/project');
    expect(mockDeleteDocumentsByPath).not.toHaveBeenCalled();
    expect(mockDeleteFileHash).not.toHaveBeenCalled();
    expect(mockIndexDocFile).not.toHaveBeenCalled();
    expect(mockIndexCodeFile).not.toHaveBeenCalled();
    expect(mockCloseDb).toHaveBeenCalled();
  });

  it('should clean up deleted file entries', async () => {
    mockGetStaleFiles.mockResolvedValue({
      stale: [],
      deleted: ['old-file.md', 'removed.md'],
      total: 50,
    });
    mockDeleteDocumentsByPath.mockResolvedValue(undefined);
    mockDeleteFileHash.mockResolvedValue(undefined);

    await reindex();

    expect(mockDeleteDocumentsByPath).toHaveBeenCalledTimes(2);
    expect(mockDeleteDocumentsByPath).toHaveBeenCalledWith('old-file.md');
    expect(mockDeleteDocumentsByPath).toHaveBeenCalledWith('removed.md');
    expect(mockDeleteFileHash).toHaveBeenCalledTimes(2);
    expect(mockDeleteFileHash).toHaveBeenCalledWith('old-file.md');
    expect(mockDeleteFileHash).toHaveBeenCalledWith('removed.md');
    expect(mockCloseDb).toHaveBeenCalled();
  });

  it('should reindex stale doc files with force', async () => {
    mockGetStaleFiles.mockResolvedValue({
      stale: ['docs/guide.md'],
      deleted: [],
      total: 50,
    });
    mockIndexDocFile.mockResolvedValue({ success: true, skipped: false });

    await reindex();

    expect(mockIndexDocFile).toHaveBeenCalledTimes(1);
    // Should pass absolute path and force: true
    const [filePath, opts] = mockIndexDocFile.mock.calls[0];
    expect(filePath).toContain('guide.md');
    expect(opts).toEqual({ force: true });
    expect(mockIndexCodeFile).not.toHaveBeenCalled();
    expect(mockCloseDb).toHaveBeenCalled();
  });

  it('should reindex stale code files with force', async () => {
    mockGetStaleFiles.mockResolvedValue({
      stale: ['code:src/lib/config.ts'],
      deleted: [],
      total: 50,
    });
    mockIndexCodeFile.mockResolvedValue({ success: true, skipped: false });

    await reindex();

    expect(mockIndexCodeFile).toHaveBeenCalledTimes(1);
    const [filePath, opts] = mockIndexCodeFile.mock.calls[0];
    expect(filePath).toContain('config.ts');
    expect(filePath).not.toContain('code:');
    expect(opts).toEqual({ force: true });
    expect(mockIndexDocFile).not.toHaveBeenCalled();
  });

  it('should handle mixed scenario: stale + deleted', async () => {
    mockGetStaleFiles.mockResolvedValue({
      stale: ['brain/notes.md', 'code:src/app.ts'],
      deleted: ['gone.md'],
      total: 100,
    });
    mockDeleteDocumentsByPath.mockResolvedValue(undefined);
    mockDeleteFileHash.mockResolvedValue(undefined);
    mockIndexDocFile.mockResolvedValue({ success: true, skipped: false });
    mockIndexCodeFile.mockResolvedValue({ success: true, skipped: false });

    await reindex();

    // Deleted
    expect(mockDeleteDocumentsByPath).toHaveBeenCalledWith('gone.md');
    expect(mockDeleteFileHash).toHaveBeenCalledWith('gone.md');

    // Stale doc
    expect(mockIndexDocFile).toHaveBeenCalledTimes(1);
    expect(mockIndexDocFile.mock.calls[0][0]).toContain('notes.md');

    // Stale code
    expect(mockIndexCodeFile).toHaveBeenCalledTimes(1);
    expect(mockIndexCodeFile.mock.calls[0][0]).toContain('app.ts');
  });

  it('should count errors from indexDocFile', async () => {
    mockGetStaleFiles.mockResolvedValue({
      stale: ['bad-file.md'],
      deleted: [],
      total: 10,
    });
    mockIndexDocFile.mockResolvedValue({ success: false, error: 'Not a markdown file' });

    await reindex();

    expect(mockIndexDocFile).toHaveBeenCalledTimes(1);
    // Should still close DB
    expect(mockCloseDb).toHaveBeenCalled();
  });

  it('should catch and count thrown errors from indexCodeFile', async () => {
    mockGetStaleFiles.mockResolvedValue({
      stale: ['code:src/broken.ts'],
      deleted: [],
      total: 10,
    });
    mockIndexCodeFile.mockRejectedValue(new Error('Embedding failed'));

    await reindex();

    expect(mockIndexCodeFile).toHaveBeenCalledTimes(1);
    expect(mockCloseDb).toHaveBeenCalled();
  });

  it('should not call indexers when only deleted files exist', async () => {
    mockGetStaleFiles.mockResolvedValue({
      stale: [],
      deleted: ['removed.md'],
      total: 10,
    });
    mockDeleteDocumentsByPath.mockResolvedValue(undefined);
    mockDeleteFileHash.mockResolvedValue(undefined);

    await reindex();

    expect(mockIndexDocFile).not.toHaveBeenCalled();
    expect(mockIndexCodeFile).not.toHaveBeenCalled();
    expect(mockDeleteDocumentsByPath).toHaveBeenCalledTimes(1);
    expect(mockDeleteFileHash).toHaveBeenCalledTimes(1);
  });
});
