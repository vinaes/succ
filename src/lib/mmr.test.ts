import { describe, it, expect } from 'vitest';
import { applyMMR, type MMRItem } from './mmr.js';

// Helper: create a simple embedding vector
function makeEmbedding(values: number[]): number[] {
  // Pad to length 4 for simplicity
  const emb = new Array(4).fill(0);
  for (let i = 0; i < values.length && i < 4; i++) {
    emb[i] = values[i];
  }
  return emb;
}

describe('applyMMR', () => {
  it('returns empty array for empty input', () => {
    const result = applyMMR([], [1, 0, 0, 0]);
    expect(result).toEqual([]);
  });

  it('returns single item unchanged', () => {
    const items: MMRItem[] = [{ id: 1, similarity: 0.9, embedding: makeEmbedding([1, 0, 0, 0]) }];
    const result = applyMMR(items, [1, 0, 0, 0]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  it('with lambda=1.0, preserves original relevance order', () => {
    const items: MMRItem[] = [
      { id: 1, similarity: 0.9, embedding: makeEmbedding([1, 0, 0, 0]) },
      { id: 2, similarity: 0.8, embedding: makeEmbedding([0.9, 0.1, 0, 0]) },
      { id: 3, similarity: 0.7, embedding: makeEmbedding([0, 1, 0, 0]) },
    ];
    const result = applyMMR(items, [1, 0, 0, 0], 1.0);
    expect(result.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('with low lambda, promotes diverse items over similar ones', () => {
    // Items 1 and 2 are near-identical embeddings, item 3 is orthogonal
    const items: MMRItem[] = [
      { id: 1, similarity: 0.95, embedding: makeEmbedding([1, 0, 0, 0]) },
      { id: 2, similarity: 0.9, embedding: makeEmbedding([0.99, 0.01, 0, 0]) },
      { id: 3, similarity: 0.85, embedding: makeEmbedding([0, 1, 0, 0]) },
    ];
    // With lambda=0.5, diversity should push item 3 ahead of item 2
    const result = applyMMR(items, [1, 0, 0, 0], 0.5);
    expect(result[0].id).toBe(1); // Highest relevance, always first
    expect(result[1].id).toBe(3); // Diverse, promoted over near-duplicate
    expect(result[2].id).toBe(2); // Near-duplicate of item 1, penalized
  });

  it('respects limit parameter', () => {
    const items: MMRItem[] = [
      { id: 1, similarity: 0.9, embedding: makeEmbedding([1, 0, 0, 0]) },
      { id: 2, similarity: 0.8, embedding: makeEmbedding([0, 1, 0, 0]) },
      { id: 3, similarity: 0.7, embedding: makeEmbedding([0, 0, 1, 0]) },
    ];
    const result = applyMMR(items, [1, 0, 0, 0], 0.8, 2);
    expect(result).toHaveLength(2);
  });

  it('handles items without embeddings — appends them at end', () => {
    const items: MMRItem[] = [
      { id: 1, similarity: 0.9, embedding: makeEmbedding([1, 0, 0, 0]) },
      { id: 2, similarity: 0.95, embedding: null },
      { id: 3, similarity: 0.8, embedding: makeEmbedding([0, 1, 0, 0]) },
    ];
    const result = applyMMR(items, [1, 0, 0, 0], 0.8);
    // Items with embeddings are MMR-ranked first, item without embedding is appended
    const ids = result.map((r) => r.id);
    expect(ids[ids.length - 1]).toBe(2);
  });

  it('preserves extra properties on items', () => {
    const items = [
      {
        id: 1,
        similarity: 0.9,
        embedding: makeEmbedding([1, 0, 0, 0]),
        content: 'hello',
        tags: 'test',
      },
      {
        id: 2,
        similarity: 0.8,
        embedding: makeEmbedding([0, 1, 0, 0]),
        content: 'world',
        tags: 'other',
      },
    ];
    const result = applyMMR(items, [1, 0, 0, 0], 0.8);
    expect(result[0]).toHaveProperty('content');
    expect(result[0]).toHaveProperty('tags');
  });

  it('with default lambda=0.8, is conservative — mild diversity', () => {
    // Two very similar items and one diverse
    const items: MMRItem[] = [
      { id: 1, similarity: 0.95, embedding: makeEmbedding([1, 0, 0, 0]) },
      { id: 2, similarity: 0.93, embedding: makeEmbedding([0.98, 0.02, 0, 0]) },
      { id: 3, similarity: 0.8, embedding: makeEmbedding([0, 0, 1, 0]) },
    ];
    // Default lambda=0.8: relevance still dominates, so order may stay
    // but the scores should differ
    const result = applyMMR(items, [1, 0, 0, 0]);
    expect(result).toHaveLength(3);
    // First item should still be id=1 (highest relevance)
    expect(result[0].id).toBe(1);
  });
});
