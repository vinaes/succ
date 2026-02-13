/**
 * Daemon HTTP Client
 *
 * Client library for communicating with the succ daemon.
 * Used by MCP server, hooks, and CLI commands.
 *
 * Features:
 * - Auto-detect daemon port from .succ/.tmp/daemon.port
 * - Health check before operations
 * - Graceful fallback when daemon unavailable
 */

import fs from 'fs';
import path from 'path';
import { getSuccDir, getProjectRoot } from '../lib/config.js';
import { NetworkError } from '../lib/errors.js';
import { logWarn } from '../lib/fault-logger.js';

// ============================================================================
// Types
// ============================================================================

export interface DaemonHealth {
  status: string;
  pid: number;
  uptime: number;
  activeSessions: number;
  cwd: string;
}

export interface SessionInfo {
  transcriptPath: string;
  registeredAt: number;
  lastActivity: number;
  lastActivityType: 'user_prompt' | 'stop' | null;
  lastReflection: number;
  reflectionCount: number;
  isService?: boolean;
}

export interface DaemonClient {
  isRunning(): Promise<boolean>;
  getHealth(): Promise<DaemonHealth | null>;
  getPort(): number | null;

  // Session management
  registerSession(sessionId: string, transcriptPath: string, isService?: boolean): Promise<boolean>;
  unregisterSession(
    sessionId: string,
    runReflection?: boolean
  ): Promise<{ success: boolean; remaining_sessions: number }>;
  sessionActivity(
    sessionId: string,
    type: 'user_prompt' | 'stop',
    transcriptPath?: string,
    isService?: boolean
  ): Promise<boolean>;
  getSessions(includeService?: boolean): Promise<Record<string, SessionInfo>>;

  // Data operations
  search(query: string, limit?: number, threshold?: number): Promise<any[]>;
  searchCode(query: string, limit?: number): Promise<any[]>;
  recall(
    query: string,
    options?: { tags?: string[]; since?: string; limit?: number; as_of_date?: string }
  ): Promise<any[]>;
  remember(
    content: string,
    options?: {
      tags?: string[];
      type?: string;
      global?: boolean;
      valid_from?: string;
      valid_until?: string;
    }
  ): Promise<{ success: boolean; id?: number; isDuplicate?: boolean }>;

  // Reflection
  triggerReflection(sessionId?: string, force?: boolean): Promise<boolean>;

  // Status
  getStatus(): Promise<any>;
}

// ============================================================================
// File Paths
// ============================================================================

function getDaemonPortFile(projectDir?: string): string {
  const succDir = projectDir ? path.join(projectDir, '.succ') : getSuccDir();
  return path.join(succDir, '.tmp', 'daemon.port');
}

function getDaemonPidFile(projectDir?: string): string {
  const succDir = projectDir ? path.join(projectDir, '.succ') : getSuccDir();
  return path.join(succDir, '.tmp', 'daemon.pid');
}

// ============================================================================
// Port Detection
// ============================================================================

/**
 * Get daemon port from port file
 */
