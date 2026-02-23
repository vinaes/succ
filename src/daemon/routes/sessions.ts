import { getStorageDispatcher } from '../../lib/storage/index.js';
import { removeObservations } from '../../lib/session-observations.js';
import { flushBudgets, removeBudget } from '../../lib/token-budget.js';
import { processSessionEnd } from '../session-processor.js';
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
      ctx.log(`[session] Registered: ${session_id}${is_service ? ' (service)' : ''}`);
      return { success: true, session };
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
        ctx.log(`[session] Failed to flush session counters: ${err}`);
      }

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
            ctx.log(`[session] Processing failed for ${session_id}: ${err}`);
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

      let session = manager.activity(session_id, type);
      if (!session) {
        manager.register(session_id, transcript_path || '', is_service);
        session = manager.activity(session_id, type);
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
  };
}
