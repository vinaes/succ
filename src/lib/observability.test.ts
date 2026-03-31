import { describe, it, expect, vi } from 'vitest';
import { recordLatency, withLatency, getLatencyStats } from './observability.js';

// Mock storage dependencies to avoid real DB connections
vi.mock('./storage/index.js', () => ({
  getMemoryHealth: vi.fn(async () => ({
    total: 0,
    never_accessed: 0,
    stale: 0,
    avg_age_days: 0,
    avg_access: 0,
  })),
  getStats: vi.fn(async () => ({ total_documents: 0, total_files: 0, last_indexed: null })),
  getCodeFileCount: vi.fn(async () => 0),
  getTokenStatsSummary: vi.fn(async () => ({
    total_savings_tokens: 0,
    total_full_source_tokens: 0,
  })),
  getStorageDispatcher: vi.fn(async () => ({ flushSessionCounters: vi.fn() })),
}));

vi.mock('./fault-logger.js', () => ({
  logWarn: vi.fn(),
}));

describe('observability', () => {
  describe('latency tracking', () => {
    it('should record and retrieve latency metrics', () => {
      recordLatency('test-op', 42);
      recordLatency('test-op', 58);

      const stats = getLatencyStats('test-op');
      expect(stats).toHaveLength(1);
      expect(stats[0].operation).toBe('test-op');
      expect(stats[0].count).toBeGreaterThanOrEqual(2);
      expect(stats[0].avgMs).toBeGreaterThan(0);
    });

    it('withLatency should measure and record async operation', async () => {
      const result = await withLatency('async-test', async () => {
        return 'hello';
      });

      expect(result).toBe('hello');
      const stats = getLatencyStats('async-test');
      expect(stats.length).toBeGreaterThanOrEqual(1);
    });

    it('withLatency should record even if operation throws', async () => {
      try {
        await withLatency('failing-op', async () => {
          throw new Error('boom');
        });
      } catch {
        // expected
      }

      const stats = getLatencyStats('failing-op');
      expect(stats.length).toBeGreaterThanOrEqual(1);
    });

    it('should group stats by operation', () => {
      recordLatency('op-a', 10);
      recordLatency('op-b', 20);
      recordLatency('op-a', 30);

      const stats = getLatencyStats();
      const opA = stats.find((s) => s.operation === 'op-a');
      const opB = stats.find((s) => s.operation === 'op-b');

      expect(opA).toBeDefined();
      expect(opB).toBeDefined();
      expect(opA!.count).toBeGreaterThanOrEqual(2);
    });

    it('should compute p95 correctly', () => {
      // Add 100 samples
      for (let i = 1; i <= 100; i++) {
        recordLatency('p95-test', i);
      }

      const stats = getLatencyStats('p95-test');
      expect(stats).toHaveLength(1);
      expect(stats[0].p95Ms).toBeGreaterThanOrEqual(90);
    });
  });
});
