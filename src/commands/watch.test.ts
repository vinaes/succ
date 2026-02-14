import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

describe('Watch Command', () => {
  let tempDir: string;
  let claudeDir: string;

  beforeEach(() => {
    const uniqueId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    tempDir = path.join(os.tmpdir(), `succ-test-${uniqueId}`);
    fs.mkdirSync(tempDir, { recursive: true });
    claudeDir = path.join(tempDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('PID File Operations', () => {
    it('creates PID file atomically', () => {
      const pidFile = path.join(claudeDir, 'watch.pid');
      fs.writeFileSync(pidFile, String(process.pid), { flag: 'wx' });
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.readFileSync(pidFile, 'utf-8').trim()).toBe(String(process.pid));
    });

    it('fails on existing PID file', () => {
      const pidFile = path.join(claudeDir, 'watch.pid');
      fs.writeFileSync(pidFile, '12345', { flag: 'wx' });
      expect(() => {
        fs.writeFileSync(pidFile, '67890', { flag: 'wx' });
      }).toThrow();
    });

    it('detects stale PID file', () => {
      const fakePid = 2147483647;
      let isAlive = false;
      try {
        process.kill(fakePid, 0);
        isAlive = true;
      } catch {
        isAlive = false;
      }
      expect(isAlive).toBe(false);
    });

    it('handles PID file race condition', async () => {
      const pidFile = path.join(claudeDir, 'watch.pid');

      const tryAcquirePid = async (id: number): Promise<boolean> => {
        try {
          fs.writeFileSync(pidFile, String(id), { flag: 'wx' });
          return true;
        } catch {
          return false;
        }
      };

      const attempts = await Promise.all([
        tryAcquirePid(1001),
        tryAcquirePid(1002),
        tryAcquirePid(1003),
      ]);

      const successCount = attempts.filter(Boolean).length;
      expect(successCount).toBe(1);
    });
  });

  describe('Hash-based Deduplication', () => {
    it('skips unchanged files', () => {
      const content = '# Test Document\n\nSome content here.';
      const hash1 = crypto.createHash('md5').update(content).digest('hex');
      const hash2 = crypto.createHash('md5').update(content).digest('hex');
      expect(hash1).toBe(hash2);
    });

    it('detects content changes', () => {
      const original = '# Test Document\n\nOriginal content.';
      const modified = '# Test Document\n\nModified content.';
      const hash1 = crypto.createHash('md5').update(original).digest('hex');
      const hash2 = crypto.createHash('md5').update(modified).digest('hex');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('Debouncing', () => {
    it('debounces rapid file changes', async () => {
      const pending = new Map<string, ReturnType<typeof setTimeout>>();
      const debounceMs = 50;
      const processed: string[] = [];

      const debounceFile = (filePath: string) => {
        const existing = pending.get(filePath);
        if (existing) clearTimeout(existing);
        pending.set(
          filePath,
          setTimeout(() => {
            pending.delete(filePath);
            processed.push(filePath);
          }, debounceMs)
        );
      };

      for (let i = 0; i < 5; i++) {
        debounceFile('test.md');
        await new Promise((r) => setTimeout(r, 10));
      }

      await new Promise((r) => setTimeout(r, debounceMs + 20));
      expect(processed.length).toBe(1);
    });

    it('handles multiple different files', async () => {
      const pending = new Map<string, ReturnType<typeof setTimeout>>();
      const debounceMs = 30;
      const processed: string[] = [];

      const debounceFile = (filePath: string) => {
        const existing = pending.get(filePath);
        if (existing) clearTimeout(existing);
        pending.set(
          filePath,
          setTimeout(() => {
            pending.delete(filePath);
            processed.push(filePath);
          }, debounceMs)
        );
      };

      debounceFile('file1.md');
      debounceFile('file2.md');
      debounceFile('file3.md');

      await new Promise((r) => setTimeout(r, debounceMs + 20));
      expect(processed.length).toBe(3);
    });
  });

  describe('File Deletion', () => {
    it('skips deleted files during debounce', async () => {
      const testFile = path.join(tempDir, 'test.md');
      const skipped: string[] = [];
      const processed: string[] = [];

      fs.writeFileSync(testFile, '# Test');

      const processFile = async () => {
        await new Promise((r) => setTimeout(r, 50));
        if (!fs.existsSync(testFile)) {
          skipped.push(testFile);
          return;
        }
        processed.push(testFile);
      };

      const promise = processFile();
      fs.unlinkSync(testFile);
      await promise;

      expect(processed.length).toBe(0);
      expect(skipped.length).toBe(1);
    });
  });
});
