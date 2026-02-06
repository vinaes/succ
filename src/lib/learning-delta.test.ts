/**
 * Learning Delta Tests (Phase 7.4)
 *
 * Tests for memory snapshot, delta calculation, and log entry formatting.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateLearningDelta,
  formatDeltaLogEntry,
  type MemorySnapshot,
  type LearningDelta,
} from './learning-delta.js';

describe('Learning Delta', () => {
  describe('calculateLearningDelta', () => {
    it('calculates correct delta for new memories', () => {
      const before: MemorySnapshot = {
        totalMemories: 10,
        byType: { observation: 5, decision: 3, learning: 2 },
        timestamp: '2026-02-06T10:00:00Z',
      };
      const after: MemorySnapshot = {
        totalMemories: 15,
        byType: { observation: 7, decision: 4, learning: 3, pattern: 1 },
        timestamp: '2026-02-06T11:00:00Z',
      };

      const delta = calculateLearningDelta(before, after, 'session-summary');

      expect(delta.newMemories).toBe(5);
      expect(delta.memoriesBefore).toBe(10);
      expect(delta.memoriesAfter).toBe(15);
      expect(delta.source).toBe('session-summary');
      expect(delta.typesAdded).toEqual({
        observation: 2,
        decision: 1,
        learning: 1,
        pattern: 1,
      });
    });

    it('handles no change (0 new memories)', () => {
      const snapshot: MemorySnapshot = {
        totalMemories: 10,
        byType: { observation: 5, decision: 5 },
        timestamp: '2026-02-06T10:00:00Z',
      };

      const delta = calculateLearningDelta(snapshot, snapshot, 'manual');

      expect(delta.newMemories).toBe(0);
      expect(delta.typesAdded).toEqual({});
    });

    it('clamps negative delta to 0', () => {
      const before: MemorySnapshot = {
        totalMemories: 15,
        byType: { observation: 10, decision: 5 },
        timestamp: '2026-02-06T10:00:00Z',
      };
      const after: MemorySnapshot = {
        totalMemories: 12,
        byType: { observation: 8, decision: 4 },
        timestamp: '2026-02-06T11:00:00Z',
      };

      const delta = calculateLearningDelta(before, after);

      // Deletions happened but we clamp to 0
      expect(delta.newMemories).toBe(0);
    });

    it('handles entirely new types', () => {
      const before: MemorySnapshot = {
        totalMemories: 5,
        byType: { observation: 5 },
        timestamp: '2026-02-06T10:00:00Z',
      };
      const after: MemorySnapshot = {
        totalMemories: 8,
        byType: { observation: 5, dead_end: 2, error: 1 },
        timestamp: '2026-02-06T11:00:00Z',
      };

      const delta = calculateLearningDelta(before, after);

      expect(delta.typesAdded).toEqual({ dead_end: 2, error: 1 });
    });

    it('uses after.timestamp for delta timestamp', () => {
      const before: MemorySnapshot = {
        totalMemories: 0,
        byType: {},
        timestamp: '2026-02-06T10:00:00Z',
      };
      const after: MemorySnapshot = {
        totalMemories: 3,
        byType: { learning: 3 },
        timestamp: '2026-02-06T12:00:00Z',
      };

      const delta = calculateLearningDelta(before, after);

      expect(delta.timestamp).toBe('2026-02-06T12:00:00Z');
    });

    it('defaults source to session-summary', () => {
      const snapshot: MemorySnapshot = {
        totalMemories: 0,
        byType: {},
        timestamp: '2026-02-06T10:00:00Z',
      };

      const delta = calculateLearningDelta(snapshot, snapshot);

      expect(delta.source).toBe('session-summary');
    });
  });

  describe('formatDeltaLogEntry', () => {
    it('formats basic delta entry', () => {
      const delta: LearningDelta = {
        timestamp: '2026-02-06T12:00:00Z',
        memoriesBefore: 10,
        memoriesAfter: 15,
        newMemories: 5,
        typesAdded: { learning: 3, decision: 2 },
        source: 'session-summary',
      };

      const entry = formatDeltaLogEntry(delta);

      expect(entry).toContain('[2026-02-06T12:00:00Z]');
      expect(entry).toContain('session-summary');
      expect(entry).toContain('+5 facts');
      expect(entry).toContain('10 → 15');
      expect(entry).toContain('learning:3');
      expect(entry).toContain('decision:2');
    });

    it('formats entry with no types', () => {
      const delta: LearningDelta = {
        timestamp: '2026-02-06T12:00:00Z',
        memoriesBefore: 10,
        memoriesAfter: 10,
        newMemories: 0,
        typesAdded: {},
        source: 'manual',
      };

      const entry = formatDeltaLogEntry(delta);

      expect(entry).toContain('+0 facts');
      expect(entry).not.toContain('types:');
    });

    it('includes source name', () => {
      const delta: LearningDelta = {
        timestamp: '2026-02-06T12:00:00Z',
        memoriesBefore: 0,
        memoriesAfter: 1,
        newMemories: 1,
        typesAdded: { observation: 1 },
        source: 'manual',
      };

      const entry = formatDeltaLogEntry(delta);

      expect(entry).toContain('manual');
    });
  });
});
