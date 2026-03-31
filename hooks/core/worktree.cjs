#!/usr/bin/env node
/**
 * Shared Worktree Detection — resolve .succ/ in git worktrees.
 *
 * When Claude Code runs inside a git worktree, .succ/ doesn't exist locally.
 * This module detects worktree context and creates a junction to the main repo's .succ/.
 *
 * CommonJS module, no npm dependencies, only Node.js built-ins.
 *
 * Usage:
 *   const { resolveSuccDir } = require('./core/worktree.cjs');
 *   const succDir = resolveSuccDir(projectDir);
 *   // Returns path to .succ/ (local, junction, or main repo fallback)
 *   // Returns null if .succ/ is not available anywhere
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** Normalize error to string safely — works for non-Error thrown values. */
function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Check if a directory is a git worktree (not the main repo).
 * In a worktree, .git is a file containing "gitdir: ...", not a directory.
 * @param {string} dir
 * @returns {boolean}
 */
function isGitWorktree(dir) {
  try {
    const gitPath = path.join(dir, '.git');
    const stat = fs.statSync(gitPath);
    return stat.isFile();
  } catch (e) {
    console.error(`[succ:worktree] isGitWorktree statSync failed: ${errMsg(e)}`);
    return false;
  }
}

/**
 * Resolve main repository root from a git worktree.
 * @param {string} worktreeDir
 * @returns {string|null}
 */
function resolveMainRepoRoot(worktreeDir) {
  if (!isGitWorktree(worktreeDir)) return null;

  try {
    const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: worktreeDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();

    let mainRoot = path.dirname(path.resolve(worktreeDir, gitCommonDir));
    // On Windows, git may return 8.3 short paths — normalize to long paths
    try {
      mainRoot = fs.realpathSync.native(mainRoot);
    } catch (e) {
      console.error(`[succ:worktree] realpathSync.native failed for mainRoot: ${errMsg(e)}`);
    }
    return mainRoot;
  } catch (gitErr) {
    console.error(
      `[succ:worktree] git rev-parse failed, falling back to .git parse: ${errMsg(gitErr)}`
    );
    // Fallback: parse .git file
    try {
      const content = fs.readFileSync(path.join(worktreeDir, '.git'), 'utf-8').trim();
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (match) {
        const gitDir = path.resolve(worktreeDir, match[1].trim());
        // gitDir = /main-repo/.git/worktrees/<name> → go up 3 levels
        let fallbackRoot = path.resolve(gitDir, '..', '..', '..');
        // Normalize 8.3 short names on Windows (same as happy-path above)
        try {
          fallbackRoot = fs.realpathSync.native(fallbackRoot);
        } catch (realpathErr) {
          console.error(
            `[succ:worktree] realpathSync.native failed for fallbackRoot: ${errMsg(realpathErr)}`
          );
        }
        return fallbackRoot;
      }
    } catch (parseErr) {
      console.error(`[succ:worktree] .git file parse failed: ${errMsg(parseErr)}`);
    }
    return null;
  }
}

/**
 * Check if a path is a symlink or NTFS junction.
 * fs.lstatSync().isSymbolicLink() returns true for both POSIX symlinks and
 * NTFS junctions created via fs.symlinkSync(target, path, 'junction').
 * @param {string} p
 * @returns {boolean}
 */
function isSymlinkOrJunction(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch (_e) {
    // Path doesn't exist or can't be stat'd — not a symlink/junction
    return false;
  }
}

/**
 * Resolve .succ/ directory with worktree awareness.
 *
 * If .succ/ exists locally as a real dir (not a link), returns it.
 * If in a worktree, creates a real .succ/ dir with targeted sub-junctions
 * (hooks/ and .tmp/ only) and copies config.json.
 * Legacy full-dir junction is migrated to the new layout.
 * If junction fails, returns main repo's .succ/ directly.
 * If not in a worktree and .succ/ doesn't exist, returns null.
 *
 * @param {string} projectDir
 * @returns {string|null}
 */
function resolveSuccDir(projectDir) {
  const localSucc = path.join(projectDir, '.succ');

  // If localSucc exists as a real dir (not a link), use it
  if (fs.existsSync(localSucc) && !isSymlinkOrJunction(localSucc)) return localSucc;

  const mainRepo = resolveMainRepoRoot(projectDir);
  if (!mainRepo) return null;

  const mainSucc = path.join(mainRepo, '.succ');
  if (!fs.existsSync(mainSucc)) return null;

  // Legacy migration: old full-dir junction → remove it
  if (isSymlinkOrJunction(localSucc)) {
    try {
      fs.unlinkSync(localSucc);
    } catch (e) {
      console.error('[succ:worktree] Failed to remove legacy junction:', e.message || e);
      return mainSucc;
    }
  }

  // Create real .succ dir with targeted sub-junctions
  try {
    fs.mkdirSync(localSucc, { recursive: true });

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
  } catch (e) {
    console.error('[succ:worktree] Failed to create worktree .succ:', e.message || e);
    return mainSucc;
  }

  return localSucc;
}

module.exports = { isGitWorktree, resolveMainRepoRoot, resolveSuccDir, isSymlinkOrJunction };
