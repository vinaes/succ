import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { formatSymbolMap, batchChunks } from './analyze-helpers.js';

// Create a unique temp dir for each test run
const createTempDir = () =>
  path.join(os.tmpdir(), `succ-analyze-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

describe('Analyze Module', () => {
  describe('cleanMarkdownOutput', () => {
    // Import the function dynamically since it's not exported
    // We'll test it through its effects

    it('should remove markdown code fences', () => {
      // This tests the actual output writing behavior
      const input = '```markdown\n---\ndescription: "test"\n---\n# Title\n```';
      const expected = '---\ndescription: "test"\n---\n# Title';

      // Simulate what cleanMarkdownOutput does
      let cleaned = input.trim();
      if (/^```(?:markdown|md)?\s*\n/i.test(cleaned)) {
        cleaned = cleaned.replace(/^```(?:markdown|md)?\s*\n/i, '');
      }
      if (/\n```\s*$/.test(cleaned)) {
        cleaned = cleaned.replace(/\n```\s*$/, '');
      }

      expect(cleaned.trim()).toBe(expected);
    });

    it('should remove preamble text before YAML frontmatter', () => {
      const input = `Here is the documentation you requested:

---
description: "test"
---

# Title`;

      // Simulate cleanMarkdownOutput logic
      let cleaned = input.trim();
      const yamlStart = cleaned.indexOf('---\n');
      if (yamlStart > 0) {
        cleaned = cleaned.substring(yamlStart);
      }

      expect(cleaned.startsWith('---\n')).toBe(true);
      expect(cleaned).toContain('description: "test"');
    });
  });

  describe('parseMultiFileOutput', () => {
    it('should parse single file output', () => {
      const content = `---
description: "test"
---

# Main File

Content here.`;

      // Simulate parseMultiFileOutput behavior for single file
      const parts = content.split(/\n?===FILE:\s*/i);
      expect(parts.length).toBe(1);
      expect(parts[0].includes('# Main File')).toBe(true);
    });

    it('should parse multi-file output', () => {
      const content = `---
description: "overview"
---

# Overview

Links to other files.

===FILE: System A.md===
---
description: "System A"
---

# System A

Content for A.

===FILE: System B.md===
---
description: "System B"
---

# System B

Content for B.`;

      // Simulate parseMultiFileOutput behavior
      const parts = content.split(/\n?===FILE:\s*/i);

      expect(parts.length).toBe(3);
      expect(parts[0].includes('# Overview')).toBe(true);

      // Parse filenames from remaining parts
      const files: { name: string; content: string }[] = [];
      for (let i = 1; i < parts.length; i++) {
        const match = parts[i].match(/^([^=\n]+\.md)===\s*\n?([\s\S]*)/i);
        if (match) {
          files.push({ name: match[1].trim(), content: match[2].trim() });
        }
      }

      expect(files.length).toBe(2);
      expect(files[0].name).toBe('System A.md');
      expect(files[0].content).toContain('# System A');
      expect(files[1].name).toBe('System B.md');
      expect(files[1].content).toContain('# System B');
    });
  });

  describe('Sandbox State Management', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir();
      fs.mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should create state file with correct structure', () => {
      const stateFile = path.join(tempDir, 'sandbox.state.json');

      const state = {
        lastRun: null,
        runsCompleted: 0,
        memoriesCreated: 0,
        documentsUpdated: 0,
        lastGitCommit: null,
      };

      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

      const loaded = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(loaded.runsCompleted).toBe(0);
      expect(loaded.memoriesCreated).toBe(0);
      expect(loaded.documentsUpdated).toBe(0);
      expect(loaded.lastRun).toBeNull();
      expect(loaded.lastGitCommit).toBeNull();
    });

    it('should update state correctly', () => {
      const stateFile = path.join(tempDir, 'sandbox.state.json');

      const state = {
        lastRun: new Date().toISOString(),
        runsCompleted: 5,
        memoriesCreated: 10,
        documentsUpdated: 3,
        lastGitCommit: 'abc123',
      };

      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

      const loaded = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(loaded.runsCompleted).toBe(5);
      expect(loaded.memoriesCreated).toBe(10);
      expect(loaded.documentsUpdated).toBe(3);
      expect(loaded.lastGitCommit).toBe('abc123');
    });
  });

  describe('PID File Management', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir();
      fs.mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should create PID file', () => {
      const pidFile = path.join(tempDir, 'sandbox.pid');
      const pid = process.pid;

      fs.writeFileSync(pidFile, String(pid));

      expect(fs.existsSync(pidFile)).toBe(true);
      expect(parseInt(fs.readFileSync(pidFile, 'utf-8'), 10)).toBe(pid);
    });

    it('should check if process is running', () => {
      // Current process should be running
      const isRunning = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };

      expect(isRunning(process.pid)).toBe(true);
      expect(isRunning(99999999)).toBe(false);
    });

    it('should detect stale PID file', () => {
      const pidFile = path.join(tempDir, 'sandbox.pid');

      // Write a non-existent PID
      fs.writeFileSync(pidFile, '99999999');

      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
      const isRunning = (() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })();

      expect(isRunning).toBe(false);
    });
  });

  describe('Brain Structure', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir();
      fs.mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should create correct brain directory structure', () => {
      const brainDir = path.join(tempDir, 'brain');
      const projectName = 'test-project';

      const dirs = [
        brainDir,
        path.join(brainDir, '.meta'),
        path.join(brainDir, '.obsidian'),
        path.join(brainDir, '00_Inbox'),
        path.join(brainDir, '01_Projects', projectName, 'Technical'),
        path.join(brainDir, '01_Projects', projectName, 'Decisions'),
        path.join(brainDir, '01_Projects', projectName, 'Features'),
        path.join(brainDir, '01_Projects', projectName, 'Systems'),
        path.join(brainDir, '02_Knowledge'),
        path.join(brainDir, '03_Archive'),
      ];

      for (const dir of dirs) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Verify all directories exist
      for (const dir of dirs) {
        expect(fs.existsSync(dir)).toBe(true);
      }
    });
  });

  describe('Discovery Deduplication Logic', () => {
    it('should detect similar discoveries', () => {
      // Simulate similarity check
      const similarity = (a: string, b: string): number => {
        // Simple Jaccard similarity for testing
        const setA = new Set(a.toLowerCase().split(/\s+/));
        const setB = new Set(b.toLowerCase().split(/\s+/));
        const intersection = new Set([...setA].filter((x) => setB.has(x)));
        const union = new Set([...setA, ...setB]);
        return intersection.size / union.size;
      };

      const existing = 'Command pattern for CLI implementation';
      const similar = 'CLI command pattern implementation';
      const different = 'Database connection pooling strategy';

      expect(similarity(existing, similar)).toBeGreaterThan(0.5);
      expect(similarity(existing, different)).toBeLessThan(0.3);
    });
  });
});

