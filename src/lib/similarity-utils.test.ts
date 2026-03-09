import { describe, it, expect } from 'vitest';
import { cosineSimilarity, findSimilarPairs, groupByUnionFind } from './similarity-utils.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('returns 0 for zero vector', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('returns 0 for both zero vectors', () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it('handles multi-dimensional vectors', () => {
    const a = [1, 2, 3];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1);
  });

  it('computes partial similarity correctly', () => {
    // [1,1] and [1,0]: cos = 1/sqrt(2) ≈ 0.707
    const sim = cosineSimilarity([1, 1], [1, 0]);
    expect(sim).toBeCloseTo(Math.SQRT1_2);
  });
});

describe('findSimilarPairs', () => {
  it('returns empty array when fewer than 2 items', () => {
    const items = [{ id: 1, embedding: [1, 0] }];
    expect(findSimilarPairs(items, 0.9)).toEqual([]);
  });

  it('returns empty array when no pairs exceed threshold', () => {
    const items = [
      { id: 1, embedding: [1, 0] },
      { id: 2, embedding: [0, 1] },
    ];
    expect(findSimilarPairs(items, 0.9)).toEqual([]);
  });

  it('finds identical pairs', () => {
    const items = [
      { id: 1, embedding: [1, 0] },
      { id: 2, embedding: [1, 0] },
    ];
    const pairs = findSimilarPairs(items, 0.99);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].a).toBe(1);
    expect(pairs[0].b).toBe(2);
    expect(pairs[0].similarity).toBeCloseTo(1);
  });

  it('finds multiple similar pairs', () => {
    const items = [
      { id: 1, embedding: [1, 0, 0] },
      { id: 2, embedding: [1, 0, 0] },
      { id: 3, embedding: [1, 0, 0] },
      { id: 4, embedding: [0, 1, 0] },
    ];
    // Threshold 0.99: pairs (1,2), (1,3), (2,3) — not pair with 4
    const pairs = findSimilarPairs(items, 0.99);
    expect(pairs).toHaveLength(3);
  });

  it('uses ids from items, not indices', () => {
    const items = [
      { id: 100, embedding: [1, 0] },
      { id: 200, embedding: [1, 0] },
    ];
    const pairs = findSimilarPairs(items, 0.5);
    expect(pairs[0].a).toBe(100);
    expect(pairs[0].b).toBe(200);
  });

  it('respects threshold boundary', () => {
    // cos([1,1],[1,0]) = 1/sqrt(2) ≈ 0.707
    const items = [
      { id: 1, embedding: [1, 1] },
      { id: 2, embedding: [1, 0] },
    ];
    expect(findSimilarPairs(items, 0.8)).toHaveLength(0);
    expect(findSimilarPairs(items, 0.7)).toHaveLength(1);
  });
});

describe('groupByUnionFind', () => {
  it('returns empty map for no pairs', () => {
    const groups = groupByUnionFind([]);
    expect(groups.size).toBe(0);
  });

  it('groups two connected items', () => {
    const pairs = [{ a: 1, b: 2 }];
    const groups = groupByUnionFind(pairs);
    const allGroups = Array.from(groups.values());
    const flatMembers = allGroups.flat().sort((x, y) => x - y);
    expect(flatMembers).toEqual([1, 2]);
    const groupWith1 = allGroups.find((g) => g.includes(1));
    const groupWith2 = allGroups.find((g) => g.includes(2));
    expect(groupWith1).toBe(groupWith2);
  });

  it('transitively joins three connected items', () => {
    const pairs = [
      { a: 1, b: 2 },
      { a: 2, b: 3 },
    ];
    const groups = groupByUnionFind(pairs);
    const allMembers = Array.from(groups.values())
      .flat()
      .sort((x, y) => x - y);
    expect(allMembers).toEqual([1, 2, 3]);
    const groupWith1 = Array.from(groups.values()).find((g) => g.includes(1));
    const groupWith3 = Array.from(groups.values()).find((g) => g.includes(3));
    expect(groupWith1).toBe(groupWith3);
  });

  it('keeps disconnected items in separate groups when only paired items are tracked', () => {
    const pairs = [{ a: 1, b: 2 }];
    const groups = groupByUnionFind(pairs);
    const allMembers = Array.from(groups.values())
      .flat()
      .sort((x, y) => x - y);
    expect(allMembers).toEqual([1, 2]);
  });

  it('handles separate clusters correctly', () => {
    const pairs = [
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ];
    const groups = groupByUnionFind(pairs);
    const allGroups = Array.from(groups.values());
    expect(allGroups).toHaveLength(2);
    const allMembers = allGroups.flat().sort((x, y) => x - y);
    expect(allMembers).toEqual([1, 2, 3, 4]);
    const groupWith1 = allGroups.find((g) => g.includes(1));
    const groupWith2 = allGroups.find((g) => g.includes(2));
    const groupWith3 = allGroups.find((g) => g.includes(3));
    const groupWith4 = allGroups.find((g) => g.includes(4));
    expect(groupWith1).toBe(groupWith2);
    expect(groupWith3).toBe(groupWith4);
    expect(groupWith1).not.toBe(groupWith3);
  });
});
