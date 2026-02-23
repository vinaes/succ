import { z } from 'zod';

import { ValidationError } from '../../lib/errors.js';
import type { Memory } from '../../lib/storage/types.js';
import type { SessionManager } from '../sessions.js';

export interface DaemonConfig {
  port_range_start: number;
  idle_minutes: number;
  check_interval_seconds: number;
  reflection_cooldown_minutes: number;
}

export interface DaemonState {
  cwd: string;
  startedAt: number;
  port: number;
  server: import('http').Server | null;
}

export type RequestBody = Record<string, unknown>;
export type RememberInFlightResult = {
  success: boolean;
  id?: number;
  isDuplicate?: boolean;
  reason?: string;
  score?: number;
};

export interface HookRulesCache {
  memories: Memory[];
  timestamp: number;
}

export interface RouteContext {
  state: DaemonState | null;
  sessionManager: SessionManager | null;
  log: (message: string) => void;
  checkShutdown: () => void;
  clearBriefingCache: (sessionId: string) => void;
  appendToProgressFile: (sessionId: string, briefing: string) => void;
  readTailTranscript: (transcriptPath: string, maxBytes?: number) => string;
  getProgressFilePath: (sessionId: string) => string;
}

export type RouteHandler = (body: unknown, searchParams: URLSearchParams) => Promise<unknown>;
export type RouteMap = Record<string, RouteHandler>;

export const EmptyBodySchema = z.object({}).passthrough();
export const SessionRegisterSchema = z.object({
  session_id: z.string().min(1),
  transcript_path: z.string().optional(),
  is_service: z.boolean().optional(),
});
export const SessionUnregisterSchema = z.object({
  session_id: z.string().min(1),
  transcript_path: z.string().optional(),
  run_reflection: z.boolean().optional(),
});
export const SessionActivitySchema = z.object({
  session_id: z.string().min(1),
  type: z.enum(['user_prompt', 'stop']),
  transcript_path: z.string().optional(),
  is_service: z.boolean().optional(),
});
export const SearchBodySchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().optional(),
  threshold: z.number().optional(),
});
export const RecallBodySchema = z.object({
  query: z.string().optional(),
  limit: z.number().int().positive().optional(),
});
export const RecallByTagSchema = z.object({
  tag: z.string().min(1),
  limit: z.number().int().positive().optional(),
});
export const HookRulesSchema = z.object({
  tool_name: z.string().min(1),
  tool_input: z.unknown().optional(),
});
export const RememberBodySchema = z.object({
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  type: z.string().optional(),
  source: z.string().optional(),
  global: z.boolean().optional(),
  valid_from: z.string().optional(),
  valid_until: z.string().optional(),
});
export const ReflectBodySchema = z.object({
  session_id: z.string().optional(),
});
export const BriefingBodySchema = z.object({
  transcript: z.string().optional(),
  transcript_path: z.string().optional(),
  session_id: z.string().optional(),
  format: z.enum(['structured', 'prose', 'minimal']).optional(),
  include_learnings: z.boolean().optional(),
  include_memories: z.boolean().optional(),
  max_memories: z.number().int().positive().optional(),
  use_cache: z.boolean().optional(),
});
export const WatchStartSchema = z.object({
  patterns: z.array(z.string()).optional(),
  includeCode: z.boolean().optional(),
});
export const WatchIndexSchema = z.object({
  file: z.string().min(1),
});
export const AnalyzeStartSchema = z.object({
  intervalMinutes: z.number().int().positive().optional(),
  mode: z.enum(['claude', 'api']).optional(),
});
export const AnalyzeSchema = z.object({
  mode: z.enum(['claude', 'api']).optional(),
});
export const SkillsSuggestSchema = z.object({
  prompt: z.string().min(1),
  limit: z.number().int().positive().optional(),
});
export const SkillsTrackSchema = z.object({
  skill_name: z.string().min(1),
});

export function parseRequestBody<T>(
  schema: z.ZodType<T>,
  body: unknown,
  fallbackMessage?: string
): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const issueMessage = parsed.error.issues[0]?.message;
    throw new ValidationError(fallbackMessage ?? issueMessage ?? 'Invalid request body');
  }
  return parsed.data;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function requireSessionManager(ctx: RouteContext): SessionManager {
  if (!ctx.sessionManager) {
    throw new ValidationError('Session manager not initialized');
  }
  return ctx.sessionManager;
}
