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
    let mainRoot = path.dirname(absoluteGitDir);

    // On Windows, git may return 8.3 short paths (e.g. RUNNER~1 instead of RUNNERADMIN).
    // Normalize to long paths so string comparisons work downstream.
    try {
      mainRoot = fs.realpathSync.native(mainRoot);
    } catch {
      // realpathSync.native may fail if path doesn't exist; keep as-is
    }

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
    let mainRoot = path.resolve(gitDir, '..', '..', '..');

    // Normalize 8.3 short names on Windows (same as happy-path above)
    try {
      mainRoot = fs.realpathSync.native(mainRoot);
    } catch {
      // realpathSync.native may fail if path doesn't exist; keep as-is
    }

    if (fs.existsSync(path.join(mainRoot, '.git'))) {
      return mainRoot;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a path is a symlink or NTFS junction.
 * fs.lstatSync().isSymbolicLink() returns true for both POSIX symlinks and
 * NTFS junctions created via fs.symlinkSync(target, path, 'junction').
 */
export function isSymlinkOrJunction(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    // Path doesn't exist or can't be stat'd — not a symlink/junction
    return false;
  }
}

/**
 * Unlink symlinks/junctions in a worktree directory before recursive removal.
 * Safe to call even if directory doesn't exist or contains no junctions.
 */
export function unlinkSuccJunctions(dirPath: string): void {
  const candidates = [
    path.join(dirPath, '.succ', 'hooks'),
    path.join(dirPath, '.succ', '.tmp'),
    path.join(dirPath, '.succ'),
    path.join(dirPath, 'node_modules'),
  ];
  for (const c of candidates) {
    try {
      if (fs.lstatSync(c).isSymbolicLink()) fs.unlinkSync(c);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logWarn('worktree', `Failed to unlink junction ${c}: ${(err as Error).message}`);
      }
    }
  }
}

/**
 * Ensure .succ/ is accessible in a worktree directory.
 *
 * Creates a real .succ/ dir with targeted sub-junctions (hooks/ and .tmp/ only)
 * and copies config.json. Legacy full-dir junctions are migrated to the new layout.
 *
 * Returns the resolved .succ/ path (either local or main repo fallback), or null if unavailable.
 */
export function ensureSuccInWorktree(worktreeDir: string): string | null {
  const localSucc = path.join(worktreeDir, '.succ');

  // Check if localSucc is a real directory (not a link or plain file)
  const localIsRealDir =
    fs.existsSync(localSucc) &&
    !isSymlinkOrJunction(localSucc) &&
    fs.statSync(localSucc).isDirectory();

  const mainRepo = resolveMainRepoRoot(worktreeDir);
  if (!mainRepo) return localIsRealDir ? localSucc : null;

  const mainSucc = path.join(mainRepo, '.succ');
  if (!fs.existsSync(mainSucc)) return localIsRealDir ? localSucc : null;

  // Legacy migration: old full-dir junction → remove it
  if (!localIsRealDir && isSymlinkOrJunction(localSucc)) {
    try {
      fs.unlinkSync(localSucc);
    } catch (error) {
      logWarn('worktree', 'Failed to remove legacy .succ junction in worktree', {
        worktree: worktreeDir,
        error: error instanceof Error ? error.message : String(error),
      });
      return mainSucc;
    }
  }

  // Create/reconcile real .succ dir with targeted sub-junctions.
  // Runs on first creation AND on subsequent calls to backfill junctions
  // that may not have existed on the first pass (e.g. .tmp/ created later).
  try {
    if (!localIsRealDir) {
      fs.mkdirSync(localSucc, { recursive: true });
    }

    // Junction hooks/ only (for command hooks in settings.json)
    const mainHooks = path.join(mainSucc, 'hooks');
    const localHooks = path.join(localSucc, 'hooks');
    if (fs.existsSync(mainHooks) && !fs.existsSync(localHooks)) {
      fs.symlinkSync(mainHooks, localHooks, 'junction');
    }

    // Junction .tmp/ (daemon port/pid files)
    const mainTmp = path.join(mainSucc, '.tmp');
    const localTmp = path.join(localSucc, '.tmp');
    if (fs.existsSync(mainTmp) && !fs.existsSync(localTmp)) {
      fs.symlinkSync(mainTmp, localTmp, 'junction');
    }

    // Copy config.json (one-time, for hook config reading)
    const mainConfig = path.join(mainSucc, 'config.json');
    const localConfig = path.join(localSucc, 'config.json');
    if (fs.existsSync(mainConfig) && !fs.existsSync(localConfig)) {
      fs.copyFileSync(mainConfig, localConfig);
    }
  } catch (error) {
    logWarn('worktree', 'Failed to create worktree .succ structure', {
      worktree: worktreeDir,
      mainRepo,
      error: error instanceof Error ? error.message : String(error),
    });
    return mainSucc;
  }

  return localSucc;
}

/**
 * Resolve the .succ/ directory, with worktree awareness.
 *
 * Resolution order:
 * 1. <projectRoot>/.succ/ exists as a real dir AND not a worktree → return it
 * 2. In a worktree → ensure/reconcile junctions → return <worktree>/.succ/
 * 3. In a worktree, junction failed → return <mainRepo>/.succ/ directly
 * 4. Not a worktree → return <projectRoot>/.succ/ (may not exist)
 */
export function resolveSuccDir(projectRoot: string): string {
  const localSucc = path.join(projectRoot, '.succ');

  // Non-worktree: return local .succ if it exists as a real directory
  if (fs.existsSync(localSucc) && !isSymlinkOrJunction(localSucc) && !isGitWorktree(projectRoot)) {
    return localSucc;
  }

  // Try worktree resolution with lazy junction (also reconciles existing dirs)
  const resolved = ensureSuccInWorktree(projectRoot);
  return resolved ?? localSucc;
}
