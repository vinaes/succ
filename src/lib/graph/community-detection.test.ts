import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

// In-memory stores
let mockLinks: Array<{
  id: number;
  source_id: number;
  target_id: number;
  relation: string;
  weight: number;
  created_at: string;
}>;
let mockMemories: Array<{
  id: number;
  content: string;
  tags: string[];
  source: string | null;
  type: string;
  created_at: string;
}>;

vi.mock('../storage/index.js', () => ({
  getAllMemoryLinksForExport: async () => mockLinks,
  getAllMemoriesForExport: async () => mockMemories,
  updateMemoryTags: async (memoryId: number, tags: string[]) => {
    const mem = mockMemories.find((m) => m.id === memoryId);
    if (mem) mem.tags = tags;
  },
  getMemoryById: async (id: number) => mockMemories.find((m) => m.id === id) ?? null,
}));

import {
  buildAdjacencyList,
  labelPropagation,
  renumberCommunities,
  detectCommunities,
  getMemoryCommunity,
} from './community-detection.js';

function addMemory(id: number, tags: string[] = []) {
  mockMemories.push({
    id,
    content: `memory ${id}`,
    tags: [...tags],
    source: null,
    type: 'observation',
    created_at: new Date().toISOString(),
  });
}

function addLink(src: number, tgt: number, weight = 1.0) {
  mockLinks.push({
    id: mockLinks.length + 1,
    source_id: src,
    target_id: tgt,
    relation: 'related',
    weight,
    created_at: new Date().toISOString(),
  });
}

describe('Community Detection', () => {
  beforeEach(() => {
    mockLinks = [];
    mockMemories = [];
  });

  describe('buildAdjacencyList', () => {
    it('returns empty map for no links', () => {
      const adj = buildAdjacencyList([]);
      expect(adj.size).toBe(0);
    });

    it('builds bidirectional adjacency', () => {
      const links = [
        { source_id: 1, target_id: 2, weight: 1.0 },
        { source_id: 2, target_id: 3, weight: 0.5 },
      ];
      const adj = buildAdjacencyList(links);

      expect(adj.get(1)?.length).toBe(1);
      expect(adj.get(2)?.length).toBe(2);
      expect(adj.get(3)?.length).toBe(1);
    });
  });

  describe('labelPropagation', () => {
    it('returns each node as its own community for isolated nodes', () => {
      const adj = new Map<number, Array<{ neighbor: number; weight: number }>>();
      adj.set(1, []);
      adj.set(2, []);
      const labels = labelPropagation(adj);
      expect(labels.get(1)).not.toBe(labels.get(2));
    });

    it('groups connected nodes into same community', () => {
      const adj = new Map<number, Array<{ neighbor: number; weight: number }>>();
      adj.set(1, [
        { neighbor: 2, weight: 1 },
        { neighbor: 3, weight: 1 },
      ]);
      adj.set(2, [
        { neighbor: 1, weight: 1 },
        { neighbor: 3, weight: 1 },
      ]);
      adj.set(3, [
        { neighbor: 1, weight: 1 },
        { neighbor: 2, weight: 1 },
      ]);

      const labels = labelPropagation(adj);
      expect(labels.get(1)).toBe(labels.get(2));
      expect(labels.get(2)).toBe(labels.get(3));
    });

    it('detects two separate communities', () => {
      const adj = new Map<number, Array<{ neighbor: number; weight: number }>>();
      adj.set(1, [
        { neighbor: 2, weight: 1 },
        { neighbor: 3, weight: 1 },
      ]);
      adj.set(2, [
        { neighbor: 1, weight: 1 },
        { neighbor: 3, weight: 1 },
      ]);
      adj.set(3, [
        { neighbor: 1, weight: 1 },
        { neighbor: 2, weight: 1 },
      ]);
      adj.set(4, [
        { neighbor: 5, weight: 1 },
        { neighbor: 6, weight: 1 },
      ]);
      adj.set(5, [
        { neighbor: 4, weight: 1 },
        { neighbor: 6, weight: 1 },
      ]);
      adj.set(6, [
        { neighbor: 4, weight: 1 },
        { neighbor: 5, weight: 1 },
      ]);

      const labels = labelPropagation(adj);

      expect(labels.get(1)).toBe(labels.get(2));
      expect(labels.get(2)).toBe(labels.get(3));
      expect(labels.get(4)).toBe(labels.get(5));
      expect(labels.get(5)).toBe(labels.get(6));
      expect(labels.get(1)).not.toBe(labels.get(4));
    });
  });

  describe('renumberCommunities', () => {
    it('renumbers from 0', () => {
      const labels = new Map([
        [10, 42],
        [20, 42],
        [30, 99],
      ]);
      const renumbered = renumberCommunities(labels);
      expect(renumbered.get(10)).toBe(0);
      expect(renumbered.get(20)).toBe(0);
      expect(renumbered.get(30)).toBe(1);
    });
  });

  describe('detectCommunities', () => {
    it('returns empty for no links', async () => {
      addMemory(1);
      addMemory(2);
      const result = await detectCommunities();
      expect(result.communities).toHaveLength(0);
    });

    it('detects communities and updates tags', async () => {
      addMemory(1);
      addMemory(2);
      addMemory(3);
      addLink(1, 2);
      addLink(2, 3);
      addLink(1, 3);

      const result = await detectCommunities({ minCommunitySize: 2 });
      expect(result.communities.length).toBeGreaterThanOrEqual(1);

      const mem1 = mockMemories.find((m) => m.id === 1)!;
      expect(mem1.tags.some((t) => t.startsWith('community:'))).toBe(true);
    });

    it('preserves existing tags', async () => {
      addMemory(1, ['important', 'decision']);
      addMemory(2, ['learning']);
      addLink(1, 2);

      await detectCommunities({ minCommunitySize: 2 });

      const mem1 = mockMemories.find((m) => m.id === 1)!;
      expect(mem1.tags).toContain('important');
      expect(mem1.tags).toContain('decision');
      expect(mem1.tags.some((t) => t.startsWith('community:'))).toBe(true);
    });

    it('removes old community tags on re-run', async () => {
      addMemory(1, ['community:99']);
      addMemory(2);
      addLink(1, 2);

      await detectCommunities({ minCommunitySize: 2 });

      const mem1 = mockMemories.find((m) => m.id === 1)!;
      expect(mem1.tags).not.toContain('community:99');
    });
  });

  describe('getMemoryCommunity', () => {
    it('returns null for memory without community tag', async () => {
      addMemory(1, ['learning']);
      expect(await getMemoryCommunity(1)).toBeNull();
    });

    it('returns community id from tag', async () => {
      addMemory(1, ['community:5']);
      expect(await getMemoryCommunity(1)).toBe(5);
    });

    it('returns null for non-existent memory', async () => {
      expect(await getMemoryCommunity(999)).toBeNull();
    });
  });
});
