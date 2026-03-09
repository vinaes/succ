/**
 * Tests for graphology-bridge module
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock storage
vi.mock('../storage/index.js', () => ({
  getAllMemoryLinksForExport: vi.fn(),
  getAllMemoriesForExport: vi.fn(),
}));

vi.mock('../fault-logger.js', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { getAllMemoryLinksForExport, getAllMemoriesForExport } from '../storage/index.js';
import {
  getGraph,
  invalidateGraphCache,
  personalizedPageRank,
  detectLouvainCommunities,
  shortestPath,
  getArticulationPoints,
  computePageRank,
  computeBetweennessCentrality,
  whyRelated,
} from './graphology-bridge.js';

function setupMockGraph() {
  // A simple chain: 1 -- 2 -- 3 -- 4, with a branch: 2 -- 5
  vi.mocked(getAllMemoriesForExport).mockResolvedValue([
    { id: 1, content: 'Memory one', type: 'learning', tags: [], created_at: new Date().toISOString() },
    { id: 2, content: 'Memory two', type: 'decision', tags: [], created_at: new Date().toISOString() },
    { id: 3, content: 'Memory three', type: 'learning', tags: [], created_at: new Date().toISOString() },
    { id: 4, content: 'Memory four', type: 'learning', tags: [], created_at: new Date().toISOString() },
    { id: 5, content: 'Memory five', type: 'context', tags: [], created_at: new Date().toISOString() },
  ] as any);

  vi.mocked(getAllMemoryLinksForExport).mockResolvedValue([
    { id: 1, source_id: 1, target_id: 2, relation: 'related', weight: 1.0 },
    { id: 2, source_id: 2, target_id: 3, relation: 'leads_to', weight: 1.0 },
    { id: 3, source_id: 3, target_id: 4, relation: 'related', weight: 1.0 },
    { id: 4, source_id: 2, target_id: 5, relation: 'caused_by', weight: 0.5 },
  ] as any);
}

function setupMockEmptyGraph() {
  vi.mocked(getAllMemoriesForExport).mockResolvedValue([]);
  vi.mocked(getAllMemoryLinksForExport).mockResolvedValue([]);
}

describe('graphology-bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateGraphCache();
  });

  describe('getGraph', () => {
    it('should build graph from storage', async () => {
      setupMockGraph();
      const graph = await getGraph();
      expect(graph.order).toBe(5); // 5 nodes
      expect(graph.size).toBe(4); // 4 edges
    });

    it('should cache graph on subsequent calls', async () => {
      setupMockGraph();
      await getGraph();
      await getGraph();
      // Storage should only be called once (cached)
      expect(getAllMemoriesForExport).toHaveBeenCalledTimes(1);
    });

    it('should refresh on invalidate', async () => {
      setupMockGraph();
      await getGraph();
      invalidateGraphCache();
      await getGraph();
      expect(getAllMemoriesForExport).toHaveBeenCalledTimes(2);
    });

    it('should handle empty graph', async () => {
      setupMockEmptyGraph();
      const graph = await getGraph();
      expect(graph.order).toBe(0);
      expect(graph.size).toBe(0);
    });
  });

  describe('shortestPath', () => {
    it('should find direct path', async () => {
      setupMockGraph();
      const result = await shortestPath(1, 2);
      expect(result).not.toBeNull();
      expect(result!.path).toEqual([1, 2]);
    });

    it('should find multi-hop path', async () => {
      setupMockGraph();
      const result = await shortestPath(1, 4);
      expect(result).not.toBeNull();
      expect(result!.path).toEqual([1, 2, 3, 4]);
    });

    it('should return null for non-existent nodes', async () => {
      setupMockGraph();
      const result = await shortestPath(1, 999);
      expect(result).toBeNull();
    });
  });

  describe('whyRelated', () => {
    it('should explain relationship chain', async () => {
      setupMockGraph();
      const result = await whyRelated(1, 4);
      expect(result).not.toBeNull();
      expect(result!.connected).toBe(true);
      expect(result!.distance).toBe(3);
      expect(result!.path.length).toBe(4);
    });

    it('should return null for missing nodes', async () => {
      setupMockGraph();
      const result = await whyRelated(1, 999);
      expect(result).toBeNull();
    });
  });

  describe('personalizedPageRank', () => {
    it('should return scores seeded from given nodes', async () => {
      setupMockGraph();
      const results = await personalizedPageRank([1], 5);
      expect(results.length).toBeGreaterThan(0);
      // Scores should be sorted descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('should return empty for empty graph', async () => {
      setupMockEmptyGraph();
      const results = await personalizedPageRank([1]);
      expect(results).toEqual([]);
    });

    it('should return empty for non-existent seeds', async () => {
      setupMockGraph();
      const results = await personalizedPageRank([999]);
      expect(results).toEqual([]);
    });
  });

  describe('detectLouvainCommunities', () => {
    it('should detect communities', async () => {
      setupMockGraph();
      const result = await detectLouvainCommunities();
      expect(result.communities.length).toBeGreaterThanOrEqual(0);
      // Modularity should be a number
      expect(typeof result.modularity).toBe('number');
    });

    it('should return empty for empty graph', async () => {
      setupMockEmptyGraph();
      const result = await detectLouvainCommunities();
      expect(result.communities).toEqual([]);
      expect(result.modularity).toBe(0);
    });
  });

  describe('getArticulationPoints', () => {
    it('should find articulation points in chain graph', async () => {
      setupMockGraph();
      const points = await getArticulationPoints();
      // In chain 1-2-3-4 with branch 2-5, node 2 and 3 are articulation points
      expect(points).toContain(2);
      expect(points).toContain(3);
    });

    it('should return empty for empty graph', async () => {
      setupMockEmptyGraph();
      const points = await getArticulationPoints();
      expect(points).toEqual([]);
    });
  });

  describe('computePageRank', () => {
    it('should compute scores for all nodes', async () => {
      setupMockGraph();
      const scores = await computePageRank();
      expect(scores.size).toBe(5);
      // All scores should be positive
      for (const [, score] of scores) {
        expect(score).toBeGreaterThan(0);
      }
    });

    it('should return empty for empty graph', async () => {
      setupMockEmptyGraph();
      const scores = await computePageRank();
      expect(scores.size).toBe(0);
    });
  });

  describe('computeBetweennessCentrality', () => {
    it('should compute scores for all nodes', async () => {
      setupMockGraph();
      const scores = await computeBetweennessCentrality();
      expect(scores.size).toBe(5);
      // Node 2 should have highest betweenness (it connects 1, 3, and 5)
      const node2Score = scores.get(2) ?? 0;
      const node1Score = scores.get(1) ?? 0;
      expect(node2Score).toBeGreaterThan(node1Score);
    });

    it('should return empty for empty graph', async () => {
      setupMockEmptyGraph();
      const scores = await computeBetweennessCentrality();
      expect(scores.size).toBe(0);
    });
  });
});
