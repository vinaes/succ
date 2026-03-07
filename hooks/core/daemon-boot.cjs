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

/**
 * Read daemon port from .succ/.tmp/daemon.port.
 * @param {string} succDir - Path to .succ directory
 * @returns {number|null}
 */
function getDaemonPort(succDir) {
  try {
    const portFile = path.join(succDir, '.tmp', 'daemon.port');
    if (fs.existsSync(portFile)) {
      return parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
    }
  } catch {
    // intentionally empty — port file read failed
  }
  return null;
}

/**
 * Health-check the daemon (2s timeout).
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function checkDaemon(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const data = await response.json();
    return data?.status === 'ok';
  } catch {
    // intentionally empty — daemon not reachable
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
  const servicePath = path.join(projectDir, 'dist', 'daemon', 'service.js');
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
      if (logFn) logFn(`[daemon] Crashed with exit code ${code}: ${stderrBuf.trim().split('\n')[0] || 'no stderr'}`);
    }
  });
  daemon.unref();
  daemon.stderr.unref();
  return true;
}

/**
 * Ensure the daemon is running. Start it if not, poll up to 3s.
 *
 * @param {string} projectDir - Project root directory
 * @param {function} [logFn] - Optional log function(msg)
 * @returns {Promise<{port: number|null}>} Daemon port or null if unavailable
 */
async function ensureDaemon(projectDir, logFn) {
  const succDir = path.join(projectDir, '.succ');

  let port = getDaemonPort(succDir);
  if (port && await checkDaemon(port)) {
    return { port };
  }

  if (logFn) logFn('[daemon] Not running, attempting start...');
  const started = startDaemon(projectDir, logFn);
  if (!started) return { port: null };

  // Poll for daemon to become ready (max 3 seconds = 30 × 100ms)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 100));
    port = getDaemonPort(succDir);
    if (port && await checkDaemon(port)) {
      if (logFn) logFn(`[daemon] Started on port ${port}`);
      return { port };
    }
  }

  if (logFn) logFn('[daemon] Failed to start within 3s — continuing without daemon');
  return { port: null };
}

module.exports = { ensureDaemon, getDaemonPort, checkDaemon, startDaemon };
