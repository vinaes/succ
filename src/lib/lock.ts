import fs from 'fs';
import path from 'path';
import { getClaudeDir } from './config.js';
import { StorageError } from './errors.js';

const LOCK_FILE = 'succ.lock';
const LOCK_TIMEOUT_MS = 30000; // 30 seconds max lock hold time
const LOCK_RETRY_MS = 100; // Retry every 100ms
const LOCK_MAX_RETRIES = 300; // 30 seconds total wait time

interface LockInfo {
  pid: number;
  timestamp: number;
  operation: string;
}

/**
 * Get the lock file path
 */
function getLockPath(): string {
  return path.join(getClaudeDir(), LOCK_FILE);
}

/**
 * Check if a process is still running
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if lock is stale (process dead or timeout exceeded)
 */
function isLockStale(lockInfo: LockInfo): boolean {
  // Process is dead
  if (!isProcessAlive(lockInfo.pid)) {
    return true;
  }

  // Lock held too long (timeout)
  if (Date.now() - lockInfo.timestamp > LOCK_TIMEOUT_MS) {
    return true;
  }

  return false;
}

/**
 * Acquire a lock for database/file operations
 * Returns a release function to call when done
 */
export async function acquireLock(operation: string): Promise<() => void> {
  const lockPath = getLockPath();
  const lockInfo: LockInfo = {
    pid: process.pid,
    timestamp: Date.now(),
    operation
  };

  let retries = 0;

  while (retries < LOCK_MAX_RETRIES) {
    try {
      // Check if lock exists
      if (fs.existsSync(lockPath)) {
        const existingLock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as LockInfo;

        // If lock is stale, remove it
        if (isLockStale(existingLock)) {
          fs.unlinkSync(lockPath);
        } else {
          // Lock is held by another process, wait and retry
          retries++;
          await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
          continue;
        }
      }

      // Try to create lock file atomically
      // Using 'wx' flag - exclusive create, fails if file exists
      fs.writeFileSync(lockPath, JSON.stringify(lockInfo), { flag: 'wx' });

      // Lock acquired! Return release function
      return () => {
        try {
          // Only remove if it's our lock
          if (fs.existsSync(lockPath)) {
            const currentLock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as LockInfo;
            if (currentLock.pid === process.pid) {
              fs.unlinkSync(lockPath);
            }
          }
        } catch {
          // Ignore errors during release
        }
      };
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      // EEXIST means another process created the lock between our check and write
      if (error.code === 'EEXIST') {
        retries++;
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
        continue;
      }
      throw err;
    }
  }

  throw new StorageError(`Could not acquire lock for ${operation} after ${LOCK_MAX_RETRIES * LOCK_RETRY_MS / 1000}s`);
}

/**
 * Execute a function with lock protection
 */
export async function withLock<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireLock(operation);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Check if lock is currently held (for status display)
 */
export function getLockStatus(): { locked: boolean; info?: LockInfo } {
  const lockPath = getLockPath();

  if (!fs.existsSync(lockPath)) {
    return { locked: false };
  }

  try {
    const lockInfo = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as LockInfo;

    if (isLockStale(lockInfo)) {
      return { locked: false, info: lockInfo };
    }

    return { locked: true, info: lockInfo };
  } catch {
    return { locked: false };
  }
}

/**
 * Force release lock (for admin/recovery)
 */
export function forceReleaseLock(): boolean {
  const lockPath = getLockPath();

  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath);
    return true;
  }

  return false;
}
