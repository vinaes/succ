/**
 * Git Worktree Manager
 *
 * Manages isolated working directories for parallel task execution.
 * Each task gets its own worktree checked out from the PRD branch,
 * preventing concurrent Claude processes from interfering with each other.
 *
 * Git commands use cross-spawn with array args to prevent shell injection.
 */

import spawn from 'cross-spawn';
// cross-spawn exposes .sync at runtime but the type declarations don't include it
const spawnSync = (spawn as any).sync as (
  cmd: string,
  args: string[],
  opts: Record<string, unknown>
) => { status: number | null; stdout: string | null; stderr: string; error?: Error };
import fs from 'fs';
import path from 'path';
import { getSuccDir } from '../config.js';
import { logWarn } from '../fault-logger.js';

// ============================================================================
// Git helper
// ============================================================================

function gitSync(args: string[], cwd: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr || result.error?.message}`);
  }
  return (result.stdout ?? '').trim();
}

// ============================================================================
// Types
// ============================================================================

export interface WorktreeInfo {
  taskId: string;
  path: string; // absolute path to worktree directory
  baseBranch: string; // the prd/{id} branch it was created from
}

export interface MergeResult {
  success: boolean;
  commitSha?: string;
  conflictFiles?: string[];
}

// ============================================================================
// Directory helpers
// ============================================================================

/**
 * Get the base directory for all worktrees: .succ/worktrees/
 */
export function getWorktreesDir(): string {
  return path.join(getSuccDir(), 'worktrees');
}

// ============================================================================
// Create
// ============================================================================

/**
 * Create an isolated worktree for a task.
 *
 * Uses `git worktree add --detach` so no new branch is created.
 * The worktree starts at the same commit as the PRD branch HEAD.
 * After creation, symlinks node_modules into the worktree (junction on Windows)
 * so quality gates that require dependencies (tsc, vitest, etc.) work.
 */
export function createWorktree(
  taskId: string,
  prdBranch: string,
  projectRoot: string
): WorktreeInfo {
  const wtDir = getWorktreesDir();
  if (!fs.existsSync(wtDir)) {
    fs.mkdirSync(wtDir, { recursive: true });
  }

  const worktreePath = path.join(wtDir, taskId);

  // Clean up stale worktree if it exists
  if (fs.existsSync(worktreePath)) {
    removeWorktree(taskId, projectRoot);
  }

  // Create detached worktree at the current HEAD of the PRD branch
  gitSync(['worktree', 'add', '--detach', worktreePath, prdBranch], projectRoot);

  // Symlink node_modules so tools like tsc/vitest work in the worktree
  symlinkDependencies(projectRoot, worktreePath);

  return {
    taskId,
    path: worktreePath,
    baseBranch: prdBranch,
  };
}

/**
 * Symlink node_modules (and similar dependency dirs) into the worktree.
 * Uses 'junction' on Windows (works without admin privileges).
 */
function symlinkDependencies(projectRoot: string, worktreePath: string): void {
  const dirs = ['node_modules'];
  for (const dir of dirs) {
    const source = path.join(projectRoot, dir);
    const target = path.join(worktreePath, dir);
    if (fs.existsSync(source) && !fs.existsSync(target)) {
      try {
        fs.symlinkSync(source, target, 'junction');
      } catch (err) {
        logWarn('prd', 'Failed to create node_modules symlink, quality gates may fail', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

// ============================================================================
// Merge
// ============================================================================

/**
 * Merge worktree changes back to the PRD branch.
 *
 * Strategy:
 * 1. In the worktree: stage and commit all changes
 * 2. In the main repo: cherry-pick that commit onto the PRD branch
 *
 * On conflict: abort cherry-pick, report conflicting files.
 */
export function mergeWorktreeChanges(
  worktreePath: string,
  projectRoot: string,
  commitMessage: string
): MergeResult {
  try {
    // Stage all changes in worktree
    gitSync(['add', '-A'], worktreePath);

    // Check if there's anything to commit
    const status = gitSync(['status', '--porcelain'], worktreePath);

    if (!status) {
      return { success: true }; // No changes to merge
    }

    // Create a temporary commit in the worktree
    gitSync(['commit', '-m', commitMessage], worktreePath);

    // Get the commit SHA
    const sha = gitSync(['rev-parse', 'HEAD'], worktreePath);

    // Cherry-pick onto the main PRD branch
    try {
      gitSync(['cherry-pick', sha], projectRoot);
      return { success: true, commitSha: sha };
    } catch (error) {
      logWarn('worktree', 'Git cherry-pick failed with conflict or error', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Cherry-pick conflict — abort and report
      try {
        gitSync(['cherry-pick', '--abort'], projectRoot);
      } catch (abortError) {
        logWarn('worktree', 'Failed to abort git cherry-pick after conflict', {
          error: abortError instanceof Error ? abortError.message : String(abortError),
        });
        /* best effort */
      }

      return {
        success: false,
        conflictFiles: getConflictingFiles(projectRoot),
      };
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, conflictFiles: [msg] };
  }
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Remove a single worktree.
 * Always does git worktree remove + fallback rmSync + prune.
 * Retries rmSync on Windows (EBUSY / EPERM from delayed file deletion).
 */
export function removeWorktree(taskId: string, projectRoot: string): void {
  const worktreePath = path.join(getWorktreesDir(), taskId);

  // 1. Try git worktree remove
  try {
    gitSync(['worktree', 'remove', '--force', worktreePath], projectRoot);
  } catch (error) {
    logWarn('worktree', 'Failed to remove git worktree via git command', {
      error: error instanceof Error ? error.message : String(error),
    });
    /* fallback below */
  }

  // 2. If directory still exists, force remove with retry for Windows EBUSY
  if (fs.existsSync(worktreePath)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
        break;
      } catch (error) {
        logWarn('worktree', 'Failed to force-remove worktree directory, retrying', {
          error: error instanceof Error ? error.message : String(error),
        });
        if (attempt < 2) {
          // Brief sync delay for Windows file handle release (EBUSY)
          const start = Date.now();
          while (Date.now() - start < 500) {
            /* spin wait ~500ms */
          }
        }
      }
    }
  }

  // 3. Always prune git's worktree registry
  try {
    gitSync(['worktree', 'prune'], projectRoot);
  } catch (error) {
    logWarn('worktree', 'Failed to run git worktree prune after removal', {
      error: error instanceof Error ? error.message : String(error),
    });
    /* best effort */
  }
}

/**
 * Clean up all task worktrees. Called during resume or after completion.
 */
export function cleanupAllWorktrees(projectRoot: string): void {
  const wtDir = getWorktreesDir();
  if (!fs.existsSync(wtDir)) return;

  try {
    const entries = fs.readdirSync(wtDir);
    for (const entry of entries) {
      if (entry.startsWith('task_')) {
        removeWorktree(entry, projectRoot);
      }
    }
  } catch (error) {
    logWarn('worktree', 'Failed to read worktrees directory for cleanup', {
      error: error instanceof Error ? error.message : String(error),
    });
    /* best effort */
  }

  // Final prune to clean git's worktree registry
  try {
    gitSync(['worktree', 'prune'], projectRoot);
  } catch (error) {
    logWarn('worktree', 'Failed to run git worktree prune after cleanup', {
      error: error instanceof Error ? error.message : String(error),
    });
    /* best effort */
  }
}

// ============================================================================
// Helpers
// ============================================================================

function getConflictingFiles(projectRoot: string): string[] {
  try {
    const output = gitSync(['diff', '--name-only', '--diff-filter=U'], projectRoot);
    return output ? output.split('\n').filter(Boolean) : [];
  } catch (error) {
    logWarn('worktree', 'Failed to get conflicting files via git diff', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
