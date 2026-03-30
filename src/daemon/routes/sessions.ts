import * as fs from 'fs';
import * as path from 'path';
import { getStorageDispatcher } from '../../lib/storage/index.js';
import { getAutoCompactConfig, getSuccDir } from '../../lib/config.js';
import { getErrorMessage } from '../../lib/errors.js';
import { logWarn } from '../../lib/fault-logger.js';
import { removeObservations } from '../../lib/session-observations.js';
import { flushBudgets, removeBudget } from '../../lib/token-budget.js';
import { processSessionEnd } from '../session-processor.js';
import { ContextMonitor } from '../../lib/context-monitor.js';
import { detectContextLimit, readTranscriptTail } from '../../lib/context-limits.js';
import { extractSessionSummary } from '../../lib/session-summary.js';
import type { SessionState } from '../sessions.js';
import {
  parseRequestBody,
  requireSessionManager,
  SessionActivitySchema,
  SessionRegisterSchema,
  SessionUnregisterSchema,
  type RouteContext,
  type RouteMap,
} from './types.js';

// ── Module-level ContextMonitor instance ──────────────────────────────────────

let _contextMonitor: ContextMonitor | null = null;

export function getContextMonitor(): ContextMonitor {
  if (!_contextMonitor) {
    const cfg = getAutoCompactConfig();
    _contextMonitor = new ContextMonitor(cfg, async (sessionId, transcriptPath) => {
      // Preemptive extraction: extract memories before compaction at high pressure
      // Use readTranscriptTail (last 200KB) — enough for extraction, avoids loading huge files
      try {
        const content = readTranscriptTail(transcriptPath, 200_000);
        if (content.length > 200) {
          await extractSessionSummary(content, { verbose: false });
        }
      } catch (err) {
        logWarn(
          'context-monitor',
          `Preemptive extraction error for ${sessionId}: ${getErrorMessage(err)}`
        );
      }
    });
  }
  return _contextMonitor;
}

/** Reset monitor (used in tests). */
export function resetContextMonitor(): void {
  _contextMonitor = null;
}

/** Strict session ID validator — returns null for IDs that would collide after normalization. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
function validateSessionId(raw: string): string | null {
  return SESSION_ID_RE.test(raw) ? raw : null;
}

/** Path for persisting pre-compact stats (survives session unregister + daemon restart). */
function preCompactStatsPath(sessionId: string): string {
  const safe = validateSessionId(sessionId);
  if (!safe) throw new Error(`Invalid session ID: ${sessionId}`);
  const tmpDir = path.join(getSuccDir(), '.tmp');
  return path.join(tmpDir, `session-${safe}-pre-compact.json`);
}

