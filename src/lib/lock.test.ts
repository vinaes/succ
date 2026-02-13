import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { acquireLock, withLock, getLockStatus, forceReleaseLock } from './lock.js';

// Mock the config to use a temp directory
vi.mock('./config.js', () => {
  const tempDir = path.join(os.tmpdir(), `succ-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return {
    getClaudeDir: () => tempDir,
    getProjectRoot: () => tempDir,
  };
});

// Get the mocked temp dir
import { getClaudeDir } from './config.js';

describe('Lock System', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = getClaudeDir();
    // Ensure temp directory exists
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up lock file and temp dir
    const lockPath = path.join(tempDir, 'succ.lock');
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('acquireLock', () => {
    it('should acquire lock when no lock exists', async () => {
      const release = await acquireLock('test-operation');
      expect(release).toBeDefined();
      expect(typeof release).toBe('function');

      // Verify lock file was created
      const lockPath = path.join(tempDir, 'succ.lock');
      expect(fs.existsSync(lockPath)).toBe(true);

      // Verify lock content
      const lockInfo = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      expect(lockInfo.pid).toBe(process.pid);
      expect(lockInfo.operation).toBe('test-operation');
      expect(lockInfo.timestamp).toBeDefined();

      // Clean up
      release();
    });

    it('should release lock correctly', async () => {
      const release = await acquireLock('test-operation');
      const lockPath = path.join(tempDir, 'succ.lock');

      expect(fs.existsSync(lockPath)).toBe(true);
      release();
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('should wait and retry when lock is held', async () => {
      // Acquire first lock
      const release1 = await acquireLock('first-operation');

      // Start acquiring second lock (should wait)
      let lock2Acquired = false;
      const lock2Promise = acquireLock('second-operation').then((release) => {
        lock2Acquired = true;
        return release;
      });

      // Wait a bit, lock2 should not be acquired yet
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(lock2Acquired).toBe(false);

      // Release first lock
      release1();

      // Now lock2 should acquire
      const release2 = await lock2Promise;
      expect(lock2Acquired).toBe(true);

      release2();
    });

    it('should handle stale lock from dead process', async () => {
      const lockPath = path.join(tempDir, 'succ.lock');

      // Create a stale lock file with a non-existent PID
      const staleLock = {
        pid: 99999999, // Very unlikely to be a real PID
        timestamp: Date.now(),
        operation: 'stale-operation',
      };
      fs.writeFileSync(lockPath, JSON.stringify(staleLock));

      // Should acquire lock despite stale file
      const release = await acquireLock('new-operation');
      expect(release).toBeDefined();

      // Verify new lock
      const lockInfo = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      expect(lockInfo.operation).toBe('new-operation');
      expect(lockInfo.pid).toBe(process.pid);

      release();
    });

    it('should handle timeout for old lock', async () => {
      const lockPath = path.join(tempDir, 'succ.lock');

      // Create an old lock file (timestamp > 30 seconds ago) but with current process PID
      // This simulates a lock that's been held too long
      const oldLock = {
        pid: process.pid, // Use current PID so it's "alive"
        timestamp: Date.now() - 35000, // 35 seconds ago
        operation: 'old-operation',
      };
      fs.writeFileSync(lockPath, JSON.stringify(oldLock));

      // Should acquire lock because old one is timed out
      const release = await acquireLock('new-operation');
      expect(release).toBeDefined();

      const lockInfo = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      expect(lockInfo.operation).toBe('new-operation');

      release();
    });
  });

  describe('withLock', () => {
    it('should execute function with lock protection', async () => {
      let executed = false;

      await withLock('test-op', async () => {
        executed = true;
        // Verify lock exists during execution
        const lockPath = path.join(tempDir, 'succ.lock');
        expect(fs.existsSync(lockPath)).toBe(true);
      });

      expect(executed).toBe(true);

      // Verify lock is released after
      const lockPath = path.join(tempDir, 'succ.lock');
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('should release lock even on error', async () => {
      const lockPath = path.join(tempDir, 'succ.lock');

      try {
        await withLock('test-op', async () => {
          throw new Error('Test error');
        });
      } catch {
        // Expected
      }

      // Lock should still be released
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('should return function result', async () => {
      const result = await withLock('test-op', async () => {
        return 42;
      });

      expect(result).toBe(42);
    });

    it('should serialize concurrent operations', async () => {
      const order: number[] = [];

      const op1 = withLock('op', async () => {
        order.push(1);
        await new Promise((r) => setTimeout(r, 100));
        order.push(2);
      });

      const op2 = withLock('op', async () => {
        order.push(3);
        await new Promise((r) => setTimeout(r, 50));
        order.push(4);
      });

      await Promise.all([op1, op2]);

      // Operations should be serialized: 1,2,3,4 or 3,4,1,2
      expect(
        (order[0] === 1 && order[1] === 2 && order[2] === 3 && order[3] === 4) ||
          (order[0] === 3 && order[1] === 4 && order[2] === 1 && order[3] === 2)
      ).toBe(true);
    });
  });

  describe('getLockStatus', () => {
    it('should return locked: false when no lock exists', () => {
      const status = getLockStatus();
      expect(status.locked).toBe(false);
      expect(status.info).toBeUndefined();
    });

    it('should return locked: true when lock is held by current process', async () => {
      const release = await acquireLock('test-op');

      const status = getLockStatus();
      expect(status.locked).toBe(true);
      expect(status.info).toBeDefined();
      expect(status.info?.pid).toBe(process.pid);
      expect(status.info?.operation).toBe('test-op');

      release();
    });

    it('should return locked: false for stale lock', () => {
      const lockPath = path.join(tempDir, 'succ.lock');

      // Create stale lock
      const staleLock = {
        pid: 99999999,
        timestamp: Date.now(),
        operation: 'stale',
      };
      fs.writeFileSync(lockPath, JSON.stringify(staleLock));

      const status = getLockStatus();
      expect(status.locked).toBe(false);
      expect(status.info).toBeDefined(); // Returns info even though stale
    });
  });

  describe('forceReleaseLock', () => {
    it('should remove existing lock file', async () => {
      const lockPath = path.join(tempDir, 'succ.lock');

      // Create lock
      const release = await acquireLock('test-op');
      expect(fs.existsSync(lockPath)).toBe(true);

      // Force release (even though we have the release function)
      const result = forceReleaseLock();
      expect(result).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);

      // Original release should not error
      release();
    });

    it('should return false when no lock exists', () => {
      const result = forceReleaseLock();
      expect(result).toBe(false);
    });
  });
});
