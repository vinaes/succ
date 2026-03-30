/**
 * Context Monitor — Per-session context window usage tracking
 *
 * Tracks active context token usage per session and determines when to advise
 * running /compact. Uses real API usage.input_tokens from the transcript as
 * the primary estimation source (post-compact-offset only), with a byte-based
 * fallback.
 *
 * Urgency tiers (relative to threshold_percent):
 *   none     — usage < threshold
 *   low      — usage >= threshold
 *   medium   — usage >= threshold + 15
 *   high     — usage >= threshold + 30
 *   critical — usage >= 80%
 */

import fs from 'fs';
import { detectContextLimit } from './context-limits.js';
import { logWarn } from './fault-logger.js';
import { getErrorMessage } from './errors.js';
import { CHARS_PER_TOKEN } from './token-counter.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface ContextUsage {
  session_id: string;
  tokens_used: number;
  tokens_limit: number | null;
  usage_percent: number;
  should_compact: boolean;
  urgency: 'none' | 'low' | 'medium' | 'high' | 'critical';
  cooldown_active: boolean;
}

export interface ResolvedAutoCompactConfig {
  enabled: boolean;
  threshold_percent: number;
  cooldown_seconds: number;
  context_limit?: number;
  preemptive_extract: boolean;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface SessionContext {
  transcriptPath: string;
  contextLimit: number | null; // null = not yet detected / ambiguous
  compactOffset: number; // transcript bytes at last compact event
  lastAdvisoryAt: number; // ms epoch of last advisory emission
  advisoryCount: number;
  lastDetectAttempt: number; // ms epoch of last contextLimit detection attempt
  extractionInFlight: boolean; // per-session lock for preemptive extraction
}

// Re-detect limit after this many ms when model is ambiguous (e.g. Sonnet)
const REDETECT_INTERVAL_MS = 30_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Read the tail of the transcript file and extract the latest input_tokens
 * value from assistant messages that appear AFTER the compact offset.
 *
 * Only scans bytes after compactOffset so stale pre-compact values are ignored.
 */
function getLatestInputTokens(transcriptPath: string, compactOffset: number): number {
  try {
    if (!fs.existsSync(transcriptPath)) return 0;
    const stats = fs.statSync(transcriptPath);
    if (stats.size <= compactOffset) return 0;

    const readBytes = Math.min(50_000, stats.size - compactOffset);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, stats.size - readBytes);
    fs.closeSync(fd);

    const tail = buf.toString('utf8');
    const matches = [...tail.matchAll(/"input_tokens"\s*:\s*(\d+)/g)];
    if (matches.length === 0) return 0;

    // Return the highest value (most recent API response in this segment)
    return Math.max(...matches.map((m) => parseInt(m[1], 10)));
  } catch (err) {
    logWarn(
      'context-monitor',
      `getLatestInputTokens failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return 0;
  }
}

function computeUrgency(
  usagePct: number,
  threshold: number
): 'none' | 'low' | 'medium' | 'high' | 'critical' {
  if (usagePct >= 80) return 'critical';
  if (usagePct >= threshold + 30) return 'high';
  if (usagePct >= threshold + 15) return 'medium';
  if (usagePct >= threshold) return 'low';
  return 'none';
}

// ── ContextMonitor class ──────────────────────────────────────────────────────

export class ContextMonitor {
  private sessions = new Map<string, SessionContext>();
  private config: ResolvedAutoCompactConfig;
  private onPreemptiveExtract?: (sessionId: string, transcriptPath: string) => Promise<void>;

  constructor(
    config: ResolvedAutoCompactConfig,
    onPreemptiveExtract?: (sessionId: string, transcriptPath: string) => Promise<void>
  ) {
    this.config = config;
    this.onPreemptiveExtract = onPreemptiveExtract;
  }

  /** Register a new session. Called on session register. */
  registerSession(sessionId: string, transcriptPath: string): void {
    if (this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, {
      transcriptPath,
      contextLimit: null,
      compactOffset: 0,
      lastAdvisoryAt: 0,
      advisoryCount: 0,
      lastDetectAttempt: 0,
      extractionInFlight: false,
    });
  }

  /** Unregister a session when it ends. */
  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Record a compact event — resets the byte offset so usage calculation
   * restarts from the current transcript size.
   */
  recordCompact(sessionId: string, transcriptBytes: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.compactOffset = transcriptBytes;
    session.lastAdvisoryAt = 0; // reset cooldown after compact
    session.advisoryCount = 0;
  }

  /**
   * Mark cooldown after a successful advisory emission.
   * Called by hook via POST /api/context-usage/ack.
   */
  markAdvisory(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.lastAdvisoryAt = Date.now();
    session.advisoryCount++;
  }

  /**
   * Compute current context usage for a session.
   *
   * @param sessionId - Session identifier
   * @param currentTranscriptSize - Current transcript file size in bytes (O(1) stat)
   * @returns ContextUsage or null if session is not registered
   */
  getUsage(sessionId: string, currentTranscriptSize: number): ContextUsage | null {
    if (!this.config.enabled) return null;

    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const now = Date.now();

    // Lazy model detection — re-check ambiguous models every REDETECT_INTERVAL_MS
    if (session.contextLimit === null) {
      const timeSinceLastAttempt = now - session.lastDetectAttempt;
      if (timeSinceLastAttempt >= REDETECT_INTERVAL_MS || session.lastDetectAttempt === 0) {
        session.lastDetectAttempt = now;
        try {
          session.contextLimit = detectContextLimit(
            session.transcriptPath,
            this.config.context_limit
          );
        } catch (err) {
          logWarn('context-monitor', `detectContextLimit failed: ${getErrorMessage(err)}`);
        }
      }
    }

    // Still ambiguous — don't advise yet (avoids feedback loop)
    if (session.contextLimit === null) {
      return {
        session_id: sessionId,
        tokens_used: 0,
        tokens_limit: null,
        usage_percent: 0,
        should_compact: false,
        urgency: 'none',
        cooldown_active: false,
      };
    }

    const activeBytes = Math.max(0, currentTranscriptSize - session.compactOffset);

    // Primary: real input_tokens from API responses after compact offset
    const latestInputTokens = getLatestInputTokens(session.transcriptPath, session.compactOffset);
    let tokensUsed: number;
    if (latestInputTokens > 0) {
      tokensUsed = latestInputTokens;
    } else {
      // Fallback: byte estimation (0.7 correction for JSONL envelope overhead)
      tokensUsed = Math.ceil((activeBytes * 0.7) / CHARS_PER_TOKEN);
    }

    const usagePercent = Math.min(100, (tokensUsed / session.contextLimit) * 100);
    const urgency = computeUrgency(usagePercent, this.config.threshold_percent);
    const shouldCompact = urgency !== 'none';

    const cooldownMs = this.config.cooldown_seconds * 1000;
    const cooldownActive = session.lastAdvisoryAt > 0 && now - session.lastAdvisoryAt < cooldownMs;

    // Preemptive extraction at high+ urgency (async, non-blocking, per-session lock)
    if (
      shouldCompact &&
      !cooldownActive &&
      (urgency === 'high' || urgency === 'critical') &&
      this.config.preemptive_extract &&
      !session.extractionInFlight &&
      this.onPreemptiveExtract
    ) {
      session.extractionInFlight = true;
      this.onPreemptiveExtract(sessionId, session.transcriptPath)
        .catch((err) => {
          logWarn(
            'context-monitor',
            `Preemptive extraction failed for ${sessionId}: ${getErrorMessage(err)}`
          );
        })
        .finally(() => {
          const s = this.sessions.get(sessionId);
          if (s) s.extractionInFlight = false;
        });
    }

    return {
      session_id: sessionId,
      tokens_used: tokensUsed,
      tokens_limit: session.contextLimit,
      usage_percent: Math.round(usagePercent * 10) / 10,
      should_compact: shouldCompact,
      urgency,
      cooldown_active: cooldownActive,
    };
  }
}
