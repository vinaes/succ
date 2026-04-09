/**
 * Unified Daemon Service for succ
 *
 * Single HTTP server per project that handles:
 * - Multiple Claude Code sessions (idle tracking, reflection)
 * - Watch service (file monitoring)
 * - Analyze queue (code analysis)
 * - Data operations (search, recall, remember)
 *
 * Benefits:
 * - No CMD windows on Windows (starts once, stays running)
 * - Fast operations via HTTP (~5ms vs ~500ms spawn)
 * - Shared DB connections, embeddings cache
 * - Per-session idle tracking with multi-session support
 */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { createIdleWatcher, createSessionManager } from './sessions.js';
import { logError, logWarn } from '../lib/fault-logger.js';
import { processRegistry } from '../lib/process-registry.js';
import { NotFoundError, NetworkError, ValidationError } from '../lib/errors.js';
import { startWatcher, stopWatcher } from './watcher.js';
import { startAnalyzer, stopAnalyzer } from './analyzer.js';
import {
  getConfig,
  getIdleReflectionConfig,
  getIdleWatcherConfig,
  getProjectRoot,
  getSuccDir,
} from '../lib/config.js';
import { getStablePort } from '../lib/daemon-port.js';
import {
  closeDb,
  closeGlobalDb,
  closeStorageDispatcher,
  initStorageDispatcher,
} from '../lib/storage/index.js';
import { cleanupEmbeddings } from '../lib/embeddings.js';
import { cleanupReranker } from '../lib/reranker.js';
import { cleanupQualityScoring } from '../lib/quality.js';
import { loadBudgets } from '../lib/token-budget.js';
import {
  getErrorMessage,
  type DaemonConfig,
  type DaemonState,
  type RequestBody,
  type RouteContext,
  type RouteMap,
} from './routes/types.js';
import { sessionRoutes } from './routes/sessions.js';
import { searchRoutes, resetSearchRoutesState } from './routes/search.js';
import { memoryRoutes, resetMemoryRoutesState } from './routes/memory.js';
import {
  clearBriefingCache,
  initReflectionMaintenance,
  performReflection,
  preGenerateBriefing,
  reflectionRoutes,
  resetReflectionRoutesState,
} from './routes/reflection.js';
import { statusRoutes } from './routes/status.js';
import { watcherRoutes } from './routes/watcher.js';
import { analyzerRoutes } from './routes/analyzer.js';
import { skillRoutes } from './routes/skills.js';
import { hookRoutes } from './routes/hooks.js';
import { addVersionedRoutes, getApiVersionInfo } from './routes/versioning.js';
import { getClaudeMode } from '../lib/llm.js';
import { ClaudeWSTransport } from '../lib/claude-ws-transport.js';

export type { DaemonConfig, DaemonState };

const DEFAULT_PORT_RANGE_START = 37842;
const MAX_PORT_ATTEMPTS = 100;
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

let state: DaemonState | null = null;
let sessionManager: ReturnType<typeof createSessionManager> | null = null;
let idleWatcher: ReturnType<typeof createIdleWatcher> | null = null;

function getDaemonPidFile(): string {
  const succDir = getSuccDir();
  const tmpDir = path.join(succDir, '.tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  return path.join(tmpDir, 'daemon.pid');
}

function getProgressFilePath(sessionId: string): string {
  const succDir = getSuccDir();
  const tmpDir = path.join(succDir, '.tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  return path.join(tmpDir, `session-${sessionId}-progress.md`);
}

export function appendToProgressFile(sessionId: string, briefing: string): void {
  const progressPath = getProgressFilePath(sessionId);
  const timestamp = new Date().toISOString();
  const timeStr = new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });

  let content = '';
  if (!fs.existsSync(progressPath)) {
    content = `---\nsession_id: ${sessionId}\ncreated: ${timestamp}\n---\n\n`;
  }

  content += `## ${timeStr} - Idle Reflection\n\n`;
  content += briefing;
  content += '\n\n---\n\n';

  fs.appendFileSync(progressPath, content);
}

