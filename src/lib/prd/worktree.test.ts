import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks — these are evaluated before vi.mock factories
const { mockExecSync, mockFs } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockFs: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(),
    rmSync: vi.fn(),
    symlinkSync: vi.fn(),
  },
}));

vi.mock('child_process', () => ({
  execSync: (cmd: string, opts?: unknown) => mockExecSync(cmd, opts),
}));

vi.mock('fs', () => ({ default: mockFs, ...mockFs }));

vi.mock('../config.js', () => ({
  getSuccDir: () => '/project/.succ',
}));

import {
  getWorktreesDir,
  createWorktree,
  mergeWorktreeChanges,
  removeWorktree,
  cleanupAllWorktrees,
} from './worktree.js';

describe('worktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('worktrees'),
        { recursive: true },
      );
    });

    it('should run git worktree add --detach', () => {
      mockFs.existsSync.mockReturnValue(false);

      const wt = createWorktree('task_001', 'prd/prd_abc', '/project');

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git worktree add --detach'),
        expect.objectContaining({ cwd: '/project' }),
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
        'junction',
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
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('worktree remove'),
        expect.anything(),
      );
    });
  });

  // ==========================================================================
  // mergeWorktreeChanges
  // ==========================================================================

  describe('mergeWorktreeChanges', () => {
    it('should return success when no changes', () => {
      // git status --porcelain returns empty
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('status --porcelain')) return '';
        return '';
      });

      const result = mergeWorktreeChanges('/wt', '/project', 'test commit');

      expect(result.success).toBe(true);
    });

    it('should stage, commit, and cherry-pick changes', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('status --porcelain')) return 'M src/foo.ts';
        if (cmd.includes('rev-parse HEAD')) return 'abc123';
        return '';
      });

      const result = mergeWorktreeChanges('/wt', '/project', 'test commit');

      expect(result.success).toBe(true);
      expect(result.commitSha).toBe('abc123');

      // Verify the sequence: add → status → commit → rev-parse → cherry-pick
      const calls = mockExecSync.mock.calls.map(c => c[0] as string);
      expect(calls.some(c => c.includes('git add -A'))).toBe(true);
      expect(calls.some(c => c.includes('git commit'))).toBe(true);
      expect(calls.some(c => c.includes('cherry-pick abc123'))).toBe(true);
    });

    it('should abort cherry-pick on conflict', () => {
      let cherryPickCalled = false;
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('status --porcelain')) return 'M src/foo.ts';
        if (cmd.includes('rev-parse HEAD')) return 'abc123';
        if (cmd.includes('cherry-pick abc123')) {
          cherryPickCalled = true;
          throw new Error('conflict');
        }
        if (cmd.includes('cherry-pick --abort')) return '';
        if (cmd.includes('diff --name-only')) return 'src/foo.ts';
        return '';
      });

      const result = mergeWorktreeChanges('/wt', '/project', 'test commit');

      expect(cherryPickCalled).toBe(true);
      expect(result.success).toBe(false);
    });

    it('should escape quotes in commit message', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('status --porcelain')) return 'M src/foo.ts';
        if (cmd.includes('rev-parse HEAD')) return 'abc123';
        return '';
      });

      mergeWorktreeChanges('/wt', '/project', 'fix "bug" in parser');

      const commitCall = mockExecSync.mock.calls.find(
        c => (c[0] as string).includes('git commit'),
      );
      expect(commitCall).toBeDefined();
      expect(commitCall![0]).toContain('\\"bug\\"');
    });
  });

  // ==========================================================================
  // removeWorktree
  // ==========================================================================

  describe('removeWorktree', () => {
    it('should run git worktree remove --force', () => {
      removeWorktree('task_001', '/project');

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('worktree remove --force'),
        expect.objectContaining({ cwd: '/project' }),
      );
    });

    it('should fallback to manual cleanup on error', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('worktree remove')) throw new Error('locked');
        return '';
      });
      mockFs.existsSync.mockReturnValue(true);

      removeWorktree('task_001', '/project');

      expect(mockFs.rmSync).toHaveBeenCalled();
      expect(mockExecSync).toHaveBeenCalledWith(
        'git worktree prune',
        expect.anything(),
      );
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
      const removeCalls = mockExecSync.mock.calls.filter(
        c => (c[0] as string).includes('worktree remove'),
      );
      expect(removeCalls.length).toBe(2);
    });

    it('should run git worktree prune at the end', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([]);

      cleanupAllWorktrees('/project');

      expect(mockExecSync).toHaveBeenCalledWith(
        'git worktree prune',
        expect.anything(),
      );
    });
  });
});
