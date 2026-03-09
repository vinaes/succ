import { describe, it, expect, vi } from 'vitest';
import { detectChangedFiles } from './diff-brain.js';

// Mock child_process and config
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));
vi.mock('./config.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

import { execFileSync } from 'child_process';

const mockExecFileSync = vi.mocked(execFileSync);

describe('diff-brain', () => {
  it('should detect changed files from git diff', () => {
    mockExecFileSync.mockReturnValue(
      'src/lib/auth.ts\nsrc/lib/config.ts\nREADME.md\npackage.json\n'
    );

    const result = detectChangedFiles('HEAD~1');

    expect(result.changedFiles).toHaveLength(4);
    expect(result.filesToAnalyze).toHaveLength(2); // only .ts files
    expect(result.filesToAnalyze).toContain('src/lib/auth.ts');
    expect(result.filesToAnalyze).toContain('src/lib/config.ts');
    expect(result.reference).toBe('HEAD~1');
  });

  it('should return empty on git diff failure', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not a git repository');
    });

    const result = detectChangedFiles('HEAD~1');

    expect(result.changedFiles).toHaveLength(0);
    expect(result.filesToAnalyze).toHaveLength(0);
  });

  it('should reject invalid diff references', () => {
    expect(() => detectChangedFiles('$(rm -rf /)')).toThrow('Invalid diff reference');
    expect(() => detectChangedFiles('HEAD; echo pwned')).toThrow('Invalid diff reference');
  });

  it('should find affected brain docs for changed files', () => {
    mockExecFileSync.mockReturnValue('src/lib/auth.ts\nsrc/api/routes/users.ts\n');

    const result = detectChangedFiles('main');

    expect(result.affectedDocs.length).toBeGreaterThan(0);
    // Brain docs are derived from directory paths
    expect(result.affectedDocs.some((d) => d.includes('src'))).toBe(true);
  });

  it('should filter non-source files', () => {
    mockExecFileSync.mockReturnValue(
      'README.md\npackage.json\n.gitignore\ntsconfig.json\nsrc/app.ts\n'
    );

    const result = detectChangedFiles('HEAD~1');

    expect(result.changedFiles).toHaveLength(5);
    expect(result.filesToAnalyze).toHaveLength(1);
    expect(result.filesToAnalyze[0]).toBe('src/app.ts');
  });
});