export function readTailTranscript(
  transcriptPath: string,
  maxBytes: number = 2 * 1024 * 1024
): string {
  if (!fs.existsSync(transcriptPath)) {
    return '';
  }

  const stats = fs.statSync(transcriptPath);
  if (stats.size <= maxBytes) {
    return fs.readFileSync(transcriptPath, 'utf8');
  }

  const fd = fs.openSync(transcriptPath, 'r');
  const buffer = Buffer.alloc(maxBytes);
  fs.readSync(fd, buffer, 0, maxBytes, stats.size - maxBytes);
  fs.closeSync(fd);

  const content = buffer.toString('utf8');
  const firstNewline = content.indexOf('\n');
  return firstNewline > 0 ? content.slice(firstNewline + 1) : content;
}

function getDaemonTmpDir(): string {
  const succDir = getSuccDir();
  const tmpDir = path.join(succDir, '.tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  return tmpDir;
}

function getDaemonPortFile(): string {
  return path.join(getDaemonTmpDir(), 'daemon.port');
}

function getDaemonTokenFile(): string {
  return path.join(getDaemonTmpDir(), 'daemon.token');
}

// Auth token generated per daemon lifetime — written to .succ/.tmp/daemon.token
let daemonToken: string | null = null;

function getDaemonLogFile(): string {
  const succDir = getSuccDir();
  return path.join(succDir, 'daemon.log');
}

let stderrBroken = false;

function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;

  try {
    fs.appendFileSync(getDaemonLogFile(), line);
  } catch (err) {
    logWarn('daemon', 'Failed to write daemon log', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!stderrBroken) {
    try {
      process.stderr.write(line);
    } catch (err) {
      if (isErrnoException(err) && err.code === 'EPIPE') {
        stderrBroken = true;
      }
    }
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function createRouteContext(): RouteContext {
  return {
    state,
    sessionManager,
    log,
    checkShutdown,
    requestShutdown: shutdownDaemon,
    clearBriefingCache,
    appendToProgressFile,
    readTailTranscript,
    getProgressFilePath,
  };
}

function buildRoutes(ctx: RouteContext): RouteMap {
  const baseRoutes: RouteMap = {
    ...statusRoutes(ctx),
    ...sessionRoutes(ctx),
    ...searchRoutes(ctx),
    ...memoryRoutes(ctx),
    ...reflectionRoutes(ctx),
    ...watcherRoutes(ctx),
    ...analyzerRoutes(ctx),
    ...skillRoutes(ctx),
    ...hookRoutes(ctx),

    // API version info endpoint
    'GET /api/version': async () => getApiVersionInfo(),
  };

  // Add /v1/api/* aliases for all /api/* routes
  return addVersionedRoutes(baseRoutes);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const reqUrl = new URL(req.url || '/', `http://localhost`);
  const method = req.method || 'GET';

  // Restrict CORS to localhost origins only — daemon should never be accessible from arbitrary sites
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Auth token check — skip for health/status/version (needed for discovery)
  const pathname = reqUrl.pathname.replace(/^\/v1/, '');
  const isPublicEndpoint =
    pathname === '/health' ||
    pathname === '/api/status' ||
    pathname === '/api/version' ||
    pathname === '/api/health';
  if (daemonToken && !isPublicEndpoint) {
    const authHeader = req.headers.authorization;
    const providedToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (
      !providedToken ||
      Buffer.byteLength(providedToken) !== Buffer.byteLength(daemonToken) ||
      !crypto.timingSafeEqual(Buffer.from(providedToken), Buffer.from(daemonToken))
    ) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'Unauthorized. Provide daemon token via Authorization: Bearer <token>',
        })
      );
      return;
    }
  }

  let body: unknown = null;
  if (method === 'POST') {
    try {
      body = await parseBody(req);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      if (message.includes('too large')) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
      return;
    }
  }

  try {
    const result = await routeRequest(method, reqUrl.pathname, reqUrl.searchParams, body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err: unknown) {
    const message = getErrorMessage(err);
    log(`[http] Error: ${message}`);

    if (err instanceof ValidationError) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
      return;
    }

    if (err instanceof NotFoundError) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
      return;
    }

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