describe('Recursive File Analysis Helpers', () => {
  describe('formatSymbolMap', () => {
    it('should format symbols with signatures', () => {
      const symbols = [
        { name: 'calculateTotal', type: 'function', signature: '(items: Item[]): number', startRow: 10 },
        { name: 'UserService', type: 'class', signature: undefined, startRow: 50 },
      ];
      const result = formatSymbolMap(symbols);
      expect(result).toContain('function calculateTotal(items: Item[]): number (line 11)');
      expect(result).toContain('class UserService (line 51)');
    });

    it('should return placeholder for empty symbols', () => {
      expect(formatSymbolMap([])).toBe('(no symbols extracted)');
    });

    it('should handle symbols without signatures', () => {
      const symbols = [
        { name: 'MAX_SIZE', type: 'variable', startRow: 0 },
      ];
      const result = formatSymbolMap(symbols);
      expect(result).toBe('  variable MAX_SIZE (line 1)');
    });
  });

  describe('batchChunks', () => {
    it('should create a single batch for small chunks', () => {
      const chunks = [
        { content: 'abc', startLine: 1, endLine: 3 },
        { content: 'def', startLine: 4, endLine: 6 },
      ];
      const batches = batchChunks(chunks, 100);
      expect(batches.length).toBe(1);
      expect(batches[0].length).toBe(2);
    });

    it('should split into multiple batches when exceeding maxChars', () => {
      const chunks = [
        { content: 'a'.repeat(5000), startLine: 1, endLine: 50 },
        { content: 'b'.repeat(5000), startLine: 51, endLine: 100 },
        { content: 'c'.repeat(5000), startLine: 101, endLine: 150 },
      ];
      const batches = batchChunks(chunks, 8000);
      expect(batches.length).toBe(3);
      expect(batches[0].length).toBe(1);
      expect(batches[1].length).toBe(1);
      expect(batches[2].length).toBe(1);
    });

    it('should group small chunks together up to limit', () => {
      const chunks = [
        { content: 'a'.repeat(2000), startLine: 1, endLine: 20 },
        { content: 'b'.repeat(2000), startLine: 21, endLine: 40 },
        { content: 'c'.repeat(2000), startLine: 41, endLine: 60 },
        { content: 'd'.repeat(2000), startLine: 61, endLine: 80 },
      ];
      const batches = batchChunks(chunks, 5000);
      expect(batches.length).toBe(2);
      expect(batches[0].length).toBe(2);
      expect(batches[1].length).toBe(2);
    });

    it('should handle empty chunks array', () => {
      const batches = batchChunks([], 8000);
      expect(batches.length).toBe(0);
    });

    it('should handle single chunk larger than maxChars', () => {
      const chunks = [
        { content: 'a'.repeat(10000), startLine: 1, endLine: 100 },
      ];
      const batches = batchChunks(chunks, 8000);
      expect(batches.length).toBe(1);
      expect(batches[0].length).toBe(1);
    });

    it('should preserve chunk order across batches', () => {
      const chunks = Array.from({ length: 10 }, (_, i) => ({
        content: `chunk-${i}`,
        startLine: i * 10 + 1,
        endLine: (i + 1) * 10,
      }));
      const batches = batchChunks(chunks, 30);  // ~3 chunks per batch
      const flat = batches.flat();
      expect(flat.map(c => c.content)).toEqual(chunks.map(c => c.content));
    });
  });
});

