#!/usr/bin/env node
/**
 * Shared Daemon Boot — start/check the succ daemon from any hook.
 *
 * Extracted from succ-session-start.cjs for reuse across hooks and agents.
 * CommonJS module, no npm dependencies, only Node.js built-ins.
 *
 * Usage:
 *   const { ensureDaemon } = require('./core/daemon-boot.cjs');
 *   const { port } = await ensureDaemon(projectDir, logFn);
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveMainRepoRoot } = require('./worktree.cjs');

/** Normalize error to string safely — works for non-Error thrown values. */
function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read daemon port from .succ/.tmp/daemon.port.
 * @param {string} succDir - Path to .succ directory
 * @returns {number|null}
 */
function getDaemonPort(succDir, { quiet = false } = {}) {
  try {
    const portFile = path.join(succDir, '.tmp', 'daemon.port');
    if (fs.existsSync(portFile)) {
      return parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
    }
  } catch (e) {
    if (!quiet) {
      console.error(`[succ:daemon] Port file read failed: ${errMsg(e)}`);
    }
  }
  return null;
}

/**
 * Health-check the daemon (2s timeout).
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function checkDaemon(port, { quiet = false } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const data = await response.json();
    return data?.status === 'ok';
  } catch (e) {
    if (!quiet) {
      console.error(`[succ:daemon] Health check failed: ${errMsg(e)}`);
    }
    return false;
  }
}

/**
 * Spawn daemon process detached.
 * @param {string} projectDir - Project root (contains dist/daemon/service.js)
 * @param {function} [logFn] - Optional log function(msg)
 * @returns {boolean} Whether spawn was attempted
 */
function startDaemon(projectDir, logFn) {
  let servicePath = path.join(projectDir, 'dist', 'daemon', 'service.js');
  // Worktree fallback: dist/ lives in the main repo
  if (!fs.existsSync(servicePath)) {
    const mainRepo = resolveMainRepoRoot(projectDir);
    if (mainRepo) {
      servicePath = path.join(mainRepo, 'dist', 'daemon', 'service.js');
    }
  }
  // Package fallback: find service.js via .succ/.package-root (written by succ init)
  // or via __dirname when hooks run directly from the installed package
  if (!fs.existsSync(servicePath)) {
    // Try .package-root breadcrumb (works for copied hooks in .succ/hooks/)
    const succDir = path.join(projectDir, '.succ');
    const pkgRootFile = path.join(succDir, '.package-root');
    if (fs.existsSync(pkgRootFile)) {
      try {
        const pkgRoot = fs.readFileSync(pkgRootFile, 'utf8').trim();
        const candidate = path.join(pkgRoot, 'dist', 'daemon', 'service.js');
        if (fs.existsSync(candidate)) {
          servicePath = candidate;
        }
      } catch (e) {
        console.error(`[succ:daemon] .package-root read failed: ${errMsg(e)}`);
      }
    }
    // Fallback: __dirname (works when hooks run directly from npm package)
    if (!fs.existsSync(servicePath)) {
      const candidate = path.resolve(__dirname, '..', '..', 'dist', 'daemon', 'service.js');
      if (fs.existsSync(candidate)) {
        servicePath = candidate;
      }
    }
  }
  if (!fs.existsSync(servicePath)) {
    if (logFn) logFn('[daemon] service.js not found: ' + servicePath);
    return false;
  }
  const daemon = spawn(process.execPath, ['--no-warnings', '--no-deprecation', servicePath], {
    cwd: projectDir,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  // Capture stderr for crash diagnostics
  let stderrBuf = '';
  daemon.stderr.on('data', (chunk) => {
    if (stderrBuf.length < 2000) {
      stderrBuf += chunk.toString().slice(0, 500);
    }
  });
  daemon.on('exit', (code) => {
    if (code && code !== 0) {
      if (logFn)
        logFn(
          `[daemon] Crashed with exit code ${code}: ${stderrBuf.trim().split('\n')[0] || 'no stderr'}`
        );
    }
  });
  daemon.unref();
  daemon.stderr.unref();
  return true;
}

/**
 * Atomic spawn lock — prevents concurrent daemon spawns.
 * Uses {flag:'wx'} for exclusive file creation (atomic on all OSes).
 *
 * @param {string} tmpDir - Path to .succ/.tmp
 * @param {function} [logFn] - Optional log function
 * @returns {boolean} true if lock acquired, false if another spawn in progress
 */
function acquireSpawnLock(tmpDir, logFn) {
  const lockFile = path.join(tmpDir, 'daemon.starting');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  try {
    fs.writeFileSync(lockFile, String(Date.now()), { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      try {
        const lockTime = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
        if (lockTime && Date.now() - lockTime < 10000) {
          if (logFn) logFn('[daemon] Another spawn in progress (lock <10s), waiting...');
          return false;
        }
        // Stale lock (>10s) — remove and retry once
        fs.unlinkSync(lockFile);
        fs.writeFileSync(lockFile, String(Date.now()), { encoding: 'utf8', flag: 'wx' });
        return true;
      } catch (retryErr) {
        if (logFn) logFn(`[daemon] Lock race lost or read error: ${errMsg(retryErr)}`);
        return false;
      }
    }
    if (logFn) logFn(`[daemon] Lock write failed: ${errMsg(e)}`);
    return false;
  }
}

/** Release spawn lock (best-effort). */
function releaseSpawnLock(tmpDir, logFn) {
  try {
    fs.unlinkSync(path.join(tmpDir, 'daemon.starting'));
  } catch (e) {
    if (logFn) logFn(`[daemon] Lock cleanup skipped: ${errMsg(e)}`);
  }
}

/**
 * Ensure the daemon is running. Start it if not, poll up to 3s.
 * Uses acquireSpawnLock() to prevent concurrent spawns.
 *
 * @param {string} projectDir - Project root directory
 * @param {function} [logFn] - Optional log function(msg)
 * @returns {Promise<{port: number|null}>} Daemon port or null if unavailable
 */
async function ensureDaemon(projectDir, logFn) {
  let succDir = path.join(projectDir, '.succ');
  // Worktree fallback: .succ/ may be a junction or in the main repo
  if (!fs.existsSync(succDir)) {
    const { resolveSuccDir } = require('./worktree.cjs');
    const resolved = resolveSuccDir(projectDir);
    if (resolved) succDir = resolved;
  }

  const tmpDir = path.join(succDir, '.tmp');

  let port = getDaemonPort(succDir, { quiet: true });
  if (port && (await checkDaemon(port, { quiet: true }))) {
    releaseSpawnLock(tmpDir, logFn);
    return { port };
  }

  // Acquire atomic lock before spawning
  if (!acquireSpawnLock(tmpDir, logFn)) {
    // Another spawn in progress — poll for it
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      port = getDaemonPort(succDir, { quiet: true });
      if (port && (await checkDaemon(port, { quiet: true }))) return { port };
    }
    // First spawn may have crashed — retry lock once
    if (acquireSpawnLock(tmpDir, logFn)) {
      if (logFn) logFn('[daemon] Retry after failed first spawn...');
      const retried = startDaemon(projectDir, logFn);
      if (retried) {
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 100));
          port = getDaemonPort(succDir, { quiet: true });
          if (port && (await checkDaemon(port, { quiet: true }))) {
            if (logFn) logFn(`[daemon] Started on port ${port} (retry)`);
            releaseSpawnLock(tmpDir, logFn);
            return { port };
          }
        }
      }
      releaseSpawnLock(tmpDir, logFn);
    }
    return { port: null };
  }

  if (logFn) logFn('[daemon] Not running, attempting start...');
  const started = startDaemon(projectDir, logFn);
  if (!started) {
    releaseSpawnLock(tmpDir, logFn);
    return { port: null };
  }

  // Poll for daemon to become ready (max 3 seconds = 30 × 100ms)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    port = getDaemonPort(succDir, { quiet: true });
    if (port && (await checkDaemon(port, { quiet: true }))) {
      if (logFn) logFn(`[daemon] Started on port ${port}`);
      releaseSpawnLock(tmpDir, logFn);
      return { port };
    }
  }

  if (logFn) logFn('[daemon] Failed to start within 3s — continuing without daemon');
  releaseSpawnLock(tmpDir, logFn);
  return { port: null };
}

