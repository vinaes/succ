import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import type * as fs from 'fs';

vi.mock('./fault-logger.js', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

// Targeted fs mock — only override functions the SUT uses.
// Full vi.mock('fs') auto-mocks the entire module including internals
// that vitest's fork worker needs for cleanup, causing worker crashes.
const existsSyncMock = vi.fn<(...args: unknown[]) => boolean>(() => false);
const readdirSyncMock = vi.fn<(...args: unknown[]) => unknown[]>(() => []);

vi.mock('fs', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof fs;
  return {
    ...orig,
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    readdirSync: (...args: unknown[]) => readdirSyncMock(...args),
    default: {
      ...orig.default,
      existsSync: (...args: unknown[]) => existsSyncMock(...args),
      readdirSync: (...args: unknown[]) => readdirSyncMock(...args),
    },
  };
});

import { discoverProjects, listProjects } from './cross-repo.js';

describe('cross-repo', () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
    readdirSyncMock.mockReset();
  });

  it('should discover succ-initialized projects', () => {
    // path.resolve normalizes '/projects' to platform-specific absolute path
    const root = path.resolve('/projects');
    const myappRoot = path.join(root, 'myapp');

    existsSyncMock.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s === root) return true;
      if (s === path.join(myappRoot, '.succ')) return true;
      if (s === path.join(myappRoot, '.succ', 'succ.db')) return true;
      return false;
    });

    readdirSyncMock.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s === root) {
        return [
          { name: 'myapp', isDirectory: () => true, isFile: () => false },
          { name: 'other', isDirectory: () => true, isFile: () => false },
          { name: '.hidden', isDirectory: () => true, isFile: () => false },
        ];
      }
      // Depth 2: no sub-entries for child directories
      return [];
    });

    const projects = discoverProjects(['/projects']);

    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('myapp');
    expect(projects[0].initialized).toBe(true);
  });

  it('should skip non-existent search paths', () => {
    existsSyncMock.mockReturnValue(false);
    const projects = discoverProjects(['/nonexistent']);
    expect(projects).toHaveLength(0);
  });

  it('should handle fs errors gracefully', () => {
    const root = path.resolve('/projects');
    existsSyncMock.mockImplementation((p: unknown) => {
      // Search path exists but is not itself a succ project
      if (String(p) === root) return true;
      return false;
    });
    readdirSyncMock.mockImplementation(() => {
      throw new Error('Permission denied');
    });

    const projects = discoverProjects(['/projects']);
    expect(projects).toHaveLength(0);
  });

  it('listProjects should delegate to discoverProjects', () => {
    existsSyncMock.mockReturnValue(false);
    const result = listProjects(['/nowhere']);
    expect(result).toEqual([]);
  });
});
