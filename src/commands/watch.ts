import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import chokidar from 'chokidar';
import { getClaudeDir, getProjectRoot } from '../lib/config.js';
import { getEmbeddings } from '../lib/embeddings.js';
import { chunkText, extractFrontmatter } from '../lib/chunker.js';
import { withLock } from '../lib/lock.js';
import {
  upsertDocumentsBatch,
  deleteDocumentsByPath,
  getFileHash,
  setFileHash,
  deleteFileHash,
  closeDb,
} from '../lib/db.js';

interface WatchOptions {
  pattern?: string;
  daemon?: boolean;
}

function computeHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Index a single file with lock protection
 */
async function indexFile(filePath: string, relativePath: string, log?: (msg: string) => void): Promise<void> {
  const print = log || console.log;

  // Read file content outside of lock (I/O can be slow)
  const content = fs.readFileSync(filePath, 'utf-8');
  const hash = computeHash(content);

  // Check hash outside of lock first (fast path)
  const existingHash = getFileHash(relativePath);
  if (existingHash === hash) {
    return;
  }

  const { frontmatter, body } = extractFrontmatter(content);

  // Skip if marked as no-index
  if (frontmatter['succ-ignore']) {
    print(`  Skipping ${relativePath} (succ-ignore)`);
    return;
  }

  // Chunk text (CPU-bound, do outside lock)
  const chunks = chunkText(body, relativePath);
  if (chunks.length === 0) return;

  // Get embeddings (network I/O, do outside lock)
  const texts = chunks.map((c) => c.content);
  const embeddings = await getEmbeddings(texts);

  // Prepare documents
  const documents = chunks.map((chunk, i) => ({
    filePath: relativePath,
    chunkIndex: i,
    content: chunk.content,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    embedding: embeddings[i],
  }));

  // Database operations with lock protection
  await withLock('watch-index', async () => {
    // Re-check hash inside lock (file may have changed during embedding)
    const currentHash = getFileHash(relativePath);
    if (currentHash === hash) {
      return; // Another process already indexed this version
    }

    // Delete existing chunks and insert new ones atomically
    deleteDocumentsByPath(relativePath);
    upsertDocumentsBatch(documents);
    setFileHash(relativePath, hash);
  });

  print(`  Indexed: ${relativePath} (${chunks.length} chunks)`);
}

/**
 * Remove a file from index with lock protection
 */
async function removeFile(relativePath: string, log?: (msg: string) => void): Promise<void> {
  const print = log || console.log;

  await withLock('watch-remove', async () => {
    deleteDocumentsByPath(relativePath);
    deleteFileHash(relativePath);
  });

  print(`  Removed: ${relativePath}`);
}

/**
 * Check if a process is running by PID
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start watch daemon
 */
export async function startWatchDaemon(targetPath?: string, pattern: string = '**/*.md'): Promise<void> {
  const claudeDir = getClaudeDir();
  const pidFile = path.join(claudeDir, 'watch.pid');
  const logFile = path.join(claudeDir, 'watch.log');

  // Check if daemon is already running
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (isProcessRunning(pid)) {
      console.log(`👁️  Watch daemon already running (PID: ${pid})`);
      console.log(`   Log: ${logFile}`);
      console.log(`   Stop: succ watch --stop`);
      console.log(`   Status: succ watch --status`);
      return;
    } else {
      // Stale pid file, remove it
      fs.unlinkSync(pidFile);
    }
  }

  console.log('👁️  Starting watch daemon...');

  // Spawn detached process that runs the actual watcher
  const args = [
    process.argv[1],
    'watch',
    '--daemon-worker',
    '--pattern', pattern,
  ];
  if (targetPath) {
    args.push(targetPath);
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
    cwd: getProjectRoot(),
  });

  // Write PID file
  fs.writeFileSync(pidFile, String(child.pid));

  child.unref();

  console.log(`   PID: ${child.pid}`);
  console.log(`   Log: ${logFile}`);
  console.log(`   Pattern: ${pattern}`);
  console.log(`\n   Stop:   succ watch --stop`);
  console.log(`   Status: succ watch --status`);
}

/**
 * Stop watch daemon
 */
