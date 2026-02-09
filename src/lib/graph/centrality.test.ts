import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

// In-memory stores for mocking storage
let mockLinks: Array<{ id: number; source_id: number; target_id: number; relation: string; weight: number; created_at: string }>;
let mockCentrality: Map<number, { degree: number; normalized_degree: number }>;

vi.mock('../storage/index.js', () => ({
  getAllMemoryLinksForExport: async () => mockLinks,
  upsertCentralityScore: async (memoryId: number, degree: number, normalizedDegree: number) => {
    mockCentrality.set(memoryId, { degree, normalized_degree: normalizedDegree });
  },
  getCentralityScores: async (memoryIds: number[]) => {
    const map = new Map<number, number>();
    for (const id of memoryIds) {
      const entry = mockCentrality.get(id);
      if (entry) map.set(id, entry.normalized_degree);
    }
    return map;
  },
}));

import {
  calculateDegreeCentrality,
  normalizeCentrality,
  updateCentralityCache,
  applyCentralityBoost,
} from './centrality.js';

describe('Centrality', () => {
  beforeEach(() => {
    mockLinks = [];
    mockCentrality = new Map();
  });

  describe('calculateDegreeCentrality', () => {
    it('returns empty map for empty links', () => {
      const result = calculateDegreeCentrality([]);
      expect(result.size).toBe(0);
    });

    it('calculates degree correctly for simple graph', () => {
      const links = [
        { source_id: 1, target_id: 2 },
        { source_id: 1, target_id: 3 },
        { source_id: 2, target_id: 3 },
      ];
      const result = calculateDegreeCentrality(links);
      expect(result.get(1)).toBe(2);
      expect(result.get(2)).toBe(2);
      expect(result.get(3)).toBe(2);
    });

    it('handles hub node correctly', () => {
      const links = [
        { source_id: 1, target_id: 2 },
        { source_id: 1, target_id: 3 },
        { source_id: 1, target_id: 4 },
      ];
      const result = calculateDegreeCentrality(links);
      expect(result.get(1)).toBe(3);
      expect(result.get(2)).toBe(1);
    });

    it('counts both directions', () => {
      const links = [
        { source_id: 1, target_id: 2 },
        { source_id: 3, target_id: 1 },
      ];
      const result = calculateDegreeCentrality(links);
      // Node 1: outgoing=1, incoming=1 → degree=2
      expect(result.get(1)).toBe(2);
    });
  });

  describe('normalizeCentrality', () => {
    it('returns empty map for empty input', () => {
      const result = normalizeCentrality(new Map());
      expect(result.size).toBe(0);
    });

    it('normalizes to 0-1 range', () => {
      const raw = new Map([[1, 6], [2, 3], [3, 1]]);
      const result = normalizeCentrality(raw);
      expect(result.get(1)).toBe(1.0);
      expect(result.get(2)).toBe(0.5);
      expect(result.get(3)).toBeCloseTo(0.1667, 3);
    });

    it('handles all zero degrees', () => {
      const raw = new Map([[1, 0], [2, 0]]);
      const result = normalizeCentrality(raw);
      expect(result.size).toBe(0);
    });
  });

  describe('updateCentralityCache', () => {
    it('caches centrality via storage', async () => {
      mockLinks = [
        { id: 1, source_id: 1, target_id: 2, relation: 'related', weight: 1.0, created_at: '' },
      ];

      const result = await updateCentralityCache();
      expect(result.updated).toBe(2);
      expect(mockCentrality.has(1)).toBe(true);
      expect(mockCentrality.has(2)).toBe(true);
    });

    it('handles empty graph', async () => {
      const result = await updateCentralityCache();
      expect(result.updated).toBe(0);
    });

    it('stores correct normalized values', async () => {
      mockLinks = [
        { id: 1, source_id: 1, target_id: 2, relation: 'related', weight: 1.0, created_at: '' },
        { id: 2, source_id: 1, target_id: 3, relation: 'related', weight: 1.0, created_at: '' },
      ];

      await updateCentralityCache();
      // Node 1: degree=2 (out:2), Node 2: degree=1 (in:1), Node 3: degree=1 (in:1)
      expect(mockCentrality.get(1)?.normalized_degree).toBe(1.0);
      expect(mockCentrality.get(2)?.normalized_degree).toBe(0.5);
    });
  });

  describe('applyCentralityBoost', () => {
    it('returns unchanged results when disabled', async () => {
      const results = [{ id: 1, similarity: 0.5 }];
      const boosted = await applyCentralityBoost(results, { enabled: false });
      expect(boosted[0].similarity).toBe(0.5);
    });

    it('boosts results based on centrality', async () => {
      mockCentrality.set(1, { degree: 2, normalized_degree: 1.0 });
      mockCentrality.set(2, { degree: 1, normalized_degree: 0.5 });

      const results = [
        { id: 2, similarity: 0.5 },
        { id: 1, similarity: 0.4 },
      ];
      const boosted = await applyCentralityBoost(results, { enabled: true, boost_weight: 0.1 });
      expect(boosted[0].similarity).toBeCloseTo(0.55, 2);
      expect(boosted[1].similarity).toBeCloseTo(0.5, 2);
    });

    it('caps similarity at 1.0', async () => {
      mockCentrality.set(1, { degree: 1, normalized_degree: 1.0 });

      const results = [{ id: 1, similarity: 0.99 }];
      const boosted = await applyCentralityBoost(results, { enabled: true, boost_weight: 0.5 });
      expect(boosted[0].similarity).toBe(1.0);
    });

    it('handles missing centrality data', async () => {
      const results = [{ id: 999, similarity: 0.5 }];
      const boosted = await applyCentralityBoost(results, { enabled: true, boost_weight: 0.1 });
      expect(boosted[0].similarity).toBe(0.5);
    });

    it('returns empty array for empty results', async () => {
      const boosted = await applyCentralityBoost([], { enabled: true });
      expect(boosted).toHaveLength(0);
    });

    it('sorts by boosted similarity', async () => {
      mockCentrality.set(1, { degree: 3, normalized_degree: 1.0 });
      mockCentrality.set(2, { degree: 1, normalized_degree: 0.1 });

      const results = [
        { id: 2, similarity: 0.6 },
        { id: 1, similarity: 0.5 },
      ];
      const boosted = await applyCentralityBoost(results, { enabled: true, boost_weight: 0.2 });
      // Node 1: 0.5 + 0.2*1.0 = 0.7
      // Node 2: 0.6 + 0.2*0.1 = 0.62
      expect(boosted[0].id).toBe(1);
      expect(boosted[0].similarity).toBeCloseTo(0.7, 2);
    });
  });
});
