import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks — these are evaluated before vi.mock factories
const { mockSpawnSync, mockFs } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' }),
  mockFs: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(),
    rmSync: vi.fn(),
    symlinkSync: vi.fn(),
  },
}));

vi.mock('cross-spawn', () => ({
  default: Object.assign(vi.fn(), { sync: mockSpawnSync }),
}));

vi.mock('fs', () => ({ default: mockFs, ...mockFs }));

vi.mock('../config.js', () => ({
  getErrorReportingConfig: vi.fn().mockReturnValue({ enabled: false }),
  getSuccDir: () => '/project/.succ',
  getErrorReportingConfig: vi.fn().mockReturnValue({ enabled: false }),
}));

import {
  getWorktreesDir,
  createWorktree,
  mergeWorktreeChanges,
  removeWorktree,
  cleanupAllWorktrees,
} from './worktree.js';

/** Helper: find calls to spawnSync where args contain a substring */
function findCalls(substring: string) {
  return mockSpawnSync.mock.calls.filter(
    (c: any[]) => c[0] === 'git' && (c[1] as string[]).some((a) => a.includes(substring))
  );
}

describe('worktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    mockFs.existsSync.mockReturnValue(false);
  });

  // ==========================================================================
  // getWorktreesDir
  // ==========================================================================

  describe('getWorktreesDir', () => {
    it('should return .succ/worktrees path', () => {
      const dir = getWorktreesDir();
      expect(dir).toContain('.succ');
      expect(dir).toContain('worktrees');
    });
  });

  // ==========================================================================
  // createWorktree
  // ==========================================================================

  describe('createWorktree', () => {
    it('should create worktrees directory if missing', () => {
      mockFs.existsSync.mockReturnValue(false);

      createWorktree('task_001', 'prd/prd_abc', '/project');

      expect(mockFs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('worktrees'), {
        recursive: true,
      });
    });

    it('should run git worktree add --detach', () => {
      mockFs.existsSync.mockReturnValue(false);

      const wt = createWorktree('task_001', 'prd/prd_abc', '/project');

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'add', '--detach']),
        expect.objectContaining({ cwd: '/project' })
      );
      expect(wt.taskId).toBe('task_001');
      expect(wt.baseBranch).toBe('prd/prd_abc');
      expect(wt.path).toContain('task_001');
    });

    it('should symlink node_modules when it exists', () => {
      // First call: worktrees dir doesn't exist
      // After that: node_modules exists, target doesn't
      mockFs.existsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('node_modules')) {
          return !p.includes('worktrees'); // source exists, target doesn't
        }
        return false;
      });

      createWorktree('task_001', 'prd/prd_abc', '/project');

      expect(mockFs.symlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('node_modules'),
        expect.stringContaining('node_modules'),
        'junction'
      );
    });

    it('should clean up stale worktree if path exists', () => {
      let callCount = 0;
      mockFs.existsSync.mockImplementation((p: string) => {
        // worktrees dir: true (exists)
        // worktree path (task_001): true on first check (stale)
        if (typeof p === 'string' && p.includes('task_001') && !p.includes('node_modules')) {
          return callCount++ === 0;
        }
        return false;
      });

      createWorktree('task_001', 'prd/prd_abc', '/project');

      // Should have called git worktree remove for cleanup
      expect(findCalls('remove').length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // mergeWorktreeChanges
  // ==========================================================================

  describe('mergeWorktreeChanges', () => {
    it('should return success when no changes', () => {
      // git status --porcelain returns empty
      mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
        if (args.includes('--porcelain')) return { status: 0, stdout: '', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      });

      const result = mergeWorktreeChanges('/wt', '/project', 'test commit');

      expect(result.success).toBe(true);
    });

    it('should stage, commit, and cherry-pick changes', () => {
      mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
        if (args.includes('--porcelain')) return { status: 0, stdout: 'M src/foo.ts', stderr: '' };
        if (args.includes('rev-parse')) return { status: 0, stdout: 'abc123', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      });

      const result = mergeWorktreeChanges('/wt', '/project', 'test commit');

      expect(result.success).toBe(true);
      expect(result.commitSha).toBe('abc123');

      // Verify the sequence: add → status → commit → rev-parse → cherry-pick
      const calls = mockSpawnSync.mock.calls.map((c: any[]) => (c[1] as string[]).join(' '));
      expect(calls.some((c) => c.includes('add -A'))).toBe(true);
      expect(calls.some((c) => c.includes('commit'))).toBe(true);
      expect(calls.some((c) => c.includes('cherry-pick abc123'))).toBe(true);
    });

    it('should abort cherry-pick on conflict', () => {
      let cherryPickCalled = false;
      mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
        if (args.includes('--porcelain')) return { status: 0, stdout: 'M src/foo.ts', stderr: '' };
        if (args.includes('rev-parse')) return { status: 0, stdout: 'abc123', stderr: '' };
        if (args.includes('cherry-pick') && args.includes('abc123')) {
          cherryPickCalled = true;
          return { status: 1, stdout: '', stderr: 'conflict' };
        }
        if (args.includes('--diff-filter=U'))
          return { status: 0, stdout: 'src/foo.ts', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      });

      const result = mergeWorktreeChanges('/wt', '/project', 'test commit');

      expect(cherryPickCalled).toBe(true);
      expect(result.success).toBe(false);
    });

    it('should pass commit message directly (no shell escaping needed)', () => {
      mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
        if (args.includes('--porcelain')) return { status: 0, stdout: 'M src/foo.ts', stderr: '' };
        if (args.includes('rev-parse')) return { status: 0, stdout: 'abc123', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      });

      mergeWorktreeChanges('/wt', '/project', 'fix "bug" in parser');

      const commitCall = mockSpawnSync.mock.calls.find(
        (c: any[]) => c[0] === 'git' && (c[1] as string[]).includes('commit')
      );
      expect(commitCall).toBeDefined();
      // With cross-spawn, the message is passed directly — no escaping needed
      expect(commitCall![1]).toContain('fix "bug" in parser');
    });
  });

  // ==========================================================================
  // removeWorktree
  // ==========================================================================

  describe('removeWorktree', () => {
    it('should run git worktree remove --force', () => {
      removeWorktree('task_001', '/project');

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'remove', '--force']),
        expect.objectContaining({ cwd: '/project' })
      );
    });

    it('should fallback to manual cleanup on error', () => {
      mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
        if (args.includes('remove')) return { status: 1, stdout: '', stderr: 'locked' };
        return { status: 0, stdout: '', stderr: '' };
      });
      mockFs.existsSync.mockReturnValue(true);

      removeWorktree('task_001', '/project');

      expect(mockFs.rmSync).toHaveBeenCalled();
      expect(mockSpawnSync).toHaveBeenCalledWith('git', ['worktree', 'prune'], expect.anything());
    });
  });

  // ==========================================================================
  // cleanupAllWorktrees
  // ==========================================================================

  describe('cleanupAllWorktrees', () => {
    it('should be no-op when directory missing', () => {
      mockFs.existsSync.mockReturnValue(false);

      cleanupAllWorktrees('/project');

      expect(mockFs.readdirSync).not.toHaveBeenCalled();
    });

    it('should remove all task_ worktrees', () => {
      mockFs.existsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('worktrees') && !p.includes('task_')) return true;
        return false;
      });
      mockFs.readdirSync.mockReturnValue(['task_001', 'task_002', '.gitkeep']);

      cleanupAllWorktrees('/project');

      // Should have called remove for task_001 and task_002, but not .gitkeep
      const removeCalls = findCalls('remove');
      expect(removeCalls.length).toBe(2);
    });

    it('should run git worktree prune at the end', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([]);

      cleanupAllWorktrees('/project');

      expect(mockSpawnSync).toHaveBeenCalledWith('git', ['worktree', 'prune'], expect.anything());
    });
  });
});
