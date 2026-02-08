/**
 * Git Worktree Manager
 *
 * Manages isolated working directories for parallel task execution.
 * Each task gets its own worktree checked out from the PRD branch,
 * preventing concurrent Claude processes from interfering with each other.
 *
 * Note: Uses execSync for git commands (same pattern as runner.ts).
 * All inputs are internally generated (task IDs, branch names) — not user-supplied.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getSuccDir } from '../config.js';

// ============================================================================
// Types
// ============================================================================

export interface WorktreeInfo {
  taskId: string;
  path: string;         // absolute path to worktree directory
  baseBranch: string;   // the prd/{id} branch it was created from
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
  projectRoot: string,
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
  execSync(
    `git worktree add --detach "${worktreePath}" ${prdBranch}`,
    { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] },
  );

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
      } catch {
        // Symlink failed (e.g. permissions) — gates may fail but execution continues
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
  commitMessage: string,
): MergeResult {
  try {
    // Stage all changes in worktree
    execSync('git add -A', {
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Check if there's anything to commit
    const status = execSync('git status --porcelain', {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!status) {
      return { success: true }; // No changes to merge
    }

    // Create a temporary commit in the worktree
    const safeMsg = commitMessage.replace(/"/g, '\\"');
    execSync(`git commit -m "${safeMsg}"`, {
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Get the commit SHA
    const sha = execSync('git rev-parse HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // Cherry-pick onto the main PRD branch
    try {
      execSync(`git cherry-pick ${sha}`, {
        cwd: projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { success: true, commitSha: sha };
    } catch {
      // Cherry-pick conflict — abort and report
      try {
        execSync('git cherry-pick --abort', {
          cwd: projectRoot,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch { /* best effort */ }

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
 */
export function removeWorktree(
  taskId: string,
  projectRoot: string,
): void {
  const worktreePath = path.join(getWorktreesDir(), taskId);

  try {
    execSync(`git worktree remove --force "${worktreePath}"`, {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // Fallback: manual cleanup
    try {
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
      execSync('git worktree prune', {
        cwd: projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { /* best effort */ }
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
  } catch { /* best effort */ }

  // Final prune to clean git's worktree registry
  try {
    execSync('git worktree prune', {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch { /* best effort */ }
}

// ============================================================================
// Helpers
// ============================================================================

function getConflictingFiles(projectRoot: string): string[] {
  try {
    const output = execSync('git diff --name-only --diff-filter=U', {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return output ? output.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}
