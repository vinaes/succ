import { indexFileOnDemand, startWatcher, stopWatcher, getWatcherStatus } from '../watcher.js';
import {
  EmptyBodySchema,
  parseRequestBody,
  WatchIndexSchema,
  WatchStartSchema,
  type RouteContext,
  type RouteMap,
} from './types.js';

export function watcherRoutes(ctx: RouteContext): RouteMap {
  return {
    'POST /api/watch/start': async (body) => {
      const { patterns, includeCode } = parseRequestBody(WatchStartSchema, body);
      const watchState = await startWatcher({ patterns, includeCode }, ctx.log);
      return {
        success: true,
        active: watchState.active,
        patterns: watchState.patterns,
        includeCode: watchState.includeCode,
      };
    },

    'POST /api/watch/stop': async (body) => {
      parseRequestBody(EmptyBodySchema, body);
      await stopWatcher(ctx.log);
      return { success: true };
    },

    'GET /api/watch/status': async () => getWatcherStatus(),

    'POST /api/watch/index': async (body) => {
      const { file } = parseRequestBody(WatchIndexSchema, body, 'file required');
      await indexFileOnDemand(file, ctx.log);
      return { success: true, file };
    },
  };
}
