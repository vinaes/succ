import * as fs from 'fs';
import { getAnalyzerStatus } from '../analyzer.js';
import { getWatcherStatus } from '../watcher.js';
import { getMemoryStats, getStats } from '../../lib/storage/index.js';
import { logWarn } from '../../lib/fault-logger.js';
import { getErrorMessage } from '../../lib/errors.js';
import { getContextMonitor } from './sessions.js';
import { requireSessionManager, type RouteContext, type RouteMap } from './types.js';

export function statusRoutes(ctx: RouteContext): RouteMap {
  return {
    'GET /health': async () => ({
      status: 'ok',
      pid: process.pid,
      uptime: Date.now() - (ctx.state?.startedAt || Date.now()),
      activeSessions: ctx.sessionManager?.count() || 0,
      cwd: ctx.state?.cwd || process.cwd(),
    }),

    'GET /api/status': async () => {
      const stats = await getStats();
      const memStats = await getMemoryStats();
      const watchStatus = getWatcherStatus();
      const analyzeStatus = getAnalyzerStatus();
      const manager = requireSessionManager(ctx);

      // Collect per-session context usage for all active sessions
      const contextUsageMap: Record<string, unknown> = {};
      try {
        const monitor = getContextMonitor();
        for (const [sessionId, session] of manager.sessions) {
          if (session.isService) continue;
          if (!session.transcriptPath) continue;
          try {
            let size = 0;
            try {
              size = fs.statSync(session.transcriptPath).size;
            } catch (err) {
              logWarn(
                'status',
                `Failed to stat transcript for ${sessionId}: ${getErrorMessage(err)}`
              );
            }
            const usage = monitor.peekUsage(sessionId, size);
            if (usage) contextUsageMap[sessionId] = usage;
          } catch (err) {
            logWarn(
              'status',
              `Failed to get usage for session ${sessionId}: ${getErrorMessage(err)}`
            );
          }
        }
      } catch (err) {
        logWarn('status', `Failed to collect context usage: ${getErrorMessage(err)}`);
      }

      return {
        daemon: {
          pid: process.pid,
          uptime: Date.now() - (ctx.state?.startedAt || Date.now()),
          sessions: manager.count(),
        },
        index: stats,
        memories: memStats,
        services: {
          watch: watchStatus,
          analyze: analyzeStatus,
        },
        context_usage: contextUsageMap,
      };
    },

    'GET /api/services': async () => {
      const manager = requireSessionManager(ctx);
      return {
        watch: getWatcherStatus(),
        analyze: getAnalyzerStatus(),
        idle: {
          enabled: true,
          sessions: manager.count(),
        },
      };
    },
  };
}
