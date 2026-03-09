import { describe, it, expect, vi } from 'vitest';

vi.mock('../graph/graphology-bridge.js', () => ({
  personalizedPageRank: vi.fn(async () => [
    { memoryId: 1, score: 0.9 },
    { memoryId: 2, score: 0.5 },
    { memoryId: 3, score: 0.3 },
  ]),
  computePageRank: vi.fn(
    async () =>
      new Map([
        [1, 0.08],
        [2, 0.12],
        [3, 0.04],
      ])
  ),
}));

vi.mock('../retrieval-feedback.js', () => ({
  getBoostFactors: vi.fn(
    () =>
      new Map([
        [1, 1.3],
        [2, 0.7],
        [3, 1.0],
      ])
  ),
}));

vi.mock('../fault-logger.js', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { pprEnhancedRerank } from './ppr-retrieval.js';

describe('PPR-enhanced retrieval', () => {
  it('should combine semantic, PPR, centrality, and feedback scores', async () => {
    const semanticResults = [
      { memoryId: 1, similarity: 0.95 },
      { memoryId: 2, similarity: 0.85 },
    ];

    const results = await pprEnhancedRerank(semanticResults);

    expect(results.length).toBeGreaterThan(0);
    // All results should have score components
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.components).toBeDefined();
      expect(r.rankExplain).toBeTruthy();
    }
  });

  it('should return empty for empty input', async () => {
    const results = await pprEnhancedRerank([]);
    expect(results).toHaveLength(0);
  });

  it('should include PPR-discovered nodes', async () => {
    const semanticResults = [{ memoryId: 1, similarity: 0.9 }];

    const results = await pprEnhancedRerank(semanticResults);
    // Should include node 3 from PPR even though it wasn't in semantic results
    const ids = results.map((r) => r.memoryId);
    expect(ids).toContain(3);
  });

  it('should respect limit option', async () => {
    const semanticResults = [
      { memoryId: 1, similarity: 0.9 },
      { memoryId: 2, similarity: 0.8 },
    ];

    const results = await pprEnhancedRerank(semanticResults, { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('should apply feedback boost', async () => {
    const semanticResults = [
      { memoryId: 1, similarity: 0.9 }, // 1.3x boost
      { memoryId: 2, similarity: 0.9 }, // 0.7x decay
    ];

    const results = await pprEnhancedRerank(semanticResults);
    const mem1 = results.find((r) => r.memoryId === 1);
    const mem2 = results.find((r) => r.memoryId === 2);

    expect(mem1).toBeDefined();
    expect(mem2).toBeDefined();
    // Mem1 should rank higher due to feedback boost
    expect(mem1!.score).toBeGreaterThan(mem2!.score);
  });
});
