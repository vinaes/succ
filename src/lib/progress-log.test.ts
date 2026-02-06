/**
 * Progress Log Tests (Phase 7.4)
 *
 * Tests for DB-based progress log (learning_deltas table).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Create a temp DB for tests
const testDir = path.join(os.tmpdir(), 'succ-test-progress-' + process.pid);
const testDbPath = path.join(testDir, 'test.db');

let testDb: Database.Database;

// Mock getDb to return our test database
vi.mock('./db/connection.js', () => ({
  getDb: () => testDb,
  getGlobalDb: () => testDb,
  closeDb: vi.fn(),
  closeGlobalDb: vi.fn(),
}));

import { appendProgressEntry, appendRawEntry, readProgressLog, getProgressEntries } from './progress-log.js';
import type { LearningDelta } from './learning-delta.js';

describe('Progress Log (DB-based)', () => {
  beforeEach(() => {
    // Create fresh test DB
    fs.mkdirSync(testDir, { recursive: true });
    testDb = new Database(testDbPath);
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS learning_deltas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        memories_before INTEGER NOT NULL DEFAULT 0,
        memories_after INTEGER NOT NULL DEFAULT 0,
        new_memories INTEGER NOT NULL DEFAULT 0,
        types_added TEXT,
        avg_quality REAL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_learning_deltas_timestamp ON learning_deltas(timestamp);
    `);
  });

  afterEach(() => {
    try { testDb?.close(); } catch { /* ignore */ }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('appendProgressEntry', () => {
    it('should insert a learning delta row', () => {
      const delta: LearningDelta = {
        timestamp: '2026-02-06T12:00:00Z',
        memoriesBefore: 10,
        memoriesAfter: 15,
        newMemories: 5,
        typesAdded: { learning: 3, decision: 2 },
        source: 'session-summary',
      };

      appendProgressEntry(delta);

      const rows = testDb.prepare('SELECT * FROM learning_deltas').all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].source).toBe('session-summary');
      expect(rows[0].new_memories).toBe(5);
      expect(rows[0].memories_before).toBe(10);
      expect(rows[0].memories_after).toBe(15);
    });

    it('should store types_added as JSON', () => {
      const delta: LearningDelta = {
        timestamp: '2026-02-06T12:00:00Z',
        memoriesBefore: 0,
        memoriesAfter: 3,
        newMemories: 3,
        typesAdded: { observation: 2, dead_end: 1 },
        source: 'mcp-remember',
      };

      appendProgressEntry(delta);

      const row = testDb.prepare('SELECT * FROM learning_deltas').get() as any;
      const parsed = JSON.parse(row.types_added);
      expect(parsed).toEqual({ observation: 2, dead_end: 1 });
    });

    it('should store null types_added when empty', () => {
      const delta: LearningDelta = {
        timestamp: '2026-02-06T12:00:00Z',
        memoriesBefore: 5,
        memoriesAfter: 5,
        newMemories: 0,
        typesAdded: {},
        source: 'manual',
      };

      appendProgressEntry(delta);

      const row = testDb.prepare('SELECT * FROM learning_deltas').get() as any;
      expect(row.types_added).toBeNull();
    });

    it('should store avg_quality when provided', () => {
      const delta: LearningDelta = {
        timestamp: '2026-02-06T12:00:00Z',
        memoriesBefore: 0,
        memoriesAfter: 2,
        newMemories: 2,
        typesAdded: { learning: 2 },
        avgQualityOfNew: 0.75,
        source: 'session-summary',
      };

      appendProgressEntry(delta);

      const row = testDb.prepare('SELECT * FROM learning_deltas').get() as any;
      expect(row.avg_quality).toBe(0.75);
    });

    it('should allow multiple entries', () => {
      appendProgressEntry({
        timestamp: '2026-02-06T10:00:00Z',
        memoriesBefore: 0, memoriesAfter: 3, newMemories: 3,
        typesAdded: { learning: 3 }, source: 'session-summary',
      });
      appendProgressEntry({
        timestamp: '2026-02-06T12:00:00Z',
        memoriesBefore: 3, memoriesAfter: 5, newMemories: 2,
        typesAdded: { decision: 2 }, source: 'manual',
      });

      const rows = testDb.prepare('SELECT * FROM learning_deltas').all();
      expect(rows).toHaveLength(2);
    });
  });

  describe('appendRawEntry', () => {
    it('should insert raw entry with zero counts', () => {
      appendRawEntry('manual note');

      const row = testDb.prepare('SELECT * FROM learning_deltas').get() as any;
      expect(row.source).toBe('manual note');
      expect(row.new_memories).toBe(0);
      expect(row.memories_before).toBe(0);
      expect(row.memories_after).toBe(0);
    });

    it('should have an ISO timestamp', () => {
      appendRawEntry('test entry');

      const row = testDb.prepare('SELECT * FROM learning_deltas').get() as any;
      expect(row.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('readProgressLog', () => {
    it('should return empty array for empty table', () => {
      const entries = readProgressLog();
      expect(entries).toEqual([]);
    });

    it('should return formatted entries in reverse chronological order', () => {
      appendProgressEntry({
        timestamp: '2026-02-06T10:00:00Z',
        memoriesBefore: 0, memoriesAfter: 3, newMemories: 3,
        typesAdded: { learning: 3 }, source: 'first',
      });
      appendProgressEntry({
        timestamp: '2026-02-06T12:00:00Z',
        memoriesBefore: 3, memoriesAfter: 5, newMemories: 2,
        typesAdded: { decision: 2 }, source: 'second',
      });

      const entries = readProgressLog();
      expect(entries).toHaveLength(2);
      expect(entries[0]).toContain('second');
      expect(entries[1]).toContain('first');
    });

    it('should respect limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        appendProgressEntry({
          timestamp: `2026-02-0${i + 1}T10:00:00Z`,
          memoriesBefore: i, memoriesAfter: i + 1, newMemories: 1,
          typesAdded: { learning: 1 }, source: `entry-${i}`,
        });
      }

      const entries = readProgressLog({ limit: 3 });
      expect(entries).toHaveLength(3);
      expect(entries[0]).toContain('entry-4'); // Most recent
    });

    it('should filter by since (ISO date)', () => {
      appendProgressEntry({
        timestamp: '2026-01-01T10:00:00Z',
        memoriesBefore: 0, memoriesAfter: 1, newMemories: 1,
        typesAdded: {}, source: 'old',
      });
      appendProgressEntry({
        timestamp: '2026-02-05T10:00:00Z',
        memoriesBefore: 1, memoriesAfter: 2, newMemories: 1,
        typesAdded: {}, source: 'recent',
      });

      const entries = readProgressLog({ since: '2026-02-01' });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toContain('recent');
    });

    it('should format entries with types', () => {
      appendProgressEntry({
        timestamp: '2026-02-06T12:00:00Z',
        memoriesBefore: 5, memoriesAfter: 8, newMemories: 3,
        typesAdded: { decision: 2, learning: 1 }, source: 'session-summary',
      });

      const entries = readProgressLog();
      expect(entries[0]).toContain('+3 facts');
      expect(entries[0]).toContain('5 \u2192 8');
      expect(entries[0]).toContain('decision:2');
    });
  });

  describe('getProgressEntries', () => {
    it('should return structured rows', () => {
      appendProgressEntry({
        timestamp: '2026-02-06T12:00:00Z',
        memoriesBefore: 10, memoriesAfter: 15, newMemories: 5,
        typesAdded: { learning: 5 }, source: 'session-summary',
      });

      const entries = getProgressEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].source).toBe('session-summary');
      expect(entries[0].new_memories).toBe(5);
      expect(entries[0].id).toBeDefined();
    });

    it('should respect limit', () => {
      for (let i = 0; i < 5; i++) {
        appendProgressEntry({
          timestamp: `2026-02-0${i + 1}T10:00:00Z`,
          memoriesBefore: i, memoriesAfter: i + 1, newMemories: 1,
          typesAdded: {}, source: `e${i}`,
        });
      }

      const entries = getProgressEntries({ limit: 2 });
      expect(entries).toHaveLength(2);
    });
  });
});
