import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import { discoverProjects, listProjects } from './cross-repo.js';

vi.mock('fs');

const mockFs = vi.mocked(fs);

describe('cross-repo', () => {
  it('should discover succ-initialized projects', () => {
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p).replace(/\\/g, '/');
      if (s === '/projects') return true;
      if (s.includes('myapp/.succ/succ.db')) return true;
      if (s.includes('myapp/.succ')) return true;
      return false;
    });

    mockFs.readdirSync.mockReturnValue([
      { name: 'myapp', isDirectory: () => true, isFile: () => false } as any,
      { name: 'other', isDirectory: () => true, isFile: () => false } as any,
      { name: '.hidden', isDirectory: () => true, isFile: () => false } as any,
    ]);

    const projects = discoverProjects(['/projects']);

    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('myapp');
    expect(projects[0].initialized).toBe(true);
  });

  it('should skip non-existent search paths', () => {
    mockFs.existsSync.mockReturnValue(false);
    const projects = discoverProjects(['/nonexistent']);
    expect(projects).toHaveLength(0);
  });

  it('should handle fs errors gracefully', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });

    const projects = discoverProjects(['/projects']);
    expect(projects).toHaveLength(0);
  });

  it('listProjects should delegate to discoverProjects', () => {
    mockFs.existsSync.mockReturnValue(false);
    const result = listProjects(['/nowhere']);
    expect(result).toEqual([]);
  });
});
