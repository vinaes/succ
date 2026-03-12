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

function getDaemonPortFile(): string {
  const succDir = getSuccDir();
  const tmpDir = path.join(succDir, '.tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  return path.join(tmpDir, 'daemon.port');
}

function getDaemonLogFile(): string {
  const succDir = getSuccDir();
  return path.join(succDir, 'daemon.log');
}

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

  process.stderr.write(line);
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

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
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
      } catch {
        settle(() => reject(new Error('Invalid request body')));
      }
    });

    req.on('error', (error) => {
      settle(() => reject(error));
    });
  });
}

/** @internal Exported for testing */
export async function routeRequest(
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  body: unknown
): Promise<unknown> {
  const routes = buildRoutes(createRouteContext());
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
        const deleted = cleanupRecallEvents(retentionDays);
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

export async function startDaemon(): Promise<{ port: number; pid: number }> {
  if (state?.server) {
    return { port: state.port, pid: process.pid };
  }

  const existingPidFile = getDaemonPidFile();
  if (fs.existsSync(existingPidFile)) {
    try {
      const existingPid = parseInt(fs.readFileSync(existingPidFile, 'utf8').trim(), 10);
      if (existingPid && existingPid !== process.pid) {
        try {
          process.kill(existingPid, 0);
          const portFile = getDaemonPortFile();
          if (fs.existsSync(portFile)) {
            const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
            log(`[daemon] Another daemon already running (pid=${existingPid}, port=${port})`);
            process.exit(0);
          }
        } catch (error) {
          logWarn('service', 'Failed to signal existing daemon process for liveness check', {
            error: error instanceof Error ? error.message : String(error),
          });
          log(`[daemon] Cleaning up stale PID file (pid=${existingPid} not running)`);
          fs.unlinkSync(existingPidFile);
          const portFile = getDaemonPortFile();
          if (fs.existsSync(portFile)) {
            fs.unlinkSync(portFile);
          }
        }
      }
    } catch (err) {
      logWarn('daemon', 'Failed to read daemon PID file', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const cwd = getProjectRoot();
  const watcherConfig = getIdleWatcherConfig();
  getIdleReflectionConfig();

  await initStorageDispatcher();

  sessionManager = createSessionManager();
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
  let portAttempts = 0;
  const maxAttempts = 1 + MAX_PORT_ATTEMPTS; // 1 stable + 100 fallback

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          portAttempts++;
          if (portAttempts === 1) {
            // Stable port busy — switch to fallback range
            port = fallbackStart;
          } else {
            port++;
          }
          resolve();
        } else {
          reject(err);
        }
      });
      server.listen(port, '127.0.0.1', () => {
        resolve();
      });
    });

    if (server.listening) {
      break;
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

  fs.writeFileSync(getDaemonPidFile(), String(process.pid));
  fs.writeFileSync(getDaemonPortFile(), String(port));

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

  if (config.daemon?.watch?.auto_start) {
    const watchConfig = config.daemon.watch;
    await startWatcher(
      {
        patterns: watchConfig.patterns || ['**/*.md'],
        includeCode: watchConfig.include_code ?? false,
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
    log(`[daemon] UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
    log(`[daemon] UNHANDLED REJECTION: ${msg}`);
  });
}

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

  if (recallCleanupTimer) {
    clearInterval(recallCleanupTimer);
    recallCleanupTimer = null;
  }

  if (idleWatcher) {
    idleWatcher.stop();
    idleWatcher = null;
  }

  const watcherPromise = stopWatcher(log).catch((err) =>
    log(`[shutdown] Watcher stop failed: ${err}`)
  );
  stopAnalyzer(log);

  const serverPromise = state?.server
    ? new Promise<void>((resolve) => {
        state!.server!.close(() => resolve());
        state!.server = null;
      })
    : Promise.resolve();

  processRegistry.killAll();

  // Wait for watcher, HTTP server, and in-flight cleanup to finish before closing storage,
  // so in-flight requests don't hit a closed DB.
  await Promise.allSettled([watcherPromise, serverPromise, recallCleanupInFlight]);

  await closeStorageDispatcher().catch((err) => log(`[shutdown] Storage close failed: ${err}`));
  cleanupEmbeddings();
  await cleanupReranker().catch((err) => log(`[shutdown] Reranker cleanup failed: ${err}`));
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

  log('[daemon] Shutdown complete');
  process.exit(0);
}

/** @internal Initialize module state for testing without starting HTTP server */
export function _initTestState(cwd: string = process.cwd()): void {
  sessionManager = createSessionManager();
  state = { cwd, startedAt: Date.now(), port: 0, server: null };
}

/** @internal Reset module state after testing */
export function _resetTestState(): void {
  sessionManager = null;
  idleWatcher = null;
  state = null;
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
