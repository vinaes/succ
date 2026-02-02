import { describe, it, expect } from 'vitest';
import {
  recallAtK,
  reciprocalRank,
  meanReciprocalRank,
  dcg,
  ndcg,
  calculateAccuracyMetrics,
  calculateLatencyStats,
  generateTestDataset,
} from './benchmark.js';

describe('Benchmark Metrics', () => {
  describe('recallAtK', () => {
    it('returns 1.0 when all relevant items are in top K', () => {
      const results = [
        { id: 1, score: 0.9 },
        { id: 2, score: 0.8 },
        { id: 3, score: 0.7 },
      ];
      const relevant = new Set([1, 2]);
      expect(recallAtK(results, relevant, 3)).toBe(1.0);
    });

    it('returns 0.5 when half of relevant items are in top K', () => {
      const results = [
        { id: 1, score: 0.9 },
        { id: 3, score: 0.8 },
      ];
      const relevant = new Set([1, 2]);
      expect(recallAtK(results, relevant, 2)).toBe(0.5);
    });

    it('returns 0 when no relevant items are in top K', () => {
      const results = [
        { id: 3, score: 0.9 },
        { id: 4, score: 0.8 },
      ];
      const relevant = new Set([1, 2]);
      expect(recallAtK(results, relevant, 2)).toBe(0);
    });

    it('returns 0 when relevant set is empty', () => {
      const results = [{ id: 1, score: 0.9 }];
      const relevant = new Set<number>();
      expect(recallAtK(results, relevant, 1)).toBe(0);
    });

    it('handles K larger than results length', () => {
      const results = [{ id: 1, score: 0.9 }];
      const relevant = new Set([1, 2]);
      expect(recallAtK(results, relevant, 5)).toBe(0.5);
    });
  });

  describe('reciprocalRank', () => {
    it('returns 1.0 when first result is relevant', () => {
      const results = [
        { id: 1, score: 0.9 },
        { id: 2, score: 0.8 },
      ];
      const relevant = new Set([1]);
      expect(reciprocalRank(results, relevant)).toBe(1.0);
    });

    it('returns 0.5 when second result is first relevant', () => {
      const results = [
        { id: 3, score: 0.9 },
        { id: 1, score: 0.8 },
      ];
      const relevant = new Set([1]);
      expect(reciprocalRank(results, relevant)).toBe(0.5);
    });

    it('returns 0.333... when third result is first relevant', () => {
      const results = [
        { id: 3, score: 0.9 },
        { id: 4, score: 0.8 },
        { id: 1, score: 0.7 },
      ];
      const relevant = new Set([1]);
      expect(reciprocalRank(results, relevant)).toBeCloseTo(1 / 3, 5);
    });

    it('returns 0 when no relevant results', () => {
      const results = [
        { id: 3, score: 0.9 },
        { id: 4, score: 0.8 },
      ];
      const relevant = new Set([1, 2]);
      expect(reciprocalRank(results, relevant)).toBe(0);
    });
  });

  describe('meanReciprocalRank', () => {
    it('calculates average of reciprocal ranks', () => {
      const queries = [
        {
          results: [{ id: 1, score: 0.9 }],
          relevantIds: new Set([1]), // RR = 1.0
        },
        {
          results: [
            { id: 3, score: 0.9 },
            { id: 1, score: 0.8 },
          ],
          relevantIds: new Set([1]), // RR = 0.5
        },
      ];
      expect(meanReciprocalRank(queries)).toBe(0.75);
    });

    it('returns 0 for empty queries', () => {
      expect(meanReciprocalRank([])).toBe(0);
    });
  });

  describe('dcg', () => {
    it('calculates DCG correctly', () => {
      const results = [
        { id: 1, score: 0.9 },
        { id: 2, score: 0.8 },
        { id: 3, score: 0.7 },
      ];
      const relevance = new Map([
        [1, 3],
        [2, 2],
        [3, 1],
      ]);
      // DCG = (2^3-1)/log2(2) + (2^2-1)/log2(3) + (2^1-1)/log2(4)
      //     = 7/1 + 3/1.585 + 1/2
      //     = 7 + 1.893 + 0.5 = 9.393
      const result = dcg(results, relevance, 3);
      expect(result).toBeCloseTo(9.393, 2);
    });

    it('returns 0 for non-relevant results', () => {
      const results = [{ id: 1, score: 0.9 }];
      const relevance = new Map<number, number>();
      expect(dcg(results, relevance, 1)).toBe(0);
    });
  });

  describe('ndcg', () => {
    it('returns 1.0 for perfect ranking', () => {
      const results = [
        { id: 1, score: 0.9 },
        { id: 2, score: 0.8 },
      ];
      const relevance = new Map([
        [1, 3],
        [2, 2],
      ]);
      expect(ndcg(results, relevance, 2)).toBeCloseTo(1.0, 5);
    });

    it('returns less than 1.0 for imperfect ranking', () => {
      const results = [
        { id: 2, score: 0.9 }, // rel=2
        { id: 1, score: 0.8 }, // rel=3
      ];
      const relevance = new Map([
        [1, 3],
        [2, 2],
      ]);
      // Actual order: 2, 1 (scores: 2, 3)
      // Ideal order: 1, 2 (scores: 3, 2)
      const result = ndcg(results, relevance, 2);
      expect(result).toBeLessThan(1.0);
      expect(result).toBeGreaterThan(0);
    });

    it('returns 0 when no relevant items', () => {
      const results = [{ id: 1, score: 0.9 }];
      const relevance = new Map<number, number>();
      expect(ndcg(results, relevance, 1)).toBe(0);
    });
  });

  describe('calculateAccuracyMetrics', () => {
    it('calculates all metrics correctly', () => {
      const queries = [
        {
          results: [
            { id: 1, score: 0.9 },
            { id: 2, score: 0.8 },
          ],
          relevantIds: new Set([1, 2]),
        },
        {
          results: [
            { id: 3, score: 0.9 },
            { id: 4, score: 0.8 },
          ],
          relevantIds: new Set([5, 6]),
        },
      ];
      const metrics = calculateAccuracyMetrics(queries, 2);

      expect(metrics.queryCount).toBe(2);
      expect(metrics.queriesWithHits).toBe(1);
      expect(metrics.k).toBe(2);
      expect(metrics.recallAtK).toBe(0.5); // First query: 100%, second: 0%
      expect(metrics.mrr).toBe(0.5); // First query: 1.0, second: 0
    });

    it('returns zeros for empty queries', () => {
      const metrics = calculateAccuracyMetrics([], 5);
      expect(metrics.recallAtK).toBe(0);
      expect(metrics.mrr).toBe(0);
      expect(metrics.ndcg).toBe(0);
      expect(metrics.queryCount).toBe(0);
    });
  });

  describe('calculateLatencyStats', () => {
    it('calculates statistics correctly', () => {
      const measurements = [10, 20, 30, 40, 50];
      const stats = calculateLatencyStats(measurements);

      expect(stats.min).toBe(10);
      expect(stats.max).toBe(50);
      expect(stats.avg).toBe(30);
      expect(stats.p50).toBe(30);
      expect(stats.samples).toBe(5);
    });

    it('handles single measurement', () => {
      const stats = calculateLatencyStats([42]);
      expect(stats.min).toBe(42);
      expect(stats.max).toBe(42);
      expect(stats.avg).toBe(42);
      expect(stats.p50).toBe(42);
      expect(stats.samples).toBe(1);
    });

    it('returns zeros for empty array', () => {
      const stats = calculateLatencyStats([]);
      expect(stats.min).toBe(0);
      expect(stats.max).toBe(0);
      expect(stats.avg).toBe(0);
      expect(stats.samples).toBe(0);
    });
  });

  describe('generateTestDataset', () => {
    it('generates valid dataset', () => {
      const dataset = generateTestDataset();

      // Check memories
      expect(dataset.memories.length).toBeGreaterThan(0);
      for (const mem of dataset.memories) {
        expect(mem.content).toBeTruthy();
        expect(Array.isArray(mem.tags)).toBe(true);
        expect(mem.category).toBeTruthy();
      }

      // Check queries
      expect(dataset.queries.length).toBeGreaterThan(0);
      for (const q of dataset.queries) {
        expect(q.query).toBeTruthy();
        expect(Array.isArray(q.relevantIds)).toBe(true);
        expect(q.relevantIds.length).toBeGreaterThan(0);
      }
    });

    it('generates diverse categories', () => {
      const dataset = generateTestDataset();
      const categories = new Set(dataset.memories.map((m) => m.category));
      expect(categories.size).toBeGreaterThanOrEqual(5);
    });
  });
});
