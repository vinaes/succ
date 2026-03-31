#!/usr/bin/env node
/**
 * WorktreeRemove Hook - Unlink junctions before Claude Code cleans up a worktree.
 *
 * When Claude Code removes a worktree, it may run fs.rmSync({recursive:true}) which
 * follows symlinks/junctions and destroys the linked target. This hook unlinks
 * .succ/hooks, .succ/.tmp, .succ (legacy full-dir link), and node_modules junctions
 * before that cleanup happens, protecting the main repo's .succ/ data.
 *
 * Always exits 0 — never block worktree removal.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Read stdin JSON and extract worktree_path.
 * Claude Code passes WorktreeRemove events as JSON on stdin.
 */
async function readStdinJson() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        // JSON.parse('null') → null, JSON.parse('"str"') → string — guard against non-objects
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (_e) {
        // Invalid JSON from stdin — treat as empty input
        resolve({});
      }
    });
    process.stdin.on('error', (_e) => resolve({}));
    // Timeout: don't hang if stdin never closes
    setTimeout(() => resolve({}), 3000);
  });
}

/**
 * Unlink symlinks/junctions without touching their targets.
 * fs.lstatSync().isSymbolicLink() returns true for both POSIX symlinks and
 * NTFS junctions created via fs.symlinkSync(target, path, 'junction').
 */
function unlinkJunctions(dirPath) {
  if (!dirPath) return;

  const candidates = [
    path.join(dirPath, '.succ', 'hooks'), // hooks link (new layout)
    path.join(dirPath, '.succ', '.tmp'), // .tmp link (daemon port/pid)
    path.join(dirPath, '.succ'), // legacy full-dir link (old worktrees)
    path.join(dirPath, 'node_modules'), // node_modules link
  ];

  for (const candidate of candidates) {
    try {
      if (fs.lstatSync(candidate).isSymbolicLink()) {
        fs.unlinkSync(candidate);
      }
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        console.error(`[succ:worktree-remove] Failed to unlink ${candidate}:`, e.message || e);
      }
    }
  }
}

(async () => {
  try {
    const hookInput = await readStdinJson();
    const worktreePath =
      typeof hookInput.worktree_path === 'string'
        ? hookInput.worktree_path
        : typeof hookInput.path === 'string'
          ? hookInput.path
          : null;
    unlinkJunctions(worktreePath);
  } catch (e) {
    console.error('[succ:worktree-remove] Unexpected error:', e && (e.message || e));
  }
  process.exit(0);
})();
