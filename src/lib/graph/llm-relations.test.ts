import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

// In-memory stores
let mockMemories: Array<{ id: number; content: string; tags: string[]; source: string | null; type: string; created_at: string; invalidated_by?: number | null }>;
let mockLinks: Array<{ id: number; source_id: number; target_id: number; relation: string; weight: number; llm_enriched: number; created_at: string }>;

vi.mock('../storage/index.js', () => ({
  getAllMemoryLinksForExport: async () => mockLinks,
  getMemoryById: async (id: number) => mockMemories.find(m => m.id === id) ?? null,
  updateMemoryLink: async (linkId: number, updates: { relation?: string; weight?: number; llmEnriched?: boolean }) => {
    const link = mockLinks.find(l => l.id === linkId);
    if (link) {
      if (updates.relation !== undefined) link.relation = updates.relation;
      if (updates.weight !== undefined) link.weight = updates.weight;
      if (updates.llmEnriched !== undefined) link.llm_enriched = updates.llmEnriched ? 1 : 0;
    }
  },
  getMemoryLinks: async (memoryId: number) => {
    const outgoing = mockLinks.filter(l => l.source_id === memoryId);
    const incoming = mockLinks.filter(l => l.target_id === memoryId);
    return { outgoing, incoming };
  },
}));

// Mock LLM
const mockCallLLM = vi.fn();
vi.mock('../llm.js', () => ({
  callLLM: (...args: any[]) => mockCallLLM(...args),
}));

import {
  classifyRelation,
  classifyRelationsBatch,
  enrichExistingLinks,
  enrichMemoryLinks,
} from './llm-relations.js';

function addMemory(id: number, content: string, type = 'observation') {
  mockMemories.push({
    id,
    content,
    tags: [],
    source: null,
    type,
    created_at: new Date().toISOString(),
    invalidated_by: null,
  });
}

function addLink(src: number, tgt: number, relation = 'similar_to', enriched = 0) {
  const id = mockLinks.length + 1;
  mockLinks.push({
    id,
    source_id: src,
    target_id: tgt,
    relation,
    weight: 1.0,
    llm_enriched: enriched,
    created_at: new Date().toISOString(),
  });
}

