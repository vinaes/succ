/**
 * Centralized fault logger for succ.
 *
 * Three channels:
 * 1. Local file: .succ/brain-faults.log (JSON lines, with rotation)
 * 2. Webhook: POST to configurable URL (fire-and-forget)
 * 3. Sentry: lazy-loaded @sentry/node SDK (optional peer dependency)
 */

import fs from 'node:fs';
import path from 'node:path';
import { getSuccDir, getErrorReportingConfig } from './config.js';

export type FaultLevel = 'error' | 'warn' | 'info' | 'debug';

export interface FaultEntry {
  timestamp: string;
  level: FaultLevel;
  component: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
  version?: string;
}

const LEVEL_ORDER: Record<FaultLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// Read version once at module load
let _version: string | undefined;
function getVersion(): string {
  if (_version) return _version;
  try {
    const pkgPath = path.resolve(
      new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
      '../../package.json'
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    _version = pkg.version || 'unknown';
  } catch {
    _version = 'unknown';
  }
  return _version!;
}

// ---------------------------------------------------------------------------
// Channel 1: Local file with rotation
// ---------------------------------------------------------------------------

function rotateIfNeeded(logPath: string, maxSizeMb: number): void {
  try {
    const stats = fs.statSync(logPath);
    if (stats.size > maxSizeMb * 1024 * 1024) {
      const backupPath = logPath + '.1';
      fs.renameSync(logPath, backupPath);
    }
  } catch {
    // File doesn't exist or can't stat — fine, will be created on write
  }
}

function writeToFile(entry: FaultEntry, maxSizeMb: number): void {
  try {
    const succDir = getSuccDir();
    const logPath = path.join(succDir, 'brain-faults.log');

    // Ensure .succ/ directory exists
    if (!fs.existsSync(succDir)) {
      fs.mkdirSync(succDir, { recursive: true });
    }

    rotateIfNeeded(logPath, maxSizeMb);
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch {
    // Never break caller
  }
}

// ---------------------------------------------------------------------------
// Channel 2: Webhook (fire-and-forget)
// ---------------------------------------------------------------------------

function sendToWebhook(entry: FaultEntry, url: string, headers?: Record<string, string>): void {
  try {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(entry),
    }).catch(() => {});
  } catch {
    // Never break caller
  }
}

// ---------------------------------------------------------------------------
// Channel 3: Sentry (lazy-loaded optional peer dependency)
// ---------------------------------------------------------------------------

let sentryModule: any = undefined; // undefined=not tried, false=not installed
let sentryInitialized = false;

async function getSentry(): Promise<any> {
  if (sentryModule === false) return null;
  if (sentryModule) return sentryModule;
  try {
    // @ts-expect-error - @sentry/node is an optional peer dependency, may not be installed
    sentryModule = await import('@sentry/node');
    return sentryModule;
  } catch {
    sentryModule = false;
    return null;
  }
}

function sendToSentry(
  entry: FaultEntry,
  dsn: string,
  environment: string,
  sampleRate: number
): void {
  (async () => {
    try {
      const Sentry = await getSentry();
      if (!Sentry) return;

      if (!sentryInitialized) {
        Sentry.init({ dsn, environment, sampleRate });
        sentryInitialized = true;
      }

      if (entry.level === 'error') {
        const err = new Error(entry.message);
        if (entry.stack) err.stack = entry.stack;
        Sentry.captureException(err, {
          tags: { component: entry.component },
          extra: entry.context,
        });
      } else {
        Sentry.captureMessage(entry.message, {
          level: entry.level,
          tags: { component: entry.component },
          extra: entry.context,
        });
      }
    } catch {
      // Never break caller
    }
  })();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Log a fault to all configured channels.
 * Never throws — all errors are silently swallowed.
 */
export function logFault(
  level: FaultLevel,
  component: string,
  message: string,
  opts?: { error?: Error; context?: Record<string, unknown> }
): void {
  try {
    const config = getErrorReportingConfig();
    if (!config.enabled) return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[config.level]) return;

    const entry: FaultEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      stack: opts?.error?.stack,
      context: opts?.context,
    };

    // Channel 1: local file (always)
    writeToFile(entry, config.max_file_size_mb);

    // Channel 2: webhook (if configured)
    if (config.webhook_url) {
      sendToWebhook(
        { ...entry, version: getVersion() },
        config.webhook_url,
        config.webhook_headers
      );
    }

    // Channel 3: sentry (if configured)
    if (config.sentry_dsn) {
      sendToSentry(entry, config.sentry_dsn, config.sentry_environment, config.sentry_sample_rate);
    }
  } catch {
    // Absolutely never break the caller
  }
}

/** Log an error (convenience wrapper). */
export function logError(
  component: string,
  message: string,
  error?: Error,
  context?: Record<string, unknown>
): void {
  logFault('error', component, message, { error, context });
}

/** Log a warning (convenience wrapper). */
export function logWarn(
  component: string,
  message: string,
  context?: Record<string, unknown>
): void {
  logFault('warn', component, message, { context });
}

/** Log an info message (convenience wrapper). */
export function logInfo(
  component: string,
  message: string,
  context?: Record<string, unknown>
): void {
  logFault('info', component, message, { context });
}

// ---------------------------------------------------------------------------
// Testing helpers (exported for test use only)
// ---------------------------------------------------------------------------

/** Reset Sentry state (for testing). */
export function _resetSentryState(): void {
  sentryModule = undefined;
  sentryInitialized = false;
}
