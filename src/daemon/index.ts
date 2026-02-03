/**
 * Daemon Module Exports
 *
 * Unified daemon for succ:
 * - Multi-session tracking
 * - Idle watcher with per-session reflection
 * - HTTP API for MCP/CLI/hooks
 */

export { createSessionManager, createIdleWatcher, type SessionState, type SessionManager, type IdleWatcher, type ActivityType } from './sessions.js';
export { startDaemon, shutdownDaemon, type DaemonConfig, type DaemonState } from './service.js';
export { createDaemonClient, getDaemonPort, getDaemonPid, ensureDaemonRunning, getDaemonStatus, type DaemonClient, type DaemonHealth, type SessionInfo } from './client.js';