describe('LLM Relations', () => {
  beforeEach(() => {
    mockMemories = [];
    mockLinks = [];
    mockCallLLM.mockReset();
  });

  describe('classifyRelation', () => {
    it('parses valid LLM response', async () => {
      mockCallLLM.mockResolvedValue('{"relation": "caused_by", "confidence": 0.9}');

      const result = await classifyRelation(
        { id: 1, content: 'Bug found in auth', type: 'error', tags: [] },
        { id: 2, content: 'Deployed new auth module', type: 'observation', tags: [] }
      );

      expect(result.relation).toBe('caused_by');
      expect(result.confidence).toBe(0.9);
    });

    it('handles JSON embedded in extra text', async () => {
      mockCallLLM.mockResolvedValue('Here is the result: {"relation": "implements", "confidence": 0.85} hope that helps');

      const result = await classifyRelation(
        { id: 1, content: 'Added JWT auth', type: 'observation', tags: [] },
        { id: 2, content: 'Decision: use JWT for auth', type: 'decision', tags: [] }
      );

      expect(result.relation).toBe('implements');
      expect(result.confidence).toBe(0.85);
    });

    it('falls back to similar_to on LLM error', async () => {
      mockCallLLM.mockRejectedValue(new Error('LLM unavailable'));

      const result = await classifyRelation(
        { id: 1, content: 'Memory A', type: 'observation', tags: [] },
        { id: 2, content: 'Memory B', type: 'observation', tags: [] }
      );

      expect(result.relation).toBe('similar_to');
      expect(result.confidence).toBe(0);
    });

    it('falls back on invalid JSON', async () => {
      mockCallLLM.mockResolvedValue('I cannot parse this');

      const result = await classifyRelation(
        { id: 1, content: 'A', type: 'observation', tags: [] },
        { id: 2, content: 'B', type: 'observation', tags: [] }
      );

      expect(result.relation).toBe('similar_to');
      expect(result.confidence).toBe(0);
    });

    it('validates unknown relation to related', async () => {
      mockCallLLM.mockResolvedValue('{"relation": "depends_on", "confidence": 0.8}');

      const result = await classifyRelation(
        { id: 1, content: 'A', type: 'observation', tags: [] },
        { id: 2, content: 'B', type: 'observation', tags: [] }
      );

      expect(result.relation).toBe('related');
      expect(result.confidence).toBe(0.8);
    });

    it('clamps confidence to 0-1', async () => {
      mockCallLLM.mockResolvedValue('{"relation": "leads_to", "confidence": 5.0}');

      const result = await classifyRelation(
        { id: 1, content: 'A', type: 'observation', tags: [] },
        { id: 2, content: 'B', type: 'observation', tags: [] }
      );

      expect(result.confidence).toBe(1.0);
    });

    it('truncates long content in prompt', async () => {
      const longContent = 'x'.repeat(1000);
      mockCallLLM.mockResolvedValue('{"relation": "related", "confidence": 0.5}');

      await classifyRelation(
        { id: 1, content: longContent, type: 'observation', tags: [] },
        { id: 2, content: 'Short', type: 'observation', tags: [] }
      );

      const promptArg = mockCallLLM.mock.calls[0][0];
      expect(promptArg.length).toBeLessThan(longContent.length + 500);
    });
  });

  describe('classifyRelationsBatch', () => {
    it('returns empty array for empty input', async () => {
      const result = await classifyRelationsBatch([]);
      expect(result).toHaveLength(0);
      expect(mockCallLLM).not.toHaveBeenCalled();
    });

    it('parses batch response', async () => {
      mockCallLLM.mockResolvedValue('[{"pair": 1, "relation": "caused_by", "confidence": 0.9}, {"pair": 2, "relation": "leads_to", "confidence": 0.7}]');

      const result = await classifyRelationsBatch([
        { a: { id: 1, content: 'A', type: 'observation', tags: [] }, b: { id: 2, content: 'B', type: 'observation', tags: [] }, linkId: 10 },
        { a: { id: 3, content: 'C', type: 'decision', tags: [] }, b: { id: 4, content: 'D', type: 'learning', tags: [] }, linkId: 20 },
      ]);

      expect(result).toHaveLength(2);
      expect(result[0].linkId).toBe(10);
      expect(result[0].relation).toBe('caused_by');
      expect(result[1].linkId).toBe(20);
      expect(result[1].relation).toBe('leads_to');
    });

    it('falls back on LLM error', async () => {
      mockCallLLM.mockRejectedValue(new Error('timeout'));

      const result = await classifyRelationsBatch([
        { a: { id: 1, content: 'A', type: 'observation', tags: [] }, b: { id: 2, content: 'B', type: 'observation', tags: [] }, linkId: 10 },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].relation).toBe('similar_to');
      expect(result[0].confidence).toBe(0);
    });

    it('handles malformed batch JSON', async () => {
      mockCallLLM.mockResolvedValue('some garbage text');

      const result = await classifyRelationsBatch([
        { a: { id: 1, content: 'A', type: 'observation', tags: [] }, b: { id: 2, content: 'B', type: 'observation', tags: [] }, linkId: 10 },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].relation).toBe('similar_to');
    });
  });

  describe('enrichExistingLinks', () => {
    it('returns zeros for no links', async () => {
      const result = await enrichExistingLinks();
      expect(result.enriched).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it('skips already enriched links', async () => {
      addMemory(1, 'Memory A');
      addMemory(2, 'Memory B');
      addLink(1, 2, 'similar_to', 1); // already enriched

      const result = await enrichExistingLinks();
      expect(result.enriched).toBe(0);
      expect(mockCallLLM).not.toHaveBeenCalled();
    });

    it('enriches unenriched similar_to links', async () => {
      addMemory(1, 'Bug in auth module');
      addMemory(2, 'Fixed auth module');
      addLink(1, 2, 'similar_to', 0);

      mockCallLLM.mockResolvedValue('{"relation": "caused_by", "confidence": 0.85}');

      const result = await enrichExistingLinks();
      expect(result.enriched).toBe(1);

      const link = mockLinks.find(l => l.id === 1)!;
      expect(link.relation).toBe('caused_by');
      expect(link.llm_enriched).toBe(1);
    });

    it('respects limit option', async () => {
      addMemory(1, 'A');
      addMemory(2, 'B');
      addMemory(3, 'C');
      addLink(1, 2, 'similar_to', 0);
      addLink(2, 3, 'similar_to', 0);

      mockCallLLM.mockResolvedValue('{"relation": "related", "confidence": 0.6}');

      const result = await enrichExistingLinks({ limit: 1 });
      expect(result.enriched).toBe(1);
    });

    it('force re-enriches already processed links', async () => {
      addMemory(1, 'A');
      addMemory(2, 'B');
      addLink(1, 2, 'similar_to', 1); // already enriched

      mockCallLLM.mockResolvedValue('{"relation": "leads_to", "confidence": 0.9}');

      const result = await enrichExistingLinks({ force: true });
      expect(result.enriched).toBe(1);

      const link = mockLinks.find(l => l.id === 1)!;
      expect(link.relation).toBe('leads_to');
    });

    it('marks as enriched even on zero-confidence', async () => {
      addMemory(1, 'A');
      addMemory(2, 'B');
      addLink(1, 2, 'similar_to', 0);

      mockCallLLM.mockResolvedValue('totally invalid response');

      const result = await enrichExistingLinks();
      expect(result.failed).toBe(1);
      expect(result.enriched).toBe(0);

      const link = mockLinks.find(l => l.id === 1)!;
      expect(link.relation).toBe('similar_to');
      expect(link.llm_enriched).toBe(1);
    });

    it('only enriches similar_to links', async () => {
      addMemory(1, 'A');
      addMemory(2, 'B');
      addLink(1, 2, 'caused_by', 0); // not similar_to

      const result = await enrichExistingLinks();
      expect(result.enriched).toBe(0);
      expect(mockCallLLM).not.toHaveBeenCalled();
    });
  });

  describe('enrichMemoryLinks', () => {
    it('returns 0 for memory with no similar_to links', async () => {
      addMemory(1, 'A');
      const result = await enrichMemoryLinks(1);
      expect(result).toBe(0);
    });

    it('enriches links for specific memory', async () => {
      addMemory(1, 'Auth bug report');
      addMemory(2, 'Auth fix deployed');
      addLink(1, 2, 'similar_to', 0);

      mockCallLLM.mockResolvedValue('{"relation": "leads_to", "confidence": 0.8}');

      const result = await enrichMemoryLinks(1);
      expect(result).toBe(1);
    });
  });
});
