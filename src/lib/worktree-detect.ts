/**
 * Git Worktree Detection & succ Directory Resolution
 *
 * When Claude Code (or any editor) runs inside a git worktree,
 * the .succ/ directory doesn't exist there — it lives in the main repo.
 *
 * This module detects worktree context and resolves the main repo's .succ/,
 * optionally creating a junction/symlink so hooks and subprocesses also find it.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { logWarn } from './fault-logger.js';

/**
 * Check if a directory is inside a git worktree (not the main repo).
 * In a worktree, `.git` is a file containing `gitdir: ...`, not a directory.
 */
export function isGitWorktree(dir: string): boolean {
  const gitPath = path.join(dir, '.git');
  try {
    const stat = fs.statSync(gitPath);
    return stat.isFile(); // file = worktree, directory = main repo
  } catch {
    return false;
  }
}

/**
 * Resolve the main repository root from a git worktree directory.
 *
 * Uses `git rev-parse --git-common-dir` which returns the shared .git dir,
 * then goes up one level to get the main repo root.
 *
 * Returns null if not in a worktree or resolution fails.
 */
export function resolveMainRepoRoot(worktreeDir: string): string | null {
  if (!isGitWorktree(worktreeDir)) return null;

  try {
    // --git-common-dir returns the shared .git directory (e.g. /main-repo/.git)
    const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: worktreeDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();

    // Resolve to absolute path (may be relative)
    const absoluteGitDir = path.resolve(worktreeDir, gitCommonDir);
    // Main repo root is the parent of .git/
    const mainRoot = path.dirname(absoluteGitDir);

    // Sanity check: main root should have .git as a directory
    const mainGitPath = path.join(mainRoot, '.git');
    if (fs.existsSync(mainGitPath) && fs.statSync(mainGitPath).isDirectory()) {
      return mainRoot;
    }

    return mainRoot; // Trust git even if .git check is weird
  } catch {
    // Fallback: parse the .git file directly
    return parseGitFileForMainRepo(worktreeDir);
  }
}

/**
 * Fallback: parse the `.git` file to find the main repo.
 * File contains: `gitdir: /path/to/main/.git/worktrees/<name>`
 * Main repo = go up 3 levels from the gitdir path.
 */
function parseGitFileForMainRepo(worktreeDir: string): string | null {
  try {
    const gitFilePath = path.join(worktreeDir, '.git');
    const content = fs.readFileSync(gitFilePath, 'utf-8').trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) return null;

    const gitDir = path.resolve(worktreeDir, match[1].trim());
    // gitDir = /main-repo/.git/worktrees/<name>
    // main repo = gitDir/../../.. = /main-repo
    const mainRoot = path.resolve(gitDir, '..', '..', '..');

    if (fs.existsSync(path.join(mainRoot, '.git'))) {
      return mainRoot;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ensure .succ/ is accessible in a worktree directory.
 *
 * If the current directory is a worktree and .succ/ doesn't exist,
 * creates a junction (Windows) or symlink (Unix) pointing to the main repo's .succ/.
 *
 * Returns the resolved .succ/ path (either local or via junction), or null if unavailable.
 */
export function ensureSuccInWorktree(worktreeDir: string): string | null {
  const localSucc = path.join(worktreeDir, '.succ');

  // Already exists (main repo or previously created junction)
  if (fs.existsSync(localSucc)) return localSucc;

  const mainRepo = resolveMainRepoRoot(worktreeDir);
  if (!mainRepo) return null;

  const mainSucc = path.join(mainRepo, '.succ');
  if (!fs.existsSync(mainSucc)) return null;

  // Create junction/symlink: <worktree>/.succ → <main-repo>/.succ
  try {
    fs.symlinkSync(mainSucc, localSucc, 'junction');
    return localSucc;
  } catch (error) {
    logWarn('worktree', 'Failed to create .succ junction in worktree', {
      worktree: worktreeDir,
      mainRepo,
      error: error instanceof Error ? error.message : String(error),
    });
    // Return main repo's .succ as direct path (no junction, but still usable by runtime)
    return mainSucc;
  }
}

/**
 * Resolve the .succ/ directory, with worktree awareness.
 *
 * Resolution order:
 * 1. <projectRoot>/.succ/ exists → return it
 * 2. In a worktree → create junction → return <worktree>/.succ/
 * 3. In a worktree, junction failed → return <mainRepo>/.succ/ directly
 * 4. Not a worktree → return <projectRoot>/.succ/ (may not exist)
 */
export function resolveSuccDir(projectRoot: string): string {
  const localSucc = path.join(projectRoot, '.succ');

  if (fs.existsSync(localSucc)) return localSucc;

  // Try worktree resolution with lazy junction
  const resolved = ensureSuccInWorktree(projectRoot);
  return resolved ?? localSucc;
}