/**
 * Lazy daemon startup — fast, non-blocking path for per-tool hooks.
 *
 * Unlike ensureDaemon(), this never blocks waiting for the daemon.
 * - If daemon.port exists: return port immediately (no health check)
 * - If daemon is starting (PID alive or recent lock): return null
 * - If daemon is dead: spawn in background, return null
 *
 * @param {string} projectDir - Project root directory
 * @param {string} succDir - Path to .succ directory
 * @param {function} [logFn] - Optional log function(msg)
 * @returns {number|null} Daemon port or null if not yet available
 */
function ensureDaemonLazy(projectDir, succDir, logFn) {
  // Fast path: port file exists → return immediately
  const port = getDaemonPort(succDir, { quiet: true });
  if (port) return port;

  // Check PID file — daemon may be starting (PID written before port)
  const tmpDir = path.join(succDir, '.tmp');
  const pidFile = path.join(tmpDir, 'daemon.pid');
  try {
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (pid) {
        try {
          process.kill(pid, 0); // Signal 0 = check existence
          return null; // Daemon process alive but port not written yet
        } catch (e) {
          if (logFn)
            logFn(`[daemon-lazy] PID ${pid} not running (${e.code || errMsg(e)}), will restart`);
        }
      }
    }
  } catch (e) {
    if (logFn) logFn(`[daemon-lazy] PID file read failed: ${errMsg(e)}`);
  }

  // Atomic lock — prevent concurrent spawns (shared with ensureDaemon)
  if (!acquireSpawnLock(tmpDir, logFn)) {
    return null;
  }

  if (logFn) logFn('[daemon-lazy] Daemon not running, spawning in background');
  if (!startDaemon(projectDir, logFn)) {
    releaseSpawnLock(tmpDir, logFn);
  }

  return null;
}

module.exports = { ensureDaemon, ensureDaemonLazy, getDaemonPort, checkDaemon, startDaemon };
