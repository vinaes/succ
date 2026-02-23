import { getAnalyzerStatus } from '../analyzer.js';
import { getWatcherStatus } from '../watcher.js';
import { getMemoryStats, getStats } from '../../lib/storage/index.js';
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
