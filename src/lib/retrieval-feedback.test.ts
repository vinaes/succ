import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database
const mockRun = vi.fn().mockReturnValue({ lastInsertRowid: 1, changes: 0 });
const mockGet = vi.fn();
const mockAll = vi.fn().mockReturnValue([]);
const mockPrepare = vi.fn().mockReturnValue({ run: mockRun, get: mockGet, all: mockAll });
const mockTransaction = vi.fn((fn: () => void) => fn);
const mockDb = { prepare: mockPrepare, transaction: mockTransaction };

vi.mock('./db/connection.js', () => ({
  getDb: vi.fn(() => mockDb),
  cachedPrepare: vi.fn(() => ({ run: mockRun, get: mockGet, all: mockAll })),
  onDbChange: vi.fn(),
}));

vi.mock('./fault-logger.js', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const mockDeleteOldRecallEvents = vi.fn().mockResolvedValue(0);
const mockBoostMemoryConfidence = vi.fn().mockResolvedValue(true);
const mockDegradeMemoryConfidence = vi.fn().mockResolvedValue(true);
vi.mock('./storage/index.js', () => ({
  deleteOldRecallEvents: (...args: unknown[]) => mockDeleteOldRecallEvents(...args),
  boostMemoryConfidence: (...args: unknown[]) => mockBoostMemoryConfidence(...args),
  degradeMemoryConfidence: (...args: unknown[]) => mockDegradeMemoryConfidence(...args),
  getStorageDispatcher: vi.fn(async () => ({ flushSessionCounters: vi.fn() })),
}));

import {
  recordRecallEvent,
  recordRecallBatch,
  getRecallStats,
  getRecallSummary,
  getBoostFactor,
  getBoostFactors,
  getNeverUsedMemories,
  cleanupRecallEvents,
} from './retrieval-feedback.js';

describe('retrieval-feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRun.mockReturnValue({ lastInsertRowid: 1, changes: 0 });
  });

  describe('recordRecallEvent', () => {
    it('should record a recall event', () => {
      const id = recordRecallEvent(42, 'auth flow', true, 1, 0.95);
      expect(id).toBe(1);
      expect(mockRun).toHaveBeenCalledWith(42, 'auth flow', 1, 1, 0.95);
    });

    it('should handle unused memory', () => {
      recordRecallEvent(42, 'auth flow', false, 5, 0.3);
      expect(mockRun).toHaveBeenCalledWith(42, 'auth flow', 0, 5, 0.3);
    });

    it('should handle missing optional params', () => {
      recordRecallEvent(42, 'query');
      expect(mockRun).toHaveBeenCalledWith(42, 'query', 0, null, null);
    });

    it('should return 0 on error', () => {
      mockRun.mockImplementationOnce(() => {
        throw new Error('DB error');
      });
      const id = recordRecallEvent(42, 'query', true);
      expect(id).toBe(0);
    });
  });

  describe('recordRecallBatch', () => {
    it('should record batch of recall events', () => {
      const usedIds = new Set([1, 3]);
      recordRecallBatch([1, 2, 3, 4], usedIds, 'test query');
      // Should be called within a transaction
      expect(mockTransaction).toHaveBeenCalled();
    });
  });

  describe('getRecallStats', () => {
    it('should return stats for a memory', () => {
      mockGet.mockReturnValueOnce({
        total_recalls: 10,
        times_used: 7,
        avg_rank_used: 2.5,
        avg_rank_ignored: 8.0,
        last_recalled: '2026-03-01',
      });

      const stats = getRecallStats(42);
      expect(stats.memoryId).toBe(42);
      expect(stats.totalRecalls).toBe(10);
      expect(stats.timesUsed).toBe(7);
      expect(stats.timesIgnored).toBe(3);
      expect(stats.useRate).toBeCloseTo(0.7);
      expect(stats.avgRankWhenUsed).toBe(2.5);
      expect(stats.boostFactor).toBeGreaterThan(1.0);
    });

    it('should handle memory with no recall history', () => {
      mockGet.mockReturnValueOnce({
        total_recalls: 0,
        times_used: 0,
        avg_rank_used: null,
        avg_rank_ignored: null,
        last_recalled: null,
      });

      const stats = getRecallStats(99);
      expect(stats.totalRecalls).toBe(0);
      expect(stats.useRate).toBe(0);
      expect(stats.boostFactor).toBe(1.0);
    });
  });

  describe('getRecallSummary', () => {
    it('should return summary across all memories', () => {
      mockGet
        .mockReturnValueOnce({ total: 100, unique_mems: 25, total_used: 60 })
        .mockReturnValueOnce({ count: 5 });
      mockAll
        .mockReturnValueOnce([{ memoryId: 1, useRate: 0.9, totalRecalls: 10 }])
        .mockReturnValueOnce([{ memoryId: 2, useRate: 0.1, totalRecalls: 10 }]);

      const summary = getRecallSummary();
      expect(summary.totalEvents).toBe(100);
      expect(summary.uniqueMemories).toBe(25);
      expect(summary.overallUseRate).toBeCloseTo(0.6);
      expect(summary.neverUsedMemories).toBe(5);
      expect(summary.topPerformers).toHaveLength(1);
      expect(summary.worstPerformers).toHaveLength(1);
    });
  });

  describe('getBoostFactor', () => {
    it('should return neutral for no history', () => {
      mockGet.mockReturnValueOnce({ total: 0, used: 0 });
      expect(getBoostFactor(1)).toBe(1.0);
    });

    it('should boost high-usage memories', () => {
      mockGet.mockReturnValueOnce({ total: 10, used: 9 });
      expect(getBoostFactor(1)).toBe(1.3);
    });

    it('should decay low-usage memories', () => {
      mockGet.mockReturnValueOnce({ total: 10, used: 1 });
      expect(getBoostFactor(1)).toBe(0.7);
    });

    it('should return moderate boost for medium usage', () => {
      mockGet.mockReturnValueOnce({ total: 10, used: 7 });
      expect(getBoostFactor(1)).toBe(1.15);
    });
  });

  describe('getBoostFactors', () => {
    it('should return factors for multiple memories', () => {
      mockAll.mockReturnValueOnce([
        { memory_id: 1, total: 10, used: 9 },
        { memory_id: 2, total: 10, used: 1 },
      ]);

      const factors = getBoostFactors([1, 2, 3]);
      expect(factors.get(1)).toBe(1.3); // high usage (90%)
      expect(factors.get(2)).toBe(0.7); // low usage (10%)
      expect(factors.get(3)).toBe(1.0); // no data → neutral
    });

    it('should handle empty input', () => {
      const factors = getBoostFactors([]);
      expect(factors.size).toBe(0);
    });
  });

  describe('getNeverUsedMemories', () => {
    it('should return never-used memories', () => {
      mockAll.mockReturnValueOnce([{ memoryId: 5, totalRecalls: 8, lastRecalled: '2026-03-01' }]);

      const result = getNeverUsedMemories(3, 50);
      expect(result).toHaveLength(1);
      expect(result[0].memoryId).toBe(5);
      expect(result[0].totalRecalls).toBe(8);
    });
  });

  describe('cleanupRecallEvents', () => {
    it('should delete old events via storage dispatcher', async () => {
      mockDeleteOldRecallEvents.mockResolvedValueOnce(15);
      const deleted = await cleanupRecallEvents(90);
      expect(deleted).toBe(15);
      expect(mockDeleteOldRecallEvents).toHaveBeenCalledWith(90);
    });

    it('should use default retention of 30 days', async () => {
      mockDeleteOldRecallEvents.mockResolvedValueOnce(0);
      await cleanupRecallEvents();
      expect(mockDeleteOldRecallEvents).toHaveBeenCalledWith(30);
    });

    it('should propagate storage errors', async () => {
      mockDeleteOldRecallEvents.mockRejectedValueOnce(new Error('DB locked'));
      await expect(cleanupRecallEvents(90)).rejects.toThrow('DB locked');
    });
  });
});
