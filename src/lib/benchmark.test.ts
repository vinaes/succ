import { describe, it, expect } from 'vitest';
import {
  recallAtK,
  precisionAtK,
  f1AtK,
  reciprocalRank,
  meanReciprocalRank,
  dcg,
  ndcg,
  calculateAccuracyMetrics,
  calculateLatencyStats,
  generateTestDataset,
  compareBenchmarks,
  compareHybridModes,
  generateBenchmarkId,
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

  describe('precisionAtK', () => {
    it('returns 1.0 when all top K results are relevant', () => {
      const results = [
        { id: 1, score: 0.9 },
        { id: 2, score: 0.8 },
      ];
      const relevant = new Set([1, 2, 3, 4]);
      expect(precisionAtK(results, relevant, 2)).toBe(1.0);
    });

    it('returns 0.5 when half of top K results are relevant', () => {
      const results = [
        { id: 1, score: 0.9 },
        { id: 3, score: 0.8 },
      ];
      const relevant = new Set([1, 2]);
      expect(precisionAtK(results, relevant, 2)).toBe(0.5);
    });

    it('returns 0 when no top K results are relevant', () => {
      const results = [
        { id: 3, score: 0.9 },
        { id: 4, score: 0.8 },
      ];
      const relevant = new Set([1, 2]);
      expect(precisionAtK(results, relevant, 2)).toBe(0);
    });

    it('returns 0 when K is 0', () => {
      const results = [{ id: 1, score: 0.9 }];
      const relevant = new Set([1]);
      expect(precisionAtK(results, relevant, 0)).toBe(0);
    });
  });

  describe('f1AtK', () => {
    it('returns 1.0 when precision and recall are both 1.0', () => {
      const results = [
        { id: 1, score: 0.9 },
        { id: 2, score: 0.8 },
      ];
      const relevant = new Set([1, 2]);
      expect(f1AtK(results, relevant, 2)).toBe(1.0);
    });

    it('returns 0 when both precision and recall are 0', () => {
      const results = [
        { id: 3, score: 0.9 },
        { id: 4, score: 0.8 },
      ];
      const relevant = new Set([1, 2]);
      expect(f1AtK(results, relevant, 2)).toBe(0);
    });

    it('calculates harmonic mean correctly', () => {
      // precision = 1/2 = 0.5, recall = 1/4 = 0.25
      // F1 = 2 * (0.5 * 0.25) / (0.5 + 0.25) = 0.333...
      const results = [
        { id: 1, score: 0.9 },
        { id: 3, score: 0.8 },
      ];
      const relevant = new Set([1, 2, 5, 6]);
      expect(f1AtK(results, relevant, 2)).toBeCloseTo(1 / 3, 5);
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
      expect(metrics.precisionAtK).toBe(0.5); // First query: 100%, second: 0%
      expect(metrics.f1AtK).toBe(0.5); // First query: 100%, second: 0%
      expect(metrics.mrr).toBe(0.5); // First query: 1.0, second: 0
    });

    it('returns zeros for empty queries', () => {
      const metrics = calculateAccuracyMetrics([], 5);
      expect(metrics.recallAtK).toBe(0);
      expect(metrics.precisionAtK).toBe(0);
      expect(metrics.f1AtK).toBe(0);
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

  describe('compareBenchmarks', () => {
    it('detects regression when F1 drops significantly', () => {
      const current = {
        recallAtK: 0.8,
        precisionAtK: 0.7,
        f1AtK: 0.7,
        k: 5,
        mrr: 0.8,
        ndcg: 0.75,
        queryCount: 10,
        queriesWithHits: 8,
      };
      const previous = {
        recallAtK: 0.85,
        precisionAtK: 0.8,
        f1AtK: 0.8,
        k: 5,
        mrr: 0.85,
        ndcg: 0.8,
        queryCount: 10,
        queriesWithHits: 9,
      };
      const comparison = compareBenchmarks(current, previous);
      expect(comparison.isRegression).toBe(true);
      expect(comparison.isImprovement).toBe(false);
      expect(comparison.f1Delta).toBeCloseTo(-0.1, 5);
    });

    it('detects improvement when F1 increases significantly', () => {
      const current = {
        recallAtK: 0.9,
        precisionAtK: 0.85,
        f1AtK: 0.87,
        k: 5,
        mrr: 0.9,
        ndcg: 0.85,
        queryCount: 10,
        queriesWithHits: 9,
      };
      const previous = {
        recallAtK: 0.8,
        precisionAtK: 0.75,
        f1AtK: 0.77,
        k: 5,
        mrr: 0.8,
        ndcg: 0.75,
        queryCount: 10,
        queriesWithHits: 8,
      };
      const comparison = compareBenchmarks(current, previous);
      expect(comparison.isRegression).toBe(false);
      expect(comparison.isImprovement).toBe(true);
      expect(comparison.f1Delta).toBeCloseTo(0.1, 5);
    });

    it('reports no significant change for small differences', () => {
      const current = {
        recallAtK: 0.81,
        precisionAtK: 0.76,
        f1AtK: 0.78,
        k: 5,
        mrr: 0.81,
        ndcg: 0.76,
        queryCount: 10,
        queriesWithHits: 8,
      };
      const previous = {
        recallAtK: 0.8,
        precisionAtK: 0.75,
        f1AtK: 0.77,
        k: 5,
        mrr: 0.8,
        ndcg: 0.75,
        queryCount: 10,
        queriesWithHits: 8,
      };
      const comparison = compareBenchmarks(current, previous);
      expect(comparison.isRegression).toBe(false);
      expect(comparison.isImprovement).toBe(false);
    });
  });

  describe('compareHybridModes', () => {
    it('identifies hybrid as best when it has highest F1', () => {
      const semantic = {
        recallAtK: 0.7,
        precisionAtK: 0.6,
        f1AtK: 0.65,
        k: 5,
        mrr: 0.7,
        ndcg: 0.65,
        queryCount: 10,
        queriesWithHits: 7,
      };
      const bm25 = {
        recallAtK: 0.6,
        precisionAtK: 0.5,
        f1AtK: 0.55,
        k: 5,
        mrr: 0.6,
        ndcg: 0.55,
        queryCount: 10,
        queriesWithHits: 6,
      };
      const hybrid = {
        recallAtK: 0.8,
        precisionAtK: 0.7,
        f1AtK: 0.75,
        k: 5,
        mrr: 0.8,
        ndcg: 0.75,
        queryCount: 10,
        queriesWithHits: 8,
      };

      const result = compareHybridModes(semantic, bm25, hybrid);
      expect(result.bestMode).toBe('hybrid');
      expect(result.hybridVsSemantic).toBeCloseTo(0.1, 5);
      expect(result.hybridVsBm25).toBeCloseTo(0.2, 5);
    });

    it('identifies semantic as best when it has highest F1', () => {
      const semantic = {
        recallAtK: 0.9,
        precisionAtK: 0.85,
        f1AtK: 0.87,
        k: 5,
        mrr: 0.9,
        ndcg: 0.85,
        queryCount: 10,
        queriesWithHits: 9,
      };
      const bm25 = {
        recallAtK: 0.6,
        precisionAtK: 0.5,
        f1AtK: 0.55,
        k: 5,
        mrr: 0.6,
        ndcg: 0.55,
        queryCount: 10,
        queriesWithHits: 6,
      };
      const hybrid = {
        recallAtK: 0.8,
        precisionAtK: 0.7,
        f1AtK: 0.75,
        k: 5,
        mrr: 0.8,
        ndcg: 0.75,
        queryCount: 10,
        queriesWithHits: 8,
      };

      const result = compareHybridModes(semantic, bm25, hybrid);
      expect(result.bestMode).toBe('semantic');
    });
  });

  describe('generateBenchmarkId', () => {
    it('generates unique IDs', () => {
      const id1 = generateBenchmarkId();
      const id2 = generateBenchmarkId();
      expect(id1).not.toBe(id2);
    });

    it('starts with bench- prefix', () => {
      const id = generateBenchmarkId();
      expect(id.startsWith('bench-')).toBe(true);
    });
  });
});