export async function stopWatchDaemon(): Promise<void> {
  const claudeDir = getClaudeDir();
  const pidFile = path.join(claudeDir, 'watch.pid');

  if (!fs.existsSync(pidFile)) {
    console.log('No watch daemon running');
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);

  if (isProcessRunning(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`👁️  Watch daemon stopped (PID: ${pid})`);
    } catch (error) {
      console.error(`Failed to stop daemon: ${error}`);
    }
  } else {
    console.log('Watch daemon was not running (stale PID file)');
  }

  fs.unlinkSync(pidFile);
}

/**
 * Show watch daemon status
 */
export async function watchDaemonStatus(): Promise<void> {
  const claudeDir = getClaudeDir();
  const pidFile = path.join(claudeDir, 'watch.pid');
  const logFile = path.join(claudeDir, 'watch.log');

  console.log('👁️  Watch Daemon Status\n');

  // Check daemon
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (isProcessRunning(pid)) {
      console.log(`   Status: Running (PID: ${pid})`);
    } else {
      console.log('   Status: Not running (stale PID file)');
      fs.unlinkSync(pidFile);
    }
  } else {
    console.log('   Status: Not running');
  }

  // Show recent log entries
  if (fs.existsSync(logFile)) {
    console.log(`\n   Log file: ${logFile}`);
    const logContent = fs.readFileSync(logFile, 'utf-8');
    const lines = logContent.trim().split('\n');
    const recentLines = lines.slice(-10);
    if (recentLines.length > 0) {
      console.log('\n   Recent activity:');
      for (const line of recentLines) {
        console.log(`   ${line}`);
      }
    }
  }
}

/**
 * Run as daemon worker (internal, called by daemon process)
 */