export function getDaemonPort(projectDir?: string): number | null {
  const portFile = getDaemonPortFile(projectDir);

  if (!fs.existsSync(portFile)) {
    return null;
  }

  try {
    const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
    if (isNaN(port) || port <= 0) {
      return null;
    }
    return port;
  } catch (err) {
    logWarn('daemon-client', 'Failed to read daemon port file', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Get daemon PID from PID file
 */
export function getDaemonPid(projectDir?: string): number | null {
  const pidFile = getDaemonPidFile(projectDir);

  if (!fs.existsSync(pidFile)) {
    return null;
  }

  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (isNaN(pid) || pid <= 0) {
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

// ============================================================================
// HTTP Helpers
// ============================================================================

async function httpGet(port: number, path: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'GET',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new NetworkError(`HTTP ${response.status}`, response.status);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function httpPost(port: number, path: string, body: any): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new NetworkError(`HTTP ${response.status}: ${text}`, response.status);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================================
// Client Implementation
// ============================================================================

/**
 * Create a daemon client for the current project
 */
export function createDaemonClient(projectDir?: string): DaemonClient {
  const resolvedProjectDir = projectDir || getProjectRoot();

  return {
    getPort(): number | null {
      return getDaemonPort(resolvedProjectDir);
    },

    async isRunning(): Promise<boolean> {
      const port = getDaemonPort(resolvedProjectDir);
      if (!port) return false;

      try {
        const health = await httpGet(port, '/health');
        return health?.status === 'ok';
      } catch (err) {
        logWarn('daemon-client', 'Daemon health check failed (isRunning)', {
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },

    async getHealth(): Promise<DaemonHealth | null> {
      const port = getDaemonPort(resolvedProjectDir);
      if (!port) return null;

      try {
        return await httpGet(port, '/health');
      } catch (err) {
        logWarn('daemon-client', 'Daemon call failed: getHealth', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },

    // Session management
    async registerSession(
      sessionId: string,
      transcriptPath: string,
      isService = false
    ): Promise<boolean> {
      const port = getDaemonPort(resolvedProjectDir);
      if (!port) return false;

      try {
        const result = await httpPost(port, '/api/session/register', {
          session_id: sessionId,
          transcript_path: transcriptPath,
          is_service: isService,
        });
        return result?.success === true;
      } catch (err) {
        logWarn('daemon-client', 'Daemon call failed: registerSession', {
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },

    async unregisterSession(
      sessionId: string,
      runReflection = false
    ): Promise<{ success: boolean; remaining_sessions: number }> {
      const port = getDaemonPort(resolvedProjectDir);
      if (!port) return { success: false, remaining_sessions: -1 };

      try {
        return await httpPost(port, '/api/session/unregister', {
          session_id: sessionId,
          run_reflection: runReflection,
        });
      } catch {
        return { success: false, remaining_sessions: -1 };
      }
    },

    async sessionActivity(
      sessionId: string,
      type: 'user_prompt' | 'stop',
      transcriptPath?: string,
      isService = false
    ): Promise<boolean> {
      const port = getDaemonPort(resolvedProjectDir);
      if (!port) return false;

      try {
        const result = await httpPost(port, '/api/session/activity', {
          session_id: sessionId,
          type,
          transcript_path: transcriptPath,
          is_service: isService,
        });
        return result?.success === true;
      } catch {
        return false;
      }
    },

    async getSessions(includeService = false): Promise<Record<string, SessionInfo>> {
      const port = getDaemonPort(resolvedProjectDir);
      if (!port) return {};

      try {
        const endpoint = includeService ? '/api/sessions?includeService=true' : '/api/sessions';
        const result = await httpGet(port, endpoint);
        return result?.sessions || {};
      } catch {
        return {};
      }
    },

    // Data operations
    async search(query: string, limit = 5, threshold = 0.3): Promise<any[]> {
      const port = getDaemonPort(resolvedProjectDir);
      if (!port) return [];

      try {
        const result = await httpPost(port, '/api/search', { query, limit, threshold });
        return result?.results || [];
      } catch {
        return [];
      }
    },

    async searchCode(query: string, limit = 5): Promise<any[]> {
      const port = getDaemonPort(resolvedProjectDir);
      if (!port) return [];

      try {
        const result = await httpPost(port, '/api/search-code', { query, limit });
        return result?.results || [];
      } catch {
        return [];
      }
    },

    async recall(query: string, options = {}): Promise<any[]> {
      const port = getDaemonPort(resolvedProjectDir);
      if (!port) return [];

      try {
        const result = await httpPost(port, '/api/recall', { query, ...options });
        return result?.results || [];
      } catch (err) {
        logWarn('daemon-client', 'Daemon call failed: recall', {
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
    },

    async remember(
      content: string,
      options = {}
    ): Promise<{ success: boolean; id?: number; isDuplicate?: boolean }> {
      const port = getDaemonPort(resolvedProjectDir);
      if (!port) return { success: false };

      try {
        return await httpPost(port, '/api/remember', { content, ...options });
      } catch (err) {
        logWarn('daemon-client', 'Daemon call failed: remember', {
          error: err instanceof Error ? err.message : String(err),
        });
        return { success: false };
      }
    },

    // Reflection
    async triggerReflection(sessionId?: string, force = false): Promise<boolean> {
      const port = getDaemonPort(resolvedProjectDir);
      if (!port) return false;

      try {
        const result = await httpPost(port, '/api/reflect', { session_id: sessionId, force });
        return result?.success === true;
      } catch {
        return false;
      }
    },

    // Status
    async getStatus(): Promise<any> {
      const port = getDaemonPort(resolvedProjectDir);
      if (!port) return null;

      try {
        return await httpGet(port, '/api/status');
      } catch (err) {
        logWarn('daemon-client', 'Daemon call failed: getStatus', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Ensure daemon is running, starting it if necessary
 * Returns true if daemon is running after the call
 */
export async function ensureDaemonRunning(projectDir?: string): Promise<boolean> {
  const client = createDaemonClient(projectDir);

  // Check if already running
  if (await client.isRunning()) {
    return true;
  }

  // Try to start daemon
  try {
    const spawn = (await import('cross-spawn')).default;
    const resolvedProjectDir = projectDir || getProjectRoot();
    const servicePath = path.join(resolvedProjectDir, 'dist', 'daemon', 'service.js');

    // Spawn node directly with the service file
    const proc = spawn(process.execPath, ['--no-warnings', '--no-deprecation', servicePath], {
      cwd: resolvedProjectDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: '' }, // Clear any conflicting options
    });

    proc.unref();

    // Wait for daemon to start (max 5 seconds)
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (await client.isRunning()) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Check if daemon is running and return basic info
 */
export async function getDaemonStatus(projectDir?: string): Promise<{
  running: boolean;
  port: number | null;
  pid: number | null;
  health: DaemonHealth | null;
}> {
  const port = getDaemonPort(projectDir);
  const pid = getDaemonPid(projectDir);
  const client = createDaemonClient(projectDir);
  const health = await client.getHealth();

  return {
    running: health?.status === 'ok',
    port,
    pid,
    health,
  };
}
