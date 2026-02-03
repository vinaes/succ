/**
 * Multi-Session Tracking for Daemon
 *
 * Tracks multiple Claude Code sessions per project:
 * - Each session has own idle timer and reflection state
 * - Daemon exits only when ALL sessions ended
 * - Session ID = transcript filename (UUID)
 */

import { getIdleWatcherConfig } from '../lib/config.js';

// ============================================================================
// Types
// ============================================================================

export interface SessionState {
  transcriptPath: string;
  registeredAt: number;
  lastActivity: number;
  lastActivityType: 'user_prompt' | 'stop' | null;
  lastReflection: number;
  reflectionCount: number;
  isService?: boolean;
  hadUserPrompt?: boolean;  // True if session ever received user_prompt activity
}

export type ActivityType = 'user_prompt' | 'stop';

export interface SessionManager {
  sessions: Map<string, SessionState>;
  register(sessionId: string, transcriptPath: string, isService?: boolean): SessionState;
  unregister(sessionId: string): boolean;
  activity(sessionId: string, type: ActivityType): SessionState | null;
  get(sessionId: string): SessionState | null;
  getAll(includeService?: boolean): Map<string, SessionState>;
  count(includeService?: boolean): number;
  isEmpty(): boolean;
  getIdleSessions(idleMinutes: number): Array<{ sessionId: string; session: SessionState }>;
  markReflection(sessionId: string): void;
}

// ============================================================================
// Session Manager Implementation
// ============================================================================

export function createSessionManager(): SessionManager {
  const sessions = new Map<string, SessionState>();

  return {
    sessions,

    register(sessionId: string, transcriptPath: string, isService = false): SessionState {
      const now = Date.now();
      const session: SessionState = {
        transcriptPath,
        registeredAt: now,
        lastActivity: now,
        lastActivityType: null,
        lastReflection: 0,
        reflectionCount: 0,
        isService,
      };
      sessions.set(sessionId, session);
      return session;
    },

    unregister(sessionId: string): boolean {
      return sessions.delete(sessionId);
    },

    activity(sessionId: string, type: ActivityType): SessionState | null {
      const session = sessions.get(sessionId);
      if (!session) return null;

      session.lastActivity = Date.now();
      session.lastActivityType = type;
      if (type === 'user_prompt') {
        session.hadUserPrompt = true;
      }
      return session;
    },

    get(sessionId: string): SessionState | null {
      return sessions.get(sessionId) || null;
    },

    getAll(includeService = false): Map<string, SessionState> {
      if (includeService) {
        return sessions;
      }
      const filtered = new Map<string, SessionState>();
      for (const [id, session] of sessions) {
        // Auto-detect: session is "service" if explicitly marked OR never had user_prompt
        const isServiceSession = session.isService || !session.hadUserPrompt;
        if (!isServiceSession) {
          filtered.set(id, session);
        }
      }
      return filtered;
    },

    count(includeService = false): number {
      if (includeService) {
        return sessions.size;
      }
      let count = 0;
      for (const session of sessions.values()) {
        const isServiceSession = session.isService || !session.hadUserPrompt;
        if (!isServiceSession) count++;
      }
      return count;
    },

    isEmpty(): boolean {
      return sessions.size === 0;
    },

    /**
     * Get sessions that are idle (last activity type = 'stop' and idle time exceeded)
     */
    getIdleSessions(idleMinutes: number): Array<{ sessionId: string; session: SessionState }> {
      const now = Date.now();
      const idleMs = idleMinutes * 60 * 1000;
      const result: Array<{ sessionId: string; session: SessionState }> = [];

      for (const [sessionId, session] of sessions) {
        // Skip service sessions - they don't need reflection
        if (session.isService) continue;

        // Only consider sessions that ended with 'stop' (assistant finished responding)
        if (session.lastActivityType === 'stop') {
          const timeSinceActivity = now - session.lastActivity;
          if (timeSinceActivity >= idleMs) {
            result.push({ sessionId, session });
          }
        }
      }

      return result;
    },

    markReflection(sessionId: string): void {
      const session = sessions.get(sessionId);
      if (session) {
        session.lastReflection = Date.now();
        session.reflectionCount++;
      }
    },
  };
}

// ============================================================================
// Idle Watcher
// ============================================================================

export interface IdleWatcher {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  checkNow(): Promise<void>;
}

export interface IdleWatcherOptions {
  sessionManager: SessionManager;
  onIdle: (sessionId: string, session: SessionState) => Promise<void>;
  checkIntervalSeconds?: number;
  idleMinutes?: number;
  reflectionCooldownMinutes?: number;
  log?: (message: string) => void;
}

export function createIdleWatcher(options: IdleWatcherOptions): IdleWatcher {
  const {
    sessionManager,
    onIdle,
    log = console.log,
  } = options;

  // Get config with defaults
  const watcherConfig = getIdleWatcherConfig();
  const checkIntervalSeconds = options.checkIntervalSeconds ?? watcherConfig.check_interval;
  const idleMinutes = options.idleMinutes ?? watcherConfig.idle_minutes;
  const cooldownMinutes = options.reflectionCooldownMinutes ?? watcherConfig.reflection_cooldown_minutes;

  let intervalId: NodeJS.Timeout | null = null;

  async function check(): Promise<void> {
    const idleSessions = sessionManager.getIdleSessions(idleMinutes);

    for (const { sessionId, session } of idleSessions) {
      // Check reflection cooldown
      const timeSinceReflection = Date.now() - session.lastReflection;
      const cooldownMs = cooldownMinutes * 60 * 1000;

      if (session.lastReflection === 0 || timeSinceReflection >= cooldownMs) {
        log(`[idle-watcher] Session ${sessionId} is idle, triggering reflection`);
        try {
          await onIdle(sessionId, session);
          sessionManager.markReflection(sessionId);
        } catch (err) {
          log(`[idle-watcher] Reflection failed for ${sessionId}: ${err}`);
        }
      }
    }
  }

  return {
    start(): void {
      if (intervalId) return;
      log(`[idle-watcher] Starting (check every ${checkIntervalSeconds}s, idle after ${idleMinutes}min)`);
      intervalId = setInterval(() => check().catch(console.error), checkIntervalSeconds * 1000);
    },

    stop(): void {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        log('[idle-watcher] Stopped');
      }
    },

    isRunning(): boolean {
      return intervalId !== null;
    },

    async checkNow(): Promise<void> {
      await check();
    },
  };
}
