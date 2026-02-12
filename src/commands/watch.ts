import fs from 'fs';
import path from 'path';
import { getClaudeDir, getProjectRoot } from '../lib/config.js';
import { createDaemonClient, ensureDaemonRunning } from '../daemon/client.js';
import { logError } from '../lib/fault-logger.js';

interface WatchOptions {
  pattern?: string;
  includeCode?: boolean;
}

/**
 * Start watch daemon (now uses unified daemon)
 */
export async function startWatchDaemon(
  targetPath?: string,
  pattern: string = '**/*.md',
  includeCode: boolean = false
): Promise<void> {
  console.log('👁️  Starting watch service...');

  // Ensure daemon is running
  const started = await ensureDaemonRunning();
  if (!started) {
    logError('watch', 'Failed to start daemon');
    console.error('Failed to start daemon');
    process.exit(1);
  }

  // Start watch service via daemon API
  const client = createDaemonClient();
  const port = client.getPort();

  if (!port) {
    logError('watch', 'Could not get daemon port');
    console.error('Could not get daemon port');
    process.exit(1);
  }

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/watch/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patterns: [pattern],
        includeCode,
      }),
    });

    const result = await response.json();
    if (result.success) {
      console.log(`   Status: Running`);
      console.log(`   Pattern: ${result.patterns?.join(', ') || pattern}`);
      console.log(`   Code: ${result.includeCode ? 'enabled' : 'disabled'}`);
      console.log(`\n   Stop:   succ watch --stop`);
      console.log(`   Status: succ watch --status`);
    } else {
      console.error('Failed to start watch service');
    }
  } catch (error) {
    logError('watch', 'Error starting watch service:', error instanceof Error ? error : new Error(String(error)));
    console.error('Error starting watch service:', error);
    process.exit(1);
  }
}

/**
 * Stop watch daemon
 */
export async function stopWatchDaemon(): Promise<void> {
  const client = createDaemonClient();
  const port = client.getPort();

  if (!port) {
    console.log('Watch service not running (no daemon)');
    return;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/watch/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await response.json();
    if (result.success) {
      console.log('👁️  Watch service stopped');
    } else {
      console.log('Watch service was not running');
    }
  } catch {
    console.log('Watch service not running (daemon not responding)');
  }
}

/**
 * Show watch daemon status
 */
export async function watchDaemonStatus(): Promise<void> {
  console.log('👁️  Watch Service Status\n');

  const client = createDaemonClient();
  const port = client.getPort();

  if (!port) {
    console.log('   Status: Not running (no daemon)');
    return;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/watch/status`, {
      method: 'GET',
    });

    const status = await response.json();
    console.log(`   Status: ${status.active ? 'Running' : 'Stopped'}`);
    console.log(`   Patterns: ${status.patterns?.join(', ') || 'none'}`);
    console.log(`   Code: ${status.includeCode ? 'enabled' : 'disabled'}`);
    console.log(`   Watched files: ${status.watchedFiles || 0}`);
    if (status.lastChange > 0) {
      const lastChange = new Date(status.lastChange);
      console.log(`   Last change: ${lastChange.toLocaleString()}`);
    }
  } catch {
    console.log('   Status: Not running (daemon not responding)');
  }

  // Show daemon logs
  const claudeDir = getClaudeDir();
  const succDir = path.join(getProjectRoot(), '.succ');
  const logFile = path.join(succDir, 'daemon.log');

  if (fs.existsSync(logFile)) {
    console.log(`\n   Log file: ${logFile}`);
    const logContent = fs.readFileSync(logFile, 'utf-8');
    const lines = logContent.trim().split('\n');
    // Filter to watch-related lines
    const watchLines = lines
      .filter(line => line.includes('[watch]'))
      .slice(-10);
    if (watchLines.length > 0) {
      console.log('\n   Recent activity:');
      for (const line of watchLines) {
        console.log(`   ${line}`);
      }
    }
  }
}

/**
 * Watch for file changes and auto-reindex
 */
export async function watch(
  targetPath?: string,
  options: WatchOptions = {}
): Promise<void> {
  const { pattern = '**/*.md', includeCode = false } = options;

  // Ensure daemon is running
  console.log('Starting watch service (daemon-based)...\n');

  const started = await ensureDaemonRunning();
  if (!started) {
    logError('watch', 'Failed to start daemon for watch');
    console.error('Failed to start daemon');
    process.exit(1);
  }

  // Start watch service
  await startWatchDaemon(targetPath, pattern, includeCode);

  // Keep process alive and show updates
  console.log('\nWatch service running. Press Ctrl+C to stop.\n');

  // Periodically show status
  const showStatus = async () => {
    const client = createDaemonClient();
    const port = client.getPort();
    if (!port) return;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/watch/status`);
      const status = await response.json();
      if (status.lastChange > 0) {
        const lastChange = new Date(status.lastChange);
        process.stdout.write(`\rLast change: ${lastChange.toLocaleTimeString()} | Files: ${status.watchedFiles}   `);
      }
    } catch {
      // Ignore
    }
  };

  const interval = setInterval(showStatus, 5000);

  // Handle Ctrl+C
  process.on('SIGINT', async () => {
    clearInterval(interval);
    console.log('\nStopping watch service...');
    await stopWatchDaemon();
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}