export async function parseBody(req: http.IncomingMessage): Promise<RequestBody> {
  return new Promise<RequestBody>((resolve, reject) => {
    let data = '';
    let size = 0;
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    req.on('data', (chunk) => {
      if (settled) return;

      const chunkSize = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      size += chunkSize;

      if (size > MAX_BODY_SIZE) {
        req.destroy();
        settle(() => reject(new Error('Request body too large')));
        return;
      }

      data += chunk;
    });

    req.on('end', () => {
      if (settled) return;

      try {
        const parsed = data ? JSON.parse(data) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          settle(() => reject(new Error('Invalid request body')));
          return;
        }
        settle(() => resolve(parsed as RequestBody));
      } catch (err) {
        logWarn('daemon', 'Failed to parse request body', {
          error: err instanceof Error ? err.message : String(err),
        });
        settle(() => reject(new Error('Invalid request body')));
      }
    });

    req.on('error', (error) => {
      settle(() => reject(error));
    });
  });
}

let cachedRoutes: RouteMap | null = null;

function getRoutes(): RouteMap {
  if (!cachedRoutes) {
    cachedRoutes = buildRoutes(createRouteContext());
  }
  return cachedRoutes;
}

/** @internal Exported for testing */
export async function routeRequest(
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  body: unknown
): Promise<unknown> {
  const routes = getRoutes();
  const key = `${method} ${pathname}`;
  const handler = routes[key];
  if (!handler) {
    throw new NotFoundError(`Unknown endpoint: ${method} ${pathname}`);
  }
  return handler(body, searchParams);
}

let updateCheckTimer: ReturnType<typeof setInterval> | null = null;
let updateCheckStartupTimer: ReturnType<typeof setTimeout> | null = null;
let recallCleanupTimer: ReturnType<typeof setInterval> | null = null;
let recallCleanupStartupTimer: ReturnType<typeof setTimeout> | null = null;
let recallCleanupInFlight: Promise<void> | null = null;