export function sessionRoutes(ctx: RouteContext): RouteMap {
  return {
    'POST /api/session/register': async (body) => {
      const {
        session_id,
        transcript_path = '',
        is_service = false,
      } = parseRequestBody(SessionRegisterSchema, body, 'session_id required');
      const manager = requireSessionManager(ctx);
      const session = manager.register(session_id, transcript_path || '', is_service);
      // Register with ContextMonitor (skips service sessions)
      if (!is_service && transcript_path) {
        getContextMonitor().registerSession(session_id, transcript_path);
      }
      ctx.log(`[session] Registered: ${session_id}${is_service ? ' (service)' : ''}`);

      // Include detected model info in response for hook logging (best-effort)
      let detectedContextLimit: string | null = null;
      if (!is_service && transcript_path) {
        try {
          const autoCompactCfg = getAutoCompactConfig();
          const cfgLimit =
            autoCompactCfg.context_limit > 0 ? autoCompactCfg.context_limit : undefined;
          const limit = detectContextLimit(transcript_path, cfgLimit);
          if (limit !== null) detectedContextLimit = String(limit);
        } catch (err) {
          logWarn('sessions', `model detection failed: ${getErrorMessage(err)}`);
        }
      }
      return { success: true, session, detected_context_limit: detectedContextLimit };
    },

    'POST /api/session/unregister': async (body) => {
      const { session_id, transcript_path, run_reflection } = parseRequestBody(
        SessionUnregisterSchema,
        body,
        'session_id required'
      );

      const manager = requireSessionManager(ctx);
      const session = manager.get(session_id);
      const transcriptFile = transcript_path || session?.transcriptPath || '';

      try {
        const dispatcher = await getStorageDispatcher();
        await dispatcher.flushSessionCounters('daemon-session');
      } catch (err) {
        ctx.log(`[session] Failed to flush session counters: ${getErrorMessage(err)}`);
      }

      getContextMonitor().unregisterSession(session_id);
      const removed = manager.unregister(session_id);
      ctx.clearBriefingCache(session_id);
      removeBudget(session_id);
      removeObservations(session_id);
      flushBudgets();
      ctx.log(`[session] Unregistered: ${session_id} (removed=${removed})`);

      if (run_reflection && transcriptFile) {
        manager.incrementPendingWork();
        ctx.log(`[session] Queuing async processing for ${session_id}`);

        void (async () => {
          try {
            const result = await processSessionEnd(transcriptFile, session_id, ctx.log);
            ctx.log(
              `[session] Processing complete for ${session_id}: summary=${result.summary.length}chars, learnings=${result.learnings.length}, saved=${result.saved}`
            );
          } catch (err) {
            ctx.log(`[session] Processing failed for ${session_id}: ${getErrorMessage(err)}`);
          } finally {
            manager.decrementPendingWork();
            ctx.checkShutdown();
          }
        })();
      } else {
        ctx.checkShutdown();
      }

      return { success: removed, remaining_sessions: manager.count() };
    },

    'POST /api/session/activity': async (body) => {
      const {
        session_id,
        type,
        transcript_path,
        is_service = false,
      } = parseRequestBody(SessionActivitySchema, body, 'session_id and type required');
      const manager = requireSessionManager(ctx);

      const session = manager.activity(session_id, type);
      if (!session) {
        manager.register(session_id, transcript_path || '', is_service);
        manager.activity(session_id, type);
        ctx.log(
          `[session] Auto-registered and activity: ${session_id} (${type})${is_service ? ' (service)' : ''}`
        );
      } else if (transcript_path && !session.transcriptPath) {
        (session as SessionState).transcriptPath = transcript_path;
        ctx.log(`[session] Activity: ${session_id} (${type}) + updated transcript`);
      } else {
        ctx.log(`[session] Activity: ${session_id} (${type})`);
      }

      return { success: true };
    },

    'GET /api/sessions': async (_body, searchParams) => {
      const includeService = searchParams.get('includeService') === 'true';
      const manager = requireSessionManager(ctx);
      const sessions: Record<string, SessionState> = {};
      for (const [id, session] of manager.getAll(includeService)) {
        sessions[id] = session;
      }
      return { sessions, count: manager.count(includeService) };
    },

    'POST /api/hooks/pre-compact': async (body) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { success: false, error: 'invalid pre-compact payload' };
      }
      const stats = body as Record<string, unknown>;
      // Payload size guard — pre-compact stats should be small
      const payloadSize = Buffer.byteLength(JSON.stringify(stats), 'utf8');
      if (payloadSize > 64_000) {
        ctx.log(`[pre-compact] Rejected oversized payload: ${payloadSize} bytes`);
        return { success: false, error: 'payload too large' };
      }
      const sessionId = (stats.sessionId as string) || 'unknown';
      if (!validateSessionId(sessionId)) {
        ctx.log(`[pre-compact] Rejected invalid session_id: ${sessionId}`);
        return { success: false, error: 'invalid session_id' };
      }

      // Persist to disk so stats survive session unregister and daemon restarts
      try {
        const statsFile = preCompactStatsPath(sessionId);
        const dir = path.dirname(statsFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(statsFile, JSON.stringify(stats), 'utf-8');
      } catch (err) {
        ctx.log(
          `[pre-compact] Failed to persist stats: ${err instanceof Error ? err.message : err}`
        );
      }

      // Also attach to live session for fast reads during active session
      const manager = requireSessionManager(ctx);
      const session = manager.get(sessionId);
      if (session) {
        (session as SessionState & { preCompactStats?: unknown }).preCompactStats = stats;
      }

      // Notify ContextMonitor so it resets usage offset post-compact.
      // Use the ACTUAL post-compact transcript size (not the pre-compact
      // transcriptBytes from stats) — after compaction the transcript is
      // rewritten and shrinks, so using the old size would make
      // (currentSize - compactOffset) go negative until the file grows past
      // its previous length.
      const manager2 = requireSessionManager(ctx);
      const compactSession = manager2.get(sessionId);
      const compactTranscriptPath = compactSession?.transcriptPath || '';
      let postCompactSize = 0;
      if (compactTranscriptPath) {
        try {
          postCompactSize = fs.statSync(compactTranscriptPath).size;
        } catch (err) {
          logWarn(
            'sessions',
            `Failed to stat transcript after compact for ${sessionId}: ${getErrorMessage(err)}`
          );
        }
      }
      if (postCompactSize > 0) {
        getContextMonitor().recordCompact(sessionId, postCompactSize, compactTranscriptPath);
        ctx.log(
          `[pre-compact] ContextMonitor offset reset to ${postCompactSize} bytes (post-compact actual size)`
        );
      } else {
        // Fallback: reset offset to 0 so usage starts fresh
        getContextMonitor().recordCompact(sessionId, 0, compactTranscriptPath);
        ctx.log(`[pre-compact] ContextMonitor offset reset to 0 (transcript not found or empty)`);
      }

      ctx.log(
        `[pre-compact] Stored stats for session ${sessionId}: ${(stats.tokenTotals as Record<string, number>)?.total || 0} total tokens`
      );
      return { success: true };
    },

    'GET /api/context-usage': async (_body, searchParams) => {
      const sessionId = searchParams.get('session_id') || '';
      if (!sessionId) return { error: 'session_id required' };
      if (!validateSessionId(sessionId)) return { error: 'invalid session_id' };

      const manager = requireSessionManager(ctx);
      const session = manager.get(sessionId);
      if (!session?.transcriptPath) {
        return { error: 'session not found or no transcript' };
      }

      // O(1) stat for transcript size
      let transcriptSize = 0;
      try {
        transcriptSize = fs.statSync(session.transcriptPath).size;
      } catch (err) {
        logWarn('sessions', `Failed to stat transcript for ${sessionId}: ${getErrorMessage(err)}`);
      }

      // Ensure session is registered with ContextMonitor (handles auto-registered sessions)
      getContextMonitor().registerSession(sessionId, session.transcriptPath);

      const usage = getContextMonitor().getUsage(sessionId, transcriptSize);
      if (!usage) {
        return { error: 'context monitoring not enabled' };
      }
      return usage;
    },

    'POST /api/context-usage/ack': async (_body, searchParams) => {
      const sessionId = searchParams.get('session_id') || '';
      if (!sessionId) return { error: 'session_id required' };
      if (!validateSessionId(sessionId)) return { error: 'invalid session_id' };
      const acked = getContextMonitor().markAdvisory(sessionId);
      return { success: acked };
    },

    'GET /api/session/stats': async (_body, searchParams) => {
      const sessionId = searchParams.get('session_id') || '';
      if (!sessionId) return { error: 'session_id required' };
      if (!validateSessionId(sessionId)) return { error: 'invalid session_id' };

      // Fast path: live session in memory
      const manager = requireSessionManager(ctx);
      const session = manager.get(sessionId) as
        | (SessionState & { preCompactStats?: unknown })
        | null;
      if (session?.preCompactStats) {
        return { stats: session.preCompactStats };
      }

      // Fallback: read from persisted file (survives unregister + restart)
      try {
        const statsFile = preCompactStatsPath(sessionId);
        if (fs.existsSync(statsFile)) {
          return { stats: JSON.parse(fs.readFileSync(statsFile, 'utf-8')) };
        }
      } catch (err) {
        logWarn(
          'sessions',
          `Failed to read pre-compact stats for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return { stats: null };
    },
  };
}
