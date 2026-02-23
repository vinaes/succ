import { getAnalyzerStatus, startAnalyzer, stopAnalyzer, triggerAnalysis } from '../analyzer.js';
import {
  AnalyzeSchema,
  AnalyzeStartSchema,
  EmptyBodySchema,
  parseRequestBody,
  type RouteContext,
  type RouteMap,
} from './types.js';

export function analyzerRoutes(ctx: RouteContext): RouteMap {
  return {
    'POST /api/analyze/start': async (body) => {
      const { intervalMinutes, mode } = parseRequestBody(AnalyzeStartSchema, body);
      const analyzeState = startAnalyzer({ intervalMinutes, mode }, ctx.log);
      return {
        success: true,
        active: analyzeState.active,
        runsCompleted: analyzeState.runsCompleted,
      };
    },

    'POST /api/analyze/stop': async (body) => {
      parseRequestBody(EmptyBodySchema, body);
      stopAnalyzer(ctx.log);
      return { success: true };
    },

    'GET /api/analyze/status': async () => getAnalyzerStatus(),

    'POST /api/analyze': async (body) => {
      const { mode = 'claude' } = parseRequestBody(AnalyzeSchema, body);
      await triggerAnalysis(mode, ctx.log);
      return { success: true };
    },
  };
}