describe('Concurrent Access', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should handle concurrent file writes safely with locking', async () => {
    const testFile = path.join(tempDir, 'test.txt');
    const lockFile = path.join(tempDir, 'test.lock');

    // Simulate withLock behavior
    const withSimpleLock = async <T>(fn: () => Promise<T>): Promise<T> => {
      // Wait for lock
      while (fs.existsSync(lockFile)) {
        await new Promise((r) => setTimeout(r, 10));
      }
      // Acquire lock
      fs.writeFileSync(lockFile, String(process.pid));
      try {
        return await fn();
      } finally {
        fs.unlinkSync(lockFile);
      }
    };

    // Write concurrently
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      writes.push(
        withSimpleLock(async () => {
          const content = fs.existsSync(testFile) ? fs.readFileSync(testFile, 'utf-8') : '';
          await new Promise((r) => setTimeout(r, 10)); // Simulate async work
          fs.writeFileSync(testFile, content + `${i}\n`);
        })
      );
    }

    await Promise.all(writes);

    // All writes should be present
    const finalContent = fs.readFileSync(testFile, 'utf-8');
    const lines = finalContent.trim().split('\n');
    expect(lines.length).toBe(5);
  });

  it('should prevent data corruption during concurrent reads and writes', async () => {
    const dataFile = path.join(tempDir, 'data.json');

    // Initialize data
    fs.writeFileSync(dataFile, JSON.stringify({ count: 0 }));

    // Simulate concurrent increments with proper locking
    const lockFile = path.join(tempDir, 'data.lock');

    const increment = async () => {
      // Wait for lock
      while (fs.existsSync(lockFile)) {
        await new Promise((r) => setTimeout(r, 5));
      }
      // Acquire
      fs.writeFileSync(lockFile, String(process.pid));
      try {
        const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
        await new Promise((r) => setTimeout(r, 5));
        data.count++;
        fs.writeFileSync(dataFile, JSON.stringify(data));
      } finally {
        if (fs.existsSync(lockFile)) {
          fs.unlinkSync(lockFile);
        }
      }
    };

    // Run 10 concurrent increments
    await Promise.all(Array(10).fill(null).map(() => increment()));

    const finalData = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
    expect(finalData.count).toBe(10);
  });
});
