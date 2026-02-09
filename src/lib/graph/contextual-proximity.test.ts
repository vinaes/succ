import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

// In-memory stores
let mockMemories: Array<{ id: number; content: string; tags: string[]; source: string | null; type: string; created_at: string; invalidated_by?: number | null }>;
let mockLinks: Array<{ id: number; source_id: number; target_id: number; relation: string; weight: number }>;

vi.mock('../storage/index.js', () => ({
  getAllMemoriesForExport: async () => mockMemories,
  getMemoryLinks: async (memoryId: number) => {
    const outgoing = mockLinks.filter(l => l.source_id === memoryId);
    const incoming = mockLinks.filter(l => l.target_id === memoryId);
    return { outgoing, incoming };
  },
  createMemoryLink: async (sourceId: number, targetId: number, relation: string, weight: number) => {
    const existing = mockLinks.find(l =>
      (l.source_id === sourceId && l.target_id === targetId) ||
      (l.source_id === targetId && l.target_id === sourceId)
    );
    if (existing) return { id: existing.id, created: false };
    const id = mockLinks.length + 1;
    mockLinks.push({ id, source_id: sourceId, target_id: targetId, relation, weight: weight ?? 1.0 });
    return { id, created: true };
  },
}));

import { normalizeSource, calculateProximity } from './contextual-proximity.js';
import { createProximityLinks } from './contextual-proximity.js';

function addMemory(id: number, source: string) {
  mockMemories.push({
    id,
    content: `memory ${id}`,
    tags: [],
    source,
    type: 'observation',
    created_at: new Date().toISOString(),
    invalidated_by: null,
  });
}

describe('Contextual Proximity', () => {
  beforeEach(() => {
    mockMemories = [];
    mockLinks = [];
  });

  describe('normalizeSource', () => {
    it('normalizes file paths to directory', () => {
      expect(normalizeSource('src/lib/db/graph.ts')).toBe('src/lib/db');
    });

    it('keeps directories as-is', () => {
      expect(normalizeSource('src/lib/db')).toBe('src/lib/db');
    });

    it('normalizes backslashes', () => {
      expect(normalizeSource('src\\lib\\db\\graph.ts')).toBe('src/lib/db');
    });

    it('lowercases generic sources', () => {
      expect(normalizeSource('User Request')).toBe('user request');
    });

    it('returns empty for empty input', () => {
      expect(normalizeSource('')).toBe('');
    });
  });

  describe('calculateProximity', () => {
    it('returns empty for no memories', () => {
      const result = calculateProximity([]);
      expect(result).toHaveLength(0);
    });

    it('finds co-occurring pairs', () => {
      const memories = [
        { id: 1, source: 'session-abc' },
        { id: 2, source: 'session-abc' },
        { id: 3, source: 'session-abc' },
        { id: 4, source: 'session-xyz' },
      ];
      const result = calculateProximity(memories);
      expect(result).toHaveLength(3);
      expect(result.find(p => p.node_1 === 1 && p.node_2 === 2)).toBeDefined();
    });

    it('counts multiple source co-occurrences', () => {
      const memories = [
        { id: 1, source: 'src/lib/db/graph.ts' },
        { id: 2, source: 'src/lib/db/memories.ts' },
        { id: 3, source: 'src/lib/config.ts' },
      ];
      const result = calculateProximity(memories);
      const pair12 = result.find(p => p.node_1 === 1 && p.node_2 === 2);
      expect(pair12).toBeDefined();
    });

    it('skips null sources', () => {
      const memories = [
        { id: 1, source: null },
        { id: 2, source: 'abc' },
      ];
      const result = calculateProximity(memories);
      expect(result).toHaveLength(0);
    });
  });

  describe('createProximityLinks', () => {
    it('creates links for co-occurring memories', async () => {
      addMemory(1, 'session-abc');
      addMemory(2, 'session-abc');
      addMemory(3, 'session-abc');
      addMemory(4, 'session-abc');

      const result = await createProximityLinks({ minCooccurrence: 1 });
      expect(result.created).toBeGreaterThan(0);
    });

    it('respects minCooccurrence filter', async () => {
      addMemory(1, 'session-a');
      addMemory(2, 'session-a');
      const result = await createProximityLinks({ minCooccurrence: 2 });
      expect(result.created).toBe(0);
    });

    it('skips existing links', async () => {
      addMemory(1, 'session-abc');
      addMemory(2, 'session-abc');

      mockLinks.push({ id: 1, source_id: 1, target_id: 2, relation: 'similar_to', weight: 1.0 });

      const result = await createProximityLinks({ minCooccurrence: 1 });
      expect(result.skipped).toBeGreaterThanOrEqual(1);
    });

    it('dry run does not create links', async () => {
      addMemory(1, 'session-abc');
      addMemory(2, 'session-abc');

      const result = await createProximityLinks({ minCooccurrence: 1, dryRun: true });
      expect(result.created).toBe(0);
      expect(mockLinks).toHaveLength(0);
    });

    it('filters out invalidated memories', async () => {
      addMemory(1, 'session-abc');
      addMemory(2, 'session-abc');
      mockMemories[1].invalidated_by = 999;

      const result = await createProximityLinks({ minCooccurrence: 1 });
      expect(result.total_pairs).toBe(0);
    });
  });
});