function scheduleRecallCleanup(logFn: (msg: string) => void): void {
  const runCleanup = () => {
    try {
      const config = getConfig();
      const retentionDays = config.privacy?.recall?.retention_days ?? 30;
      if (retentionDays <= 0) return;
      recallCleanupInFlight = (async () => {
        const { cleanupRecallEvents } = await import('../lib/retrieval-feedback.js');
        const deleted = await cleanupRecallEvents(retentionDays);
        if (deleted > 0) {
          logFn(
            `[recall-cleanup] Deleted ${deleted} recall events older than ${retentionDays} days`
          );
        }
      })()
        .catch((err) => {
          logWarn('daemon', 'Recall cleanup failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          recallCleanupInFlight = null;
        });
    } catch (err) {
      logWarn('daemon', 'Recall cleanup scheduler error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  recallCleanupStartupTimer = setTimeout(runCleanup, 10_000); // 10s after startup
  recallCleanupStartupTimer.unref();
  recallCleanupTimer = setInterval(runCleanup, 86_400_000); // daily
  recallCleanupTimer.unref();
}

function scheduleUpdateCheck(logFn: (msg: string) => void): void {
  // Run once at startup (after short delay to not block init)
  const runCheck = () => {
    import('../lib/version-check.js')
      .then(({ checkForUpdate }) => checkForUpdate())
      .then((result) => {
        if (result?.update_available) {
          logFn(`[update-check] Update available: ${result.current} → ${result.latest}`);
        }
      })
      .catch((err) => {
        logFn(`[update-check] Failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  };

  updateCheckStartupTimer = setTimeout(runCheck, 5000); // 5s after startup
  updateCheckStartupTimer.unref();
  // Re-check every 12 hours (cache TTL is 24h, so this keeps it warm)
  updateCheckTimer = setInterval(runCheck, 12 * 3600_000);
  updateCheckTimer.unref(); // Don't prevent process exit
}

// ---------------------------------------------------------------------------
// Port acquisition helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Try to bind a server to a port. Returns { ok: true } or { ok: false, code }. */
async function tryListen(
  server: http.Server,
  port: number
): Promise<{ ok: true } | { ok: false; code: string }> {
  return new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      resolve({ ok: false, code: err.code || 'UNKNOWN' });
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve({ ok: true });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Probe the occupant of the stable port and decide what to do.
 * Returns:
 *   'exit'    — healthy daemon for this project, caller should exit
 *   'killed'  — old daemon killed, caller should retry listen
 *   'foreign' — port occupied by a non-succ process, caller should fallback
 */
async function reclaimStablePort(
  stablePort: number,
  ourCwd: string,
  logFn: (msg: string) => void
): Promise<'exit' | 'killed' | 'foreign'> {
  // Probe health with retries (2 attempts, 1s apart) to survive GC pauses
  let health: { status?: string; pid?: number; cwd?: string } | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const resp = await fetch(`http://127.0.0.1:${stablePort}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (resp.ok) {
        health = (await resp.json()) as { status?: string; pid?: number; cwd?: string };
        break;
      }
    } catch (probeErr) {
      logFn(
        `[daemon] Health probe attempt ${attempt + 1} failed: ${probeErr instanceof Error ? probeErr.message : String(probeErr)}`
      );
      if (attempt === 0) await sleep(1000);
    }
  }

  if (!health || health.status !== 'ok') {
    // Port occupied by something that doesn't respond to /health — foreign process
    logFn(`[daemon] Stable port ${stablePort} occupied by non-succ process`);
    return 'foreign';
  }

  // Normalize cwd for comparison (lowercase + forward slashes on Windows)
  const normCwd = (p: string) =>
    (process.platform === 'win32' ? p.toLowerCase() : p).replace(/\\/g, '/');

  if (normCwd(health.cwd || '') !== normCwd(ourCwd)) {
    logFn(
      `[daemon] Stable port ${stablePort} used by different project: ${health.cwd} (ours: ${ourCwd})`
    );
    return 'foreign';
  }

  // Same project — try graceful HTTP shutdown first, then force kill
  const occupantPid = health.pid;

  // Read old daemon's auth token for authenticated shutdown request
  let tokenHeader: Record<string, string> = {};
  let hasToken = false;
  try {
    const tokenPath = getDaemonTokenFile();
    if (fs.existsSync(tokenPath)) {
      const token = fs.readFileSync(tokenPath, 'utf8').trim();
      if (token) {
        tokenHeader = { Authorization: `Bearer ${token}` };
        hasToken = true;
      }
    }
  } catch {
    logFn(`[daemon] Could not read old daemon token, shutdown request may be rejected`);
  }

  logFn(
    `[daemon] Stale daemon on port ${stablePort} (pid=${occupantPid}), requesting shutdown${hasToken ? '' : ' (no auth token, may be rejected)'}`
  );

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    await fetch(`http://127.0.0.1:${stablePort}/api/shutdown`, {
      method: 'POST',
      headers: tokenHeader,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    // Wait for graceful exit
    await sleep(2000);
  } catch {
    logFn(`[daemon] HTTP shutdown request failed, proceeding to kill`);
  }

  // Check if it's gone
  if (occupantPid) {
    try {
      process.kill(occupantPid, 0);
      // Still alive — force kill (on Windows, SIGKILL maps to TerminateProcess)
      logFn(`[daemon] Daemon pid=${occupantPid} still alive after shutdown request, killing`);
      try {
        process.kill(occupantPid, 'SIGKILL');
      } catch (killErr) {
        logWarn('daemon', `Failed to kill stale daemon pid=${occupantPid}`, {
          error: killErr instanceof Error ? killErr.message : String(killErr),
        });
      }
      await sleep(500);
    } catch {
      logFn(`[daemon] Occupant pid=${occupantPid} already exited`);
    }
  }

  return 'killed';
}

export async function startDaemon(): Promise<{ port: number; pid: number }> {
  if (state?.server) {
    return { port: state.port, pid: process.pid };
  }

  // Atomic PID file — daemon-side mutex to prevent dual startup
  const pidFile = getDaemonPidFile();
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  try {
    fs.writeFileSync(pidFile, String(process.pid), { flag: 'wx' }); // exclusive create
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // PID file exists — check if owner is alive
      try {
        const existingPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        if (!isNaN(existingPid) && existingPid && existingPid !== process.pid) {
          let processAlive = false;
          try {
            process.kill(existingPid, 0);
            processAlive = true;
          } catch (killErr) {
            const killCode = (killErr as NodeJS.ErrnoException).code;
            if (killCode !== 'ESRCH') {
              throw killErr;
            }
          }
          // Reclaim PID file regardless — port acquisition will health-check the occupant
          log(
            processAlive
              ? `[daemon] Existing daemon pid=${existingPid} alive, reclaiming PID (port acquisition will resolve)`
              : `[daemon] PID ${existingPid} not running, reclaiming`
          );
          try {
            fs.unlinkSync(pidFile);
          } catch (unlinkErr) {
            if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw unlinkErr;
            }
          }
          try {
            fs.writeFileSync(pidFile, String(process.pid), { flag: 'wx' });
          } catch (reclaimErr) {
            log(
              `[daemon] Lost PID reclaim race (${(reclaimErr as NodeJS.ErrnoException).code || 'unknown'}), exiting`
            );
            process.exit(0);
          }
          if (!processAlive) {
            const portFile = getDaemonPortFile();
            try {
              fs.unlinkSync(portFile);
            } catch (unlinkErr) {
              log(
                `[daemon] Port file cleanup skipped: ${(unlinkErr as NodeJS.ErrnoException).code || 'unknown'}`
              );
            }
          }
        } else {
          // Same PID or invalid — atomic reclaim
          try {
            fs.unlinkSync(pidFile);
          } catch (unlinkErr) {
            if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw unlinkErr;
            }
          }
          try {
            fs.writeFileSync(pidFile, String(process.pid), { flag: 'wx' });
          } catch (reclaimErr) {
            log(
              `[daemon] Lost PID reclaim race (${(reclaimErr as NodeJS.ErrnoException).code || 'unknown'}), exiting`
            );
            process.exit(0);
          }
        }
      } catch (readErr) {
        // Re-throw kill-related errors (e.g. EPERM) — only handle genuine PID file read failures
        const readErrCode = (readErr as NodeJS.ErrnoException).code;
        if (readErrCode === 'EPERM' || readErrCode === 'EACCES') {
          throw readErr;
        }
        logWarn('daemon', 'Failed to read daemon PID file, reclaiming atomically', {
          error: readErr instanceof Error ? readErr.message : String(readErr),
        });
        try {
          fs.unlinkSync(pidFile);
        } catch (unlinkErr) {
          if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw unlinkErr;
          }
        }
        try {
          fs.writeFileSync(pidFile, String(process.pid), { flag: 'wx' });
        } catch (reclaimErr) {
          log(
            `[daemon] Lost PID reclaim race (${(reclaimErr as NodeJS.ErrnoException).code || 'unknown'}), exiting`
          );
          process.exit(0);
        }
      }
    } else {
      throw err;
    }
  }

  // Clean up PID file on exit
  process.once('exit', () => {
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // exit handler — log() may not work, stderr may be broken (EPIPE).
      // Stale PID is handled on next startup via liveness check.
    }
  });

  const cwd = getProjectRoot();
  const watcherConfig = getIdleWatcherConfig();
  getIdleReflectionConfig();

  await initStorageDispatcher();

  sessionManager = createSessionManager();
  cachedRoutes = null;
  loadBudgets();
  initReflectionMaintenance();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log(`[http] Unhandled error: ${err.message}`);
      res.writeHead(500);
      res.end();
    });
  });

  // Try stable port first (config or hash-based), then fall back to scan
  const config = getConfig();
  const stablePort = config.daemon?.port ?? getStablePort(cwd);
  const fallbackStart = config.daemon?.port_range_start ?? DEFAULT_PORT_RANGE_START;

  let port = stablePort;

  // Attempt to bind the stable port. If occupied, probe occupant before falling back.
  const stableBindResult = await tryListen(server, port);
  if (!stableBindResult.ok) {
    if (stableBindResult.code === 'EADDRINUSE') {
      const reclaimed = await reclaimStablePort(stablePort, cwd, log);
      if (reclaimed === 'exit') {
        // Healthy daemon for this project already running — exit silently
        log(`[daemon] Healthy daemon already on port ${stablePort}, exiting`);
        process.exit(0);
      }
      if (reclaimed === 'killed') {
        // Old daemon killed — retry listen with exponential backoff
        let bound = false;
        const delays = [100, 200, 400, 800, 1600];
        for (const delay of delays) {
          await sleep(delay);
          const retry = await tryListen(server, stablePort);
          if (retry.ok) {
            bound = true;
            break;
          }
          log(`[daemon] Stable port ${stablePort} still busy after ${delay}ms, retrying...`);
        }
        if (!bound) {
          log(`[daemon] Could not reclaim stable port ${stablePort} after kill, falling back`);
        }
      }
      // reclaimed === 'foreign' or retry exhausted — fall back to port scan
      if (!server.listening) {
        log(
          `[daemon] Stable port ${stablePort} occupied by another process, scanning fallback range`
        );
        port = fallbackStart;
        for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
          const result = await tryListen(server, port);
          if (result.ok) break;
          port++;
        }
      }
    } else {
      throw new NetworkError(`Failed to bind port ${port}: ${stableBindResult.code}`);
    }
  }

  if (!server.listening) {
    throw new NetworkError(
      `Could not find available port (tried ${stablePort}, then ${fallbackStart}-${fallbackStart + MAX_PORT_ATTEMPTS})`
    );
  }

  state = {
    cwd,
    startedAt: Date.now(),
    port,
    server,
  };
  cachedRoutes = null;

  // PID already written at startup (atomic mutex). Write port and auth token now.
  fs.writeFileSync(getDaemonPortFile(), String(port));
  daemonToken = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(getDaemonTokenFile(), daemonToken, { mode: 0o600 });

  idleWatcher = createIdleWatcher({
    sessionManager,
    onIdle: (sessionId, session) => performReflection(createRouteContext(), sessionId, session),
    onPreGenerateBriefing: (sessionId, transcriptPath) =>
      preGenerateBriefing(createRouteContext(), sessionId, transcriptPath),
    checkIntervalSeconds: watcherConfig.check_interval,
    idleMinutes: watcherConfig.idle_minutes,
    reflectionCooldownMinutes: watcherConfig.reflection_cooldown_minutes,
    preGenerateIdleSeconds: 120,
    log,
  });
  idleWatcher.start();

  log(`[daemon] Started on port ${port} (pid=${process.pid})`);

  // Background update check — keeps cache warm for MCP-only users
  scheduleUpdateCheck(log);

  // Daily recall event retention cleanup
  scheduleRecallCleanup(log);

  // Max uptime guard — exit if idle for 24h+ so stale orphans self-terminate
  scheduleMaxUptimeGuard(log);

  // Pre-warm WS transport if configured (eliminates cold-start on first LLM call)
  if (getClaudeMode() === 'ws') {
    ClaudeWSTransport.warmup();
    log('[daemon] WS transport warmup initiated');
  }

  if (config.daemon?.watch?.auto_start) {
    const watchConfig = config.daemon.watch;
    await startWatcher(
      {
        patterns: watchConfig.patterns || ['**/*.md'],
        includeCode: watchConfig.include_code ?? true,
        debounceMs: watchConfig.debounce_ms ?? 500,
      },
      log
    );
    log(`[daemon] Auto-started watch service`);
  }

  if (config.daemon?.analyze?.auto_start) {
    const analyzeConfig = config.daemon.analyze;
    startAnalyzer(
      {
        intervalMinutes: analyzeConfig.interval_minutes ?? 30,
        mode: analyzeConfig.mode ?? 'claude',
      },
      log
    );
    log(`[daemon] Auto-started analyze service`);
  }

  setupShutdownHandlers();

  return { port, pid: process.pid };
}

