/**
 * Daemon CLI Command
 *
 * Manage the succ daemon process:
 * - succ daemon status   - Show daemon status and active sessions
 * - succ daemon sessions - List all active sessions
 * - succ daemon start    - Start daemon (usually auto-started by hooks)
 * - succ daemon stop     - Stop daemon (warns if sessions active)
 * - succ daemon logs     - Show recent daemon logs
 */

import fs from 'fs';
import path from 'path';
import { createDaemonClient, getDaemonPort, getDaemonPid, getDaemonStatus, ensureDaemonRunning } from '../daemon/client.js';
import { getSuccDir } from '../lib/config.js';
import { logError } from '../lib/fault-logger.js';

export interface DaemonOptions {
  json?: boolean;
}

/**
 * Show daemon status
 */
export async function daemonStatus(options: DaemonOptions = {}): Promise<void> {
  const status = await getDaemonStatus();

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log('=== succ Daemon Status ===\n');

  if (status.running) {
    console.log(`Status:   Running`);
    console.log(`Port:     ${status.port}`);
    console.log(`PID:      ${status.pid}`);
    console.log(`Uptime:   ${formatUptime(status.health?.uptime || 0)}`);
    console.log(`Sessions: ${status.health?.activeSessions || 0}`);
    console.log(`CWD:      ${status.health?.cwd || 'unknown'}`);
  } else {
    console.log('Status:   Not running');
    if (status.port) {
      console.log(`Port file exists (${status.port}) but daemon not responding`);
    }
    if (status.pid) {
      console.log(`PID file exists (${status.pid}) but process may have crashed`);
    }
  }
}

/**
 * List active sessions
 */
export async function daemonSessions(options: DaemonOptions & { all?: boolean } = {}): Promise<void> {
  const client = createDaemonClient();

  if (!(await client.isRunning())) {
    console.log('Daemon is not running');
    return;
  }

  const sessions = await client.getSessions(options.all);
  const sessionList = Object.entries(sessions);

  if (options.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  console.log(`=== Active Sessions${options.all ? ' (including service)' : ''} ===\n`);

  if (sessionList.length === 0) {
    console.log('No active sessions');
    return;
  }

  for (const [id, session] of sessionList) {
    const idleTime = Date.now() - session.lastActivity;
    const idleStr = formatUptime(idleTime);
    const serviceTag = session.isService ? ' [service]' : '';

    console.log(`Session: ${id}${serviceTag}`);
    console.log(`  Transcript: ${session.transcriptPath || '(none)'}`);
    console.log(`  Registered: ${new Date(session.registeredAt).toLocaleString()}`);
    console.log(`  Last Activity: ${session.lastActivityType || 'none'} (${idleStr} ago)`);
    console.log(`  Reflections: ${session.reflectionCount}`);
    console.log('');
  }
}

/**
 * Start daemon
 */
export async function daemonStart(options: DaemonOptions = {}): Promise<void> {
  const client = createDaemonClient();

  if (await client.isRunning()) {
    const health = await client.getHealth();
    console.log(`Daemon already running on port ${health?.pid || 'unknown'}`);
    return;
  }

  console.log('Starting daemon...');

  const success = await ensureDaemonRunning();

  if (success) {
    const health = await client.getHealth();
    console.log(`Daemon started on port ${getDaemonPort()} (pid=${health?.pid})`);
  } else {
    logError('daemon-cmd', 'Failed to start daemon');
    console.error('Failed to start daemon');
    process.exit(1);
  }
}

/**
 * Stop daemon
 */
export async function daemonStop(options: DaemonOptions & { force?: boolean } = {}): Promise<void> {
  const client = createDaemonClient();

  if (!(await client.isRunning())) {
    console.log('Daemon is not running');

    // Clean up stale files
    cleanupDaemonFiles();
    return;
  }

  const sessions = await client.getSessions();
  const sessionCount = Object.keys(sessions).length;

  if (sessionCount > 0 && !options.force) {
    console.log(`Warning: ${sessionCount} active session(s)`);
    console.log('Use --force to stop anyway');
    return;
  }

  // Send unregister for all sessions to trigger graceful shutdown
  for (const sessionId of Object.keys(sessions)) {
    await client.unregisterSession(sessionId, false);
  }

  // If still running, kill the process
  const pid = getDaemonPid();
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Sent SIGTERM to daemon (pid=${pid})`);
    } catch {
      // Process may have already exited
    }
  }

  // Wait a moment and clean up files
  await new Promise((resolve) => setTimeout(resolve, 1000));
  cleanupDaemonFiles();

  console.log('Daemon stopped');
}

/**
 * Show daemon logs
 */
export async function daemonLogs(options: DaemonOptions & { lines?: number } = {}): Promise<void> {
  const logFile = path.join(getSuccDir(), 'daemon.log');

  if (!fs.existsSync(logFile)) {
    console.log('No daemon logs found');
    return;
  }

  const lines = options.lines || 50;
  const content = fs.readFileSync(logFile, 'utf8');
  const allLines = content.trim().split('\n');
  const lastLines = allLines.slice(-lines);

  console.log(`=== Last ${lastLines.length} lines from daemon.log ===\n`);
  console.log(lastLines.join('\n'));
}

/**
 * Main daemon command dispatcher
 */
export async function daemon(subcommand: string, options: DaemonOptions & { force?: boolean; lines?: number; all?: boolean } = {}): Promise<void> {
  switch (subcommand) {
    case 'status':
      await daemonStatus(options);
      break;
    case 'sessions':
      await daemonSessions(options);
      break;
    case 'start':
      await daemonStart(options);
      break;
    case 'stop':
      await daemonStop(options);
      break;
    case 'logs':
      await daemonLogs(options);
      break;
    default:
      console.log('Usage: succ daemon <subcommand>');
      console.log('');
      console.log('Subcommands:');
      console.log('  status    Show daemon status');
      console.log('  sessions  List active sessions (use --all to include service sessions)');
      console.log('  start     Start daemon');
      console.log('  stop      Stop daemon (use --force if sessions active)');
      console.log('  logs      Show daemon logs (use --lines=N for more)');
  }
}

// ============================================================================
// Helpers
// ============================================================================

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function cleanupDaemonFiles(): void {
  const succDir = getSuccDir();
  const tmpDir = path.join(succDir, '.tmp');

  try {
    fs.unlinkSync(path.join(tmpDir, 'daemon.pid'));
  } catch {}
  try {
    fs.unlinkSync(path.join(tmpDir, 'daemon.port'));
  } catch {}
}
