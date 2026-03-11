/**
 * Update check — poll npm registry, cache result, format notification.
 *
 * Zero dependencies beyond Node built-ins + project config helpers.
 * Cache lives at .succ/.tmp/version-check.json (same pattern as daemon.port).
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { logWarn } from './fault-logger.js';
import { getSuccDir, getConfig } from './config.js';

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@vinaes/succ/latest';
const DEFAULT_INTERVAL_HOURS = 24;
const FETCH_TIMEOUT_MS = 3000;
const CACHE_FILENAME = 'version-check.json';

export interface UpdateCheckResult {
  latest: string;
  current: string;
  checked_at: string;
  update_available: boolean;
}

/** Read package.json version at import time */
const require = createRequire(import.meta.url);
const pkg = require('../../package.json');
const CURRENT_VERSION: string = pkg.version;

// ── Semver comparison (inline, no dep) ─────────────────────────────

/** Returns 1 if a > b, -1 if a < b, 0 if equal. Pre-release ignored. */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// ── Cache path ─────────────────────────────────────────────────────

function getCachePath(): string | null {
  try {
    const succDir = getSuccDir();
    const tmpDir = path.join(succDir, '.tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    return path.join(tmpDir, CACHE_FILENAME);
  } catch {
    // No .succ dir (global-only mode) — try home fallback
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return null;
    const fallbackDir = path.join(home, '.succ', '.tmp');
    try {
      if (!fs.existsSync(fallbackDir)) {
        fs.mkdirSync(fallbackDir, { recursive: true });
      }
      return path.join(fallbackDir, CACHE_FILENAME);
    } catch {
      return null;
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Check npm registry for updates. Writes cache file on success.
 * Returns null if suppressed by env, within TTL, or on error.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult | null> {
  // Env suppression
  if (
    process.env.SUCC_NO_UPDATE_CHECK === '1' ||
    process.env.CI === 'true' ||
    process.env.NO_UPDATE_NOTIFIER === '1'
  ) {
    return null;
  }

  // Config suppression
  try {
    const config = getConfig();
    if (config.update_check?.enabled === false) return null;
  } catch {
    // config not available — continue with defaults
  }

  // Check TTL — skip if recently checked
  const cached = getCachedUpdate();
  if (cached) {
    const intervalHours = getIntervalHours();
    const elapsed = Date.now() - new Date(cached.checked_at).getTime();
    if (elapsed < intervalHours * 3600_000) {
      return cached.update_available ? cached : null;
    }
  }

  const cachePath = getCachePath();

  try {
    const res = await fetch(NPM_REGISTRY_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      logWarn('version-check', `npm registry returned ${res.status}`);
      return null;
    }

    const data = (await res.json()) as { version?: string };
    const latest = data.version;
    if (!latest || typeof latest !== 'string') {
      logWarn('version-check', 'npm registry response missing version field');
      return null;
    }

    const result: UpdateCheckResult = {
      latest,
      current: CURRENT_VERSION,
      checked_at: new Date().toISOString(),
      update_available: compareSemver(latest, CURRENT_VERSION) > 0,
    };

    // Write cache
    if (cachePath) {
      try {
        fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
      } catch (err) {
        logWarn(
          'version-check',
          `Failed to write cache: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return result.update_available ? result : null;
  } catch (err) {
    logWarn(
      'version-check',
      `Update check failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * Read cached update result (sync, no network).
 * Returns null if missing, expired, or malformed.
 */
export function getCachedUpdate(): UpdateCheckResult | null {
  const cachePath = getCachePath();
  if (!cachePath) return null;

  try {
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, 'utf8');
    const data = JSON.parse(raw) as UpdateCheckResult;

    // Validate shape
    if (
      !data ||
      typeof data.latest !== 'string' ||
      typeof data.current !== 'string' ||
      typeof data.checked_at !== 'string' ||
      typeof data.update_available !== 'boolean'
    ) {
      return null;
    }

    // Check staleness (48h hard expiry)
    const age = Date.now() - new Date(data.checked_at).getTime();
    if (age > 48 * 3600_000) return null;

    return data;
  } catch {
    return null;
  }
}

/**
 * Box-drawing CLI notification for TTY output.
 */
export function formatUpdateNotification(result: UpdateCheckResult): string {
  const msg = `Update available: ${result.current} \u2192 ${result.latest}`;
  const cmd = 'Run: npm update -g @vinaes/succ';
  const width = Math.max(msg.length, cmd.length) + 4;

  const pad = (s: string) => '  ' + s + ' '.repeat(width - s.length - 2);

  return [
    '\x1b[33m' + '\u256D' + '\u2500'.repeat(width) + '\u256E',
    '\u2502' + pad(msg) + '\u2502',
    '\u2502' + pad(cmd) + '\u2502',
    '\u2570' + '\u2500'.repeat(width) + '\u256F' + '\x1b[0m',
  ].join('\n');
}

/** Get current installed version */
export function getCurrentVersion(): string {
  return CURRENT_VERSION;
}

// ── Helpers ────────────────────────────────────────────────────────

function getIntervalHours(): number {
  try {
    const config = getConfig();
    return config.update_check?.interval_hours ?? DEFAULT_INTERVAL_HOURS;
  } catch {
    return DEFAULT_INTERVAL_HOURS;
  }
}
