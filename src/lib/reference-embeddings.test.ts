import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerReferenceSet,
  getReferenceEmbeddings,
  maxSimilarityToReference,
  avgSimilarityToReference,
  clearReferenceCache,
  resetReferenceSets,
} from './reference-embeddings.js';

// Mock embeddings module
vi.mock('./embeddings.js', () => ({
  getEmbeddings: vi.fn(async (texts: string[]) => {
    // Return simple deterministic embeddings based on text length
    return texts.map((t) => {
      const len = t.length;
      return [len / 100, (len % 50) / 50, Math.sin(len)];
    });
  }),
  cosineSimilarity: vi.fn((a: number[], b: number[]) => {
    // Simplified cosine similarity
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }),
}));

describe('reference-embeddings', () => {
  beforeEach(() => {
    resetReferenceSets();
    vi.clearAllMocks();
  });

  it('registers and retrieves reference set', async () => {
    registerReferenceSet('test', ['hello', 'world']);
    const embeddings = await getReferenceEmbeddings('test');
    expect(embeddings).toHaveLength(2);
    expect(embeddings[0]).toHaveLength(3); // 3-dim mock vectors
  });

  it('throws for unregistered set', async () => {
    await expect(getReferenceEmbeddings('nonexistent')).rejects.toThrow('not registered');
  });

  it('caches embeddings (lazy compute once)', async () => {
    const { getEmbeddings } = await import('./embeddings.js');
    registerReferenceSet('cached', ['a', 'b', 'c']);

    await getReferenceEmbeddings('cached');
    await getReferenceEmbeddings('cached'); // second call should use cache

    expect(getEmbeddings).toHaveBeenCalledTimes(1);
  });

  it('clearReferenceCache forces recompute', async () => {
    const { getEmbeddings } = await import('./embeddings.js');
    registerReferenceSet('recompute', ['x', 'y']);

    await getReferenceEmbeddings('recompute');
    clearReferenceCache();
    await getReferenceEmbeddings('recompute');

    expect(getEmbeddings).toHaveBeenCalledTimes(2);
  });

  it('maxSimilarityToReference returns max cosine similarity', async () => {
    registerReferenceSet('max-test', ['short', 'a much longer phrase for testing']);
    const embedding = [0.5, 0.3, 0.1];
    const result = await maxSimilarityToReference(embedding, 'max-test');
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('avgSimilarityToReference returns average cosine similarity', async () => {
    registerReferenceSet('avg-test', ['hello', 'world']);
    const embedding = [0.5, 0.3, 0.1];
    const result = await avgSimilarityToReference(embedding, 'avg-test');
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('maxSimilarityToReference returns 0 for unregistered set', async () => {
    const result = await maxSimilarityToReference([0.1], 'nope');
    expect(result).toBe(0);
  });

  it('resetReferenceSets clears everything', async () => {
    registerReferenceSet('temp', ['a']);
    resetReferenceSets();
    await expect(getReferenceEmbeddings('temp')).rejects.toThrow('not registered');
  });
});