function setupShutdownHandlers(): void {
  const shutdown = () => shutdownDaemon();

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  if (process.platform !== 'win32') {
    process.on('SIGHUP', shutdown);
  }

  // Prevent silent crashes — log and keep running
  process.on('uncaughtException', (err) => {
    // EPIPE from stderr write — mark broken and skip log to avoid recursion
    if (isErrnoException(err) && err.code === 'EPIPE') {
      stderrBroken = true;
      return;
    }
    log(`[daemon] UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
    log(`[daemon] UNHANDLED REJECTION: ${msg}`);
  });
}

const MAX_IDLE_UPTIME_MS = 24 * 3600_000; // 24 hours
let maxUptimeTimer: ReturnType<typeof setInterval> | null = null;

function checkShutdown(): void {
  if (sessionManager?.canShutdown()) {
    log(`[daemon] No more sessions and no pending work, scheduling shutdown`);
    setTimeout(() => {
      if (sessionManager?.canShutdown()) {
        shutdownDaemon();
      }
    }, 5000);
  }
}

/** Periodic check: if daemon is idle and has exceeded max uptime, exit cleanly. */
function scheduleMaxUptimeGuard(logFn: (msg: string) => void): void {
  maxUptimeTimer = setInterval(() => {
    if (!state?.startedAt || !sessionManager?.canShutdown()) return;
    const uptime = Date.now() - state.startedAt;
    if (uptime > MAX_IDLE_UPTIME_MS) {
      logFn(`[daemon] Max idle uptime exceeded (${Math.round(uptime / 3600_000)}h), shutting down`);
      shutdownDaemon();
    }
  }, 3600_000); // Check every hour
  maxUptimeTimer.unref();
}

export async function shutdownDaemon(): Promise<void> {
  log('[daemon] Shutting down...');

  if (updateCheckStartupTimer) {
    clearTimeout(updateCheckStartupTimer);
    updateCheckStartupTimer = null;
  }

  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }

  if (recallCleanupStartupTimer) {
    clearTimeout(recallCleanupStartupTimer);
    recallCleanupStartupTimer = null;
  }

  if (maxUptimeTimer) {
    clearInterval(maxUptimeTimer);
    maxUptimeTimer = null;
  }

  if (recallCleanupTimer) {
    clearInterval(recallCleanupTimer);
    recallCleanupTimer = null;
  }

  if (idleWatcher) {
    idleWatcher.stop();
    idleWatcher = null;
  }

  const watcherPromise = stopWatcher(log).catch((err) =>
    log(`[shutdown] Watcher stop failed: ${getErrorMessage(err)}`)
  );
  stopAnalyzer(log);

  const serverPromise = state?.server
    ? new Promise<void>((resolve) => {
        state!.server!.close(() => resolve());
        state!.server = null;
      })
    : Promise.resolve();

  // Graceful WS transport shutdown before force-killing processes
  await ClaudeWSTransport.shutdown().catch((err) =>
    log(`[shutdown] WS transport shutdown failed: ${getErrorMessage(err)}`)
  );

  processRegistry.killAll();

  // Wait for watcher, HTTP server, and in-flight cleanup to finish before closing storage,
  // so in-flight requests don't hit a closed DB.
  await Promise.allSettled([watcherPromise, serverPromise, recallCleanupInFlight]);

  await closeStorageDispatcher().catch((err) =>
    log(`[shutdown] Storage close failed: ${getErrorMessage(err)}`)
  );
  cleanupEmbeddings();
  await cleanupReranker().catch((err) =>
    log(`[shutdown] Reranker cleanup failed: ${getErrorMessage(err)}`)
  );
  cleanupQualityScoring();
  closeDb();
  closeGlobalDb();

  try {
    fs.unlinkSync(getDaemonPidFile());
  } catch (err: unknown) {
    if (!isErrnoException(err) || err.code !== 'ENOENT') {
      log(`[shutdown] PID file removal failed: ${getErrorMessage(err)}`);
    }
  }

  try {
    fs.unlinkSync(getDaemonPortFile());
  } catch (err: unknown) {
    if (!isErrnoException(err) || err.code !== 'ENOENT') {
      log(`[shutdown] Port file removal failed: ${getErrorMessage(err)}`);
    }
  }

  try {
    fs.unlinkSync(getDaemonTokenFile());
  } catch (err: unknown) {
    if (!isErrnoException(err) || err.code !== 'ENOENT') {
      log(`[shutdown] Token file removal failed: ${getErrorMessage(err)}`);
    }
  }
  daemonToken = null;

  log('[daemon] Shutdown complete');
  process.exit(0);
}

/** @internal Initialize module state for testing without starting HTTP server */
export function _initTestState(cwd: string = process.cwd()): void {
  sessionManager = createSessionManager();
  state = { cwd, startedAt: Date.now(), port: 0, server: null };
  cachedRoutes = null;
}

/** @internal Reset module state after testing */
export function _resetTestState(): void {
  sessionManager = null;
  idleWatcher = null;
  state = null;
  cachedRoutes = null;
  resetReflectionRoutesState();
  resetMemoryRoutesState();
  resetSearchRoutesState();
}

if (process.argv[1]?.endsWith('service.js') || process.argv[1]?.endsWith('service.ts')) {
  startDaemon()
    .then(({ port, pid }) => {
      console.log(`Daemon started on port ${port} (pid=${pid})`);
    })
    .catch((err) => {
      logError('daemon', `Failed to start daemon: ${err.message}`, err);
      console.error('Failed to start daemon:', err.message);
      process.exit(1);
    });
}
