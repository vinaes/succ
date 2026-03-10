import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

/** Normalize path for comparison — resolves 8.3 short names on Windows */
function normPath(p: string): string {
  // fs.realpathSync.native resolves 8.3 short names on Windows; .realpathSync does not
  const resolved = fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  return resolved.toLowerCase();
}
import {
  isGitWorktree,
  resolveMainRepoRoot,
  ensureSuccInWorktree,
  resolveSuccDir,
} from './worktree-detect.js';

/**
 * End-to-end worktree detection tests.
 *
 * Creates a real git repo + worktree on disk, verifies:
 * - Main repo is NOT detected as worktree
 * - Worktree IS detected as worktree
 * - Main repo root is resolved from worktree
 * - .succ/ junction is created in worktree
 * - resolveSuccDir returns correct path in all scenarios
 */
describe('worktree-detect (e2e with real git)', () => {
  let tmpDir: string;
  let mainRepo: string;
  let worktreePath: string;

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'succ-wt-test-'));
    mainRepo = path.join(tmpDir, 'main');
    worktreePath = path.join(tmpDir, 'worktree-1');

    // Create a real git repo with an initial commit
    fs.mkdirSync(mainRepo, { recursive: true });
    git(['init'], mainRepo);
    git(['config', 'user.email', 'test@test.com'], mainRepo);
    git(['config', 'user.name', 'Test'], mainRepo);
    fs.writeFileSync(path.join(mainRepo, 'README.md'), '# test');
    git(['add', '.'], mainRepo);
    git(['commit', '-m', 'init'], mainRepo);

    // Create .succ/ in main repo
    const succDir = path.join(mainRepo, '.succ');
    fs.mkdirSync(succDir, { recursive: true });
    fs.writeFileSync(path.join(succDir, 'config.json'), '{}');
    fs.writeFileSync(path.join(succDir, 'succ.db'), 'fake-db');

    // Create a worktree
    git(['worktree', 'add', '--detach', worktreePath], mainRepo);
  });

  afterEach(() => {
    // Remove worktree first (git needs this before deleting dirs)
    try {
      git(['worktree', 'remove', '--force', worktreePath], mainRepo);
    } catch {
      // May already be removed
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── isGitWorktree ──────────────────────────────────────

  it('returns false for main repo (.git is a directory)', () => {
    expect(isGitWorktree(mainRepo)).toBe(false);
  });

  it('returns true for worktree (.git is a file)', () => {
    expect(isGitWorktree(worktreePath)).toBe(true);
  });

  it('returns false for non-git directory', () => {
    expect(isGitWorktree(tmpDir)).toBe(false);
  });

  // ─── resolveMainRepoRoot ────────────────────────────────

  it('returns null for main repo', () => {
    expect(resolveMainRepoRoot(mainRepo)).toBeNull();
  });

  it('resolves main repo root from worktree', () => {
    const result = resolveMainRepoRoot(worktreePath);
    expect(result).not.toBeNull();
    // Normalize paths for comparison (resolve symlinks, case, etc.)
    expect(normPath(result!)).toBe(normPath(mainRepo));
  });

  it('returns null for non-git directory', () => {
    expect(resolveMainRepoRoot(tmpDir)).toBeNull();
  });

  // ─── ensureSuccInWorktree ───────────────────────────────

  it('returns existing .succ/ in main repo without creating junction', () => {
    const result = ensureSuccInWorktree(mainRepo);
    expect(result).toBe(path.join(mainRepo, '.succ'));
    // No junction created — it's the real directory
    expect(fs.lstatSync(result!).isSymbolicLink()).toBe(false);
  });

  it('creates junction in worktree pointing to main .succ/', () => {
    const result = ensureSuccInWorktree(worktreePath);
    expect(result).not.toBeNull();

    // Junction should exist at <worktree>/.succ
    const junctionPath = path.join(worktreePath, '.succ');
    expect(fs.existsSync(junctionPath)).toBe(true);

    // Should be a symlink/junction
    expect(fs.lstatSync(junctionPath).isSymbolicLink()).toBe(true);

    // Contents should match main repo's .succ/
    expect(fs.existsSync(path.join(junctionPath, 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(junctionPath, 'succ.db'))).toBe(true);
  });

  it('returns existing junction on second call (idempotent)', () => {
    // First call creates junction
    const first = ensureSuccInWorktree(worktreePath);
    // Second call finds it already exists
    const second = ensureSuccInWorktree(worktreePath);
    expect(first).toBe(second);
  });

  it('returns null for non-git directory', () => {
    expect(ensureSuccInWorktree(tmpDir)).toBeNull();
  });

  it('returns null for worktree when main repo has no .succ/', () => {
    // Remove .succ/ from main repo
    fs.rmSync(path.join(mainRepo, '.succ'), { recursive: true, force: true });
    expect(ensureSuccInWorktree(worktreePath)).toBeNull();
  });

  // ─── resolveSuccDir ─────────────────────────────────────

  it('returns local .succ/ for main repo', () => {
    expect(resolveSuccDir(mainRepo)).toBe(path.join(mainRepo, '.succ'));
  });

  it('creates junction and returns .succ/ path for worktree', () => {
    const result = resolveSuccDir(worktreePath);
    // Should return the worktree path (junction was created)
    expect(result).toBe(path.join(worktreePath, '.succ'));
    expect(fs.existsSync(result)).toBe(true);
  });

  it('returns fallback path for non-git directory', () => {
    // No .succ/ exists, not a worktree → returns the expected-but-nonexistent path
    const result = resolveSuccDir(tmpDir);
    expect(result).toBe(path.join(tmpDir, '.succ'));
  });

  // ─── CJS module parity ─────────────────────────────────

  it('CJS worktree.cjs resolveSuccDir matches TS implementation', () => {
    // Load the CJS module
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cjs = require('../../hooks/core/worktree.cjs') as {
      isGitWorktree: (dir: string) => boolean;
      resolveMainRepoRoot: (dir: string) => string | null;
      resolveSuccDir: (dir: string) => string | null;
    };

    // Main repo
    expect(cjs.isGitWorktree(mainRepo)).toBe(false);
    expect(cjs.resolveMainRepoRoot(mainRepo)).toBeNull();

    // Worktree — junction may already exist from previous test, clean it
    const junctionPath = path.join(worktreePath, '.succ');
    if (fs.existsSync(junctionPath)) {
      fs.unlinkSync(junctionPath);
    }

    expect(cjs.isGitWorktree(worktreePath)).toBe(true);
    const cjsMainRoot = cjs.resolveMainRepoRoot(worktreePath);
    expect(cjsMainRoot).not.toBeNull();
    expect(normPath(cjsMainRoot!)).toBe(normPath(mainRepo));

    const cjsSucc = cjs.resolveSuccDir(worktreePath);
    expect(cjsSucc).not.toBeNull();
    expect(fs.existsSync(cjsSucc!)).toBe(true);

    // Non-git dir
    expect(cjs.isGitWorktree(tmpDir)).toBe(false);
    expect(cjs.resolveSuccDir(tmpDir)).toBeNull();
  });
});