export async function runWatchDaemonWorker(targetPath?: string, pattern: string = '**/*.md'): Promise<void> {
  const projectRoot = getProjectRoot();
  const claudeDir = getClaudeDir();
  const logFile = path.join(claudeDir, 'watch.log');

  const log = (msg: string) => {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}`;
    fs.appendFileSync(logFile, line + '\n');
    console.log(line);
  };

  // Default to brain directory
  const watchPath = targetPath
    ? path.resolve(targetPath)
    : path.join(claudeDir, 'brain');

  if (!fs.existsSync(watchPath)) {
    log(`Error: Path not found: ${watchPath}`);
    process.exit(1);
  }

  const displayPath = path.relative(projectRoot, watchPath) || watchPath;
  log(`👁️  Watch daemon started`);
  log(`   Watching: ${displayPath}`);
  log(`   Pattern: ${pattern}`);

  // Debounce map to avoid multiple rapid triggers
  const pending = new Map<string, NodeJS.Timeout>();
  const debounceMs = 500;

  const watcher = chokidar.watch(pattern, {
    cwd: watchPath,
    ignoreInitial: true,
    ignored: ['**/node_modules/**', '**/.git/**', '**/.obsidian/**'],
    persistent: true,
  });

  watcher.on('add', (file) => {
    const absolutePath = path.join(watchPath, file);
    const relativePath = path.relative(projectRoot, absolutePath);

    if (pending.has(relativePath)) {
      clearTimeout(pending.get(relativePath));
    }

    pending.set(
      relativePath,
      setTimeout(async () => {
        pending.delete(relativePath);
        if (!fs.existsSync(absolutePath)) {
          log(`  Skipped ${file} (no longer exists)`);
          return;
        }
        log(`[+] ${file}`);
        try {
          await indexFile(absolutePath, relativePath, log);
        } catch (error) {
          log(`  Error indexing ${file}: ${error}`);
        }
      }, debounceMs)
    );
  });

  watcher.on('change', (file) => {
    const absolutePath = path.join(watchPath, file);
    const relativePath = path.relative(projectRoot, absolutePath);

    if (pending.has(relativePath)) {
      clearTimeout(pending.get(relativePath));
    }

    pending.set(
      relativePath,
      setTimeout(async () => {
        pending.delete(relativePath);
        if (!fs.existsSync(absolutePath)) {
          log(`  Skipped ${file} (no longer exists)`);
          return;
        }
        log(`[~] ${file}`);
        try {
          await indexFile(absolutePath, relativePath, log);
        } catch (error) {
          log(`  Error indexing ${file}: ${error}`);
        }
      }, debounceMs)
    );
  });

  watcher.on('unlink', async (file) => {
    const absolutePath = path.join(watchPath, file);
    const relativePath = path.relative(projectRoot, absolutePath);
    log(`[-] ${file}`);
    try {
      await removeFile(relativePath, log);
    } catch (error) {
      log(`  Error removing ${file}: ${error}`);
    }
  });

  watcher.on('error', (error) => {
    log(`Watcher error: ${error}`);
  });

  // Handle termination signals
  const cleanup = () => {
    log('Watch daemon stopping...');
    watcher.close();
    closeDb();
    // Remove PID file
    const pidFile = path.join(claudeDir, 'watch.pid');
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
    process.exit(0);
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

/**
 * Watch for file changes and auto-reindex (foreground mode)
 */
export async function watch(
  targetPath?: string,
  options: WatchOptions = {}
): Promise<void> {
  const { pattern = '**/*.md', daemon = false } = options;

  // Daemon mode: start background process
  if (daemon) {
    await startWatchDaemon(targetPath, pattern);
    return;
  }

  // Foreground mode: run watcher directly
  const projectRoot = getProjectRoot();
  const claudeDir = getClaudeDir();

  // Default to brain directory
  const watchPath = targetPath
    ? path.resolve(targetPath)
    : path.join(claudeDir, 'brain');

  if (!fs.existsSync(watchPath)) {
    console.error(`Path not found: ${watchPath}`);
    process.exit(1);
  }

  const displayPath = path.relative(projectRoot, watchPath) || watchPath;
  console.log(`Watching ${displayPath}`);
  console.log(`Pattern: ${pattern}`);
  console.log('Press Ctrl+C to stop\n');

  // Debounce map to avoid multiple rapid triggers
  const pending = new Map<string, NodeJS.Timeout>();
  const debounceMs = 500;

  const watcher = chokidar.watch(pattern, {
    cwd: watchPath,
    ignoreInitial: true,
    ignored: ['**/node_modules/**', '**/.git/**', '**/.obsidian/**'],
    persistent: true,
  });

  watcher.on('add', (file) => {
    const absolutePath = path.join(watchPath, file);
    const relativePath = path.relative(projectRoot, absolutePath);

    // Debounce
    if (pending.has(relativePath)) {
      clearTimeout(pending.get(relativePath));
    }

    pending.set(
      relativePath,
      setTimeout(async () => {
        pending.delete(relativePath);
        // Check if file still exists (may have been renamed/deleted during debounce)
        if (!fs.existsSync(absolutePath)) {
          console.log(`  Skipped ${file} (no longer exists)`);
          return;
        }
        console.log(`[+] ${file}`);
        try {
          await indexFile(absolutePath, relativePath);
        } catch (error) {
          console.error(`  Error indexing ${file}:`, error);
        }
      }, debounceMs)
    );
  });

  watcher.on('change', (file) => {
    const absolutePath = path.join(watchPath, file);
    const relativePath = path.relative(projectRoot, absolutePath);

    // Debounce
    if (pending.has(relativePath)) {
      clearTimeout(pending.get(relativePath));
    }

    pending.set(
      relativePath,
      setTimeout(async () => {
        pending.delete(relativePath);
        // Check if file still exists (may have been renamed/deleted during debounce)
        if (!fs.existsSync(absolutePath)) {
          console.log(`  Skipped ${file} (no longer exists)`);
          return;
        }
        console.log(`[~] ${file}`);
        try {
          await indexFile(absolutePath, relativePath);
        } catch (error) {
          console.error(`  Error indexing ${file}:`, error);
        }
      }, debounceMs)
    );
  });

  watcher.on('unlink', async (file) => {
    const absolutePath = path.join(watchPath, file);
    const relativePath = path.relative(projectRoot, absolutePath);

    console.log(`[-] ${file}`);
    try {
      await removeFile(relativePath);
    } catch (error) {
      console.error(`  Error removing ${file}:`, error);
    }
  });

  watcher.on('error', (error) => {
    console.error('Watcher error:', error);
  });

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('\nStopping watcher...');
    watcher.close();
    closeDb();
    process.exit(0);
  });
}
