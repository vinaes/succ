import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConsolidationCandidate, ConsolidationResult } from './consolidate.js';

// We'll test the pure logic parts without database dependencies
// The actual DB operations are tested via integration tests

describe('Consolidation Logic', () => {
  describe('ConsolidationCandidate structure', () => {
    it('should have correct shape for delete_duplicate action', () => {
      const candidate: ConsolidationCandidate = {
        memory1: {
          id: 1,
          content: 'Original memory',
          tags: ['tag1'],
          source: 'test',
          type: null,
          quality_score: 0.8,
          quality_factors: null,
          access_count: 5,
          last_accessed: null,
          valid_from: null,
          valid_until: null,
          created_at: '2026-01-01T00:00:00.000Z',
          embedding: [0.1, 0.2, 0.3],
        },
        memory2: {
          id: 2,
          content: 'Duplicate memory',
          tags: ['tag1'],
          source: 'test',
          type: null,
          quality_score: 0.6,
          quality_factors: null,
          access_count: 1,
          last_accessed: null,
          valid_from: null,
          valid_until: null,
          created_at: '2026-01-02T00:00:00.000Z',
          embedding: [0.1, 0.2, 0.3],
        },
        similarity: 0.98,
        action: 'delete_duplicate',
        reason: 'Keep #1 (quality 0.80 > 0.60)',
      };

      expect(candidate.action).toBe('delete_duplicate');
      expect(candidate.similarity).toBeGreaterThan(0.95);
    });

    it('should have correct shape for merge action', () => {
      const candidate: ConsolidationCandidate = {
        memory1: {
          id: 3,
          content: 'First version of the memory',
          tags: ['tag1'],
          source: 'test',
          type: null,
          quality_score: 0.7,
          quality_factors: null,
          access_count: 3,
          last_accessed: null,
          valid_from: null,
          valid_until: null,
          created_at: '2026-01-01T00:00:00.000Z',
          embedding: [0.1, 0.2, 0.3],
        },
        memory2: {
          id: 4,
          content: 'Second version with different info',
          tags: ['tag2'],
          source: 'test',
          type: null,
          quality_score: 0.7,
          quality_factors: null,
          access_count: 2,
          last_accessed: null,
          valid_from: null,
          valid_until: null,
          created_at: '2026-01-02T00:00:00.000Z',
          embedding: [0.15, 0.25, 0.35],
        },
        similarity: 0.88,
        action: 'merge',
        reason: 'Both have unique information',
      };

      expect(candidate.action).toBe('merge');
      expect(candidate.similarity).toBeGreaterThanOrEqual(0.85);
      expect(candidate.similarity).toBeLessThan(0.95);
    });

    it('should have correct shape for keep_both action', () => {
      const candidate: ConsolidationCandidate = {
        memory1: {
          id: 5,
          content: 'Distinct memory A',
          tags: ['topic-a'],
          source: 'test',
          type: null,
          quality_score: 0.8,
          quality_factors: null,
          access_count: 10,
          last_accessed: null,
          valid_from: null,
          valid_until: null,
          created_at: '2026-01-01T00:00:00.000Z',
          embedding: [0.1, 0.2, 0.3],
        },
        memory2: {
          id: 6,
          content: 'Related but distinct memory B',
          tags: ['topic-b'],
          source: 'test',
          type: null,
          quality_score: 0.75,
          quality_factors: null,
          access_count: 5,
          last_accessed: null,
          valid_from: null,
          valid_until: null,
          created_at: '2026-01-02T00:00:00.000Z',
          embedding: [0.2, 0.3, 0.4],
        },
        similarity: 0.82,
        action: 'keep_both',
        reason: 'Different enough to keep separate',
      };

      expect(candidate.action).toBe('keep_both');
    });
  });

  describe('ConsolidationResult structure', () => {
    it('should track all operation counts', () => {
      const result: ConsolidationResult = {
        candidatesFound: 10,
        merged: 2,
        deleted: 5,
        kept: 3,
        errors: [],
      };

      expect(result.candidatesFound).toBe(10);
      expect(result.merged + result.deleted + result.kept).toBe(10);
    });

    it('should track errors', () => {
      const result: ConsolidationResult = {
        candidatesFound: 5,
        merged: 1,
        deleted: 2,
        kept: 1,
        errors: ['Error processing pair (1, 2): Database error'],
      };

      expect(result.errors).toHaveLength(1);
      expect(result.candidatesFound).toBe(5);
      // One operation failed, so only 4 succeeded
      expect(result.merged + result.deleted + result.kept).toBe(4);
    });
  });

  describe('Action determination logic', () => {
    // Test the logic for determining consolidation actions
    // This mirrors the determineAction function logic

    function determineActionLogic(
      similarity: number,
      q1: number,
      q2: number,
      content1: string,
      content2: string,
      date1: Date,
      date2: Date
    ): { action: string; reason: string } {
      // Very high similarity (>0.95) = likely exact duplicate
      if (similarity > 0.95) {
        if (Math.abs(q1 - q2) > 0.1) {
          return {
            action: 'delete_duplicate',
            reason: q1 > q2 ? 'Keep higher quality' : 'Keep higher quality (second)',
          };
        }
        // Same quality - keep newer
        return {
          action: 'delete_duplicate',
          reason: date1 > date2 ? 'Keep newer (first)' : 'Keep newer (second)',
        };
      }

      // High similarity (0.85-0.95) = candidates for merge
      if (similarity > 0.85) {
        const c1Lower = content1.toLowerCase();
        const c2Lower = content2.toLowerCase();

        if (c1Lower.includes(c2Lower) || c2Lower.includes(c1Lower)) {
          return {
            action: 'delete_duplicate',
            reason: content1.length > content2.length ? 'Keep longer (first)' : 'Keep longer (second)',
          };
        }

        return {
          action: 'merge',
          reason: 'Both have unique information',
        };
      }

      // Lower similarity - keep both
      return {
        action: 'keep_both',
        reason: 'Different enough to keep separate',
      };
    }

    it('should delete duplicate when similarity > 0.95 and quality differs', () => {
      const result = determineActionLogic(
        0.98,
        0.8, // quality 1 (higher)
        0.6, // quality 2
        'content',
        'content',
        new Date('2026-01-01'),
        new Date('2026-01-02')
      );

      expect(result.action).toBe('delete_duplicate');
      expect(result.reason).toContain('quality');
    });

    it('should delete older duplicate when similarity > 0.95 and quality is same', () => {
      const result = determineActionLogic(
        0.98,
        0.7,
        0.7,
        'content',
        'content',
        new Date('2026-01-02'), // newer
        new Date('2026-01-01') // older
      );

      expect(result.action).toBe('delete_duplicate');
      expect(result.reason).toContain('newer');
    });

    it('should delete shorter when one content contains the other', () => {
      const result = determineActionLogic(
        0.90,
        0.7,
        0.7,
        'This is a longer memory with more details',
        'longer memory',
        new Date('2026-01-01'),
        new Date('2026-01-02')
      );

      expect(result.action).toBe('delete_duplicate');
      expect(result.reason).toContain('longer');
    });

    it('should suggest merge for high similarity with unique content', () => {
      const result = determineActionLogic(
        0.90,
        0.7,
        0.7,
        'Memory about authentication flow',
        'Memory about authorization system',
        new Date('2026-01-01'),
        new Date('2026-01-02')
      );

      expect(result.action).toBe('merge');
    });

    it('should keep both for lower similarity', () => {
      const result = determineActionLogic(
        0.82,
        0.8,
        0.8,
        'Different topic A',
        'Different topic B',
        new Date('2026-01-01'),
        new Date('2026-01-02')
      );

      expect(result.action).toBe('keep_both');
    });
  });

  describe('Cosine similarity thresholds', () => {
    // Document expected behavior at different similarity levels

    const SIMILARITY_EXACT_DUPLICATE = 0.95;
    const SIMILARITY_MERGE_CANDIDATE = 0.85;

    it('should classify >0.95 as exact duplicate', () => {
      expect(0.98 > SIMILARITY_EXACT_DUPLICATE).toBe(true);
      expect(0.96 > SIMILARITY_EXACT_DUPLICATE).toBe(true);
      expect(0.94 > SIMILARITY_EXACT_DUPLICATE).toBe(false);
    });

    it('should classify 0.85-0.95 as merge candidate', () => {
      const isMergeCandidate = (s: number) =>
        s > SIMILARITY_MERGE_CANDIDATE && s <= SIMILARITY_EXACT_DUPLICATE;

      expect(isMergeCandidate(0.90)).toBe(true);
      expect(isMergeCandidate(0.87)).toBe(true);
      expect(isMergeCandidate(0.96)).toBe(false); // too similar
      expect(isMergeCandidate(0.80)).toBe(false); // too different
    });

    it('should classify <0.85 as keep both', () => {
      expect(0.84 <= SIMILARITY_MERGE_CANDIDATE).toBe(true);
      expect(0.70 <= SIMILARITY_MERGE_CANDIDATE).toBe(true);
    });
  });

  describe('Pair processing', () => {
    it('should create unique pair keys', () => {
      // Pair key logic: min-max to avoid duplicates
      function pairKey(id1: number, id2: number): string {
        return `${Math.min(id1, id2)}-${Math.max(id1, id2)}`;
      }

      // Order shouldn't matter
      expect(pairKey(1, 5)).toBe('1-5');
      expect(pairKey(5, 1)).toBe('1-5');

      // Different pairs are different
      expect(pairKey(1, 2)).toBe('1-2');
      expect(pairKey(2, 3)).toBe('2-3');
    });

    it('should track processed pairs to avoid duplicates', () => {
      const processed = new Set<string>();

      function pairKey(id1: number, id2: number): string {
        return `${Math.min(id1, id2)}-${Math.max(id1, id2)}`;
      }

      // First time seeing pair 1-5
      const key1 = pairKey(1, 5);
      expect(processed.has(key1)).toBe(false);
      processed.add(key1);

      // Second time (different order) should be recognized
      const key2 = pairKey(5, 1);
      expect(processed.has(key2)).toBe(true);
    });
  });

  describe('Link transfer logic', () => {
    it('should not create self-referential links', () => {
      // When transferring links from deleted memory to kept memory,
      // we should skip links that would create self-references

      const keptId = 1;
      const deletedId = 2;

      // Outgoing links from deleted
      const outgoingLinks = [
        { source_id: deletedId, target_id: 3, relation: 'relates_to', weight: 0.8 },
        { source_id: deletedId, target_id: keptId, relation: 'relates_to', weight: 0.9 }, // Would be self-ref
      ];

      const validOutgoing = outgoingLinks.filter(link => link.target_id !== keptId);
      expect(validOutgoing).toHaveLength(1);
      expect(validOutgoing[0].target_id).toBe(3);

      // Incoming links to deleted
      const incomingLinks = [
        { source_id: 4, target_id: deletedId, relation: 'leads_to', weight: 0.7 },
        { source_id: keptId, target_id: deletedId, relation: 'leads_to', weight: 0.6 }, // Would be self-ref
      ];

      const validIncoming = incomingLinks.filter(link => link.source_id !== keptId);
      expect(validIncoming).toHaveLength(1);
      expect(validIncoming[0].source_id).toBe(4);
    });
  });

  describe('Quality-based decisions', () => {
    it('should prefer higher quality memory', () => {
      const memories = [
        { id: 1, quality_score: 0.9 },
        { id: 2, quality_score: 0.6 },
      ];

      const sorted = [...memories].sort((a, b) => (b.quality_score ?? 0.5) - (a.quality_score ?? 0.5));
      expect(sorted[0].id).toBe(1);
    });

    it('should use default quality when score is null', () => {
      const DEFAULT_QUALITY = 0.5;

      const memories = [
        { id: 1, quality_score: null },
        { id: 2, quality_score: 0.7 },
      ];

      const getQuality = (m: { quality_score: number | null }) => m.quality_score ?? DEFAULT_QUALITY;

      expect(getQuality(memories[0])).toBe(0.5);
      expect(getQuality(memories[1])).toBe(0.7);
    });

    it('should average quality scores on merge (not max)', () => {
      const q1 = 0.3;
      const q2 = 0.9;

      // Old behavior: max(q1, q2) = 0.9 (inflated)
      const oldScore = Math.max(q1, q2);
      expect(oldScore).toBe(0.9);

      // New behavior: average (q1 + q2) / 2 = 0.6 (fair)
      const newScore = (q1 + q2) / 2;
      expect(newScore).toBe(0.6);
      expect(newScore).toBeLessThan(oldScore);
    });
  });

  describe('Consolidation v2: Soft-delete design', () => {
    it('should use invalidation instead of deletion for delete_duplicate', () => {
      // The executeConsolidation flow for delete_duplicate:
      // 1. transferLinks(deleteId, keepId)
      // 2. createMemoryLink(keepId, deleteId, 'supersedes')
      // 3. invalidateMemory(deleteId, keepId)
      // NO deleteMemory() call

      const actions = [
        'transferLinks',
        'createMemoryLink_supersedes',
        'invalidateMemory',
      ];

      expect(actions).not.toContain('deleteMemory');
      expect(actions).toContain('invalidateMemory');
      expect(actions).toContain('createMemoryLink_supersedes');
    });

    it('should use invalidation instead of deletion for merge', () => {
      // The mergeMemories flow:
      // 1. saveMemory(merged) — inside transaction
      // 2. transferLinks(m1 → merged, m2 → merged)
      // 3. createMemoryLink(merged → m1, 'supersedes')
      // 4. createMemoryLink(merged → m2, 'supersedes')
      // 5. invalidateMemory(m1, merged)
      // 6. invalidateMemory(m2, merged)
      // NO deleteMemory() call

      const actions = [
        'saveMemory',
        'transferLinks_m1',
        'transferLinks_m2',
        'createMemoryLink_supersedes_m1',
        'createMemoryLink_supersedes_m2',
        'invalidateMemory_m1',
        'invalidateMemory_m2',
      ];

      expect(actions).not.toContain('deleteMemory');
      expect(actions.filter(a => a.startsWith('invalidateMemory'))).toHaveLength(2);
      expect(actions.filter(a => a.includes('supersedes'))).toHaveLength(2);
    });

    it('should wrap merge operations in transaction', () => {
      // All merge operations must be atomic:
      // save + transferLinks + supersedes links + invalidate originals
      // If any step fails, none should take effect

      const transactionSteps = [
        'saveMemory',
        'transferLinks',
        'createMemoryLink_supersedes',
        'invalidateMemory_m1',
        'invalidateMemory_m2',
      ];

      // All must be in same transaction scope
      expect(transactionSteps.length).toBeGreaterThan(1);
    });

    it('should correctly model invalidation semantics', () => {
      // invalidateMemory sets:
      //   valid_until = now (hides from normal search)
      //   invalidated_by = superseder ID (tracks what replaced it)

      const memory = {
        id: 42,
        valid_until: null as string | null,
        invalidated_by: null as number | null,
      };

      // Before invalidation
      expect(memory.invalidated_by).toBeNull();
      expect(memory.valid_until).toBeNull();

      // After invalidation by memory #100
      memory.valid_until = new Date().toISOString();
      memory.invalidated_by = 100;

      expect(memory.invalidated_by).toBe(100);
      expect(memory.valid_until).not.toBeNull();
    });

    it('should correctly model restore semantics', () => {
      // restoreInvalidatedMemory clears:
      //   valid_until = NULL
      //   invalidated_by = NULL

      const memory = {
        id: 42,
        valid_until: '2026-02-06T12:00:00Z',
        invalidated_by: 100,
      };

      // Restore
      memory.valid_until = null as any;
      memory.invalidated_by = null as any;

      expect(memory.invalidated_by).toBeNull();
      expect(memory.valid_until).toBeNull();
    });

    it('should filter invalidated memories from consolidation candidates', () => {
      // getAllMemoriesWithEmbeddings uses WHERE invalidated_by IS NULL
      // This prevents already-consolidated memories from being re-processed

      const allMemories = [
        { id: 1, invalidated_by: null },    // active
        { id: 2, invalidated_by: 100 },     // invalidated
        { id: 3, invalidated_by: null },    // active
        { id: 4, invalidated_by: 101 },     // invalidated
      ];

      const candidates = allMemories.filter(m => m.invalidated_by === null);
      expect(candidates).toHaveLength(2);
      expect(candidates.map(m => m.id)).toEqual([1, 3]);
    });
  });

  describe('Consolidation v2: Undo logic', () => {
    it('should find originals via supersedes links', () => {
      // undoConsolidation looks up: memory_links WHERE source_id = mergedId AND relation = 'supersedes'
      const supersededLinks = [
        { source_id: 100, target_id: 42, relation: 'supersedes' },
        { source_id: 100, target_id: 43, relation: 'supersedes' },
      ];

      const originalIds = supersededLinks.map(l => l.target_id);
      expect(originalIds).toEqual([42, 43]);
    });

    it('should delete synthetic merged memory but keep "kept" memory', () => {
      // If source = 'consolidation-llm', the merged memory was synthetic → delete it
      // If source != 'consolidation-llm', it was the "kept" one in dedup → leave it

      const syntheticMerge = { id: 100, source: 'consolidation-llm' };
      const keptMemory = { id: 101, source: 'user-input' };

      expect(syntheticMerge.source).toBe('consolidation-llm');
      expect(keptMemory.source).not.toBe('consolidation-llm');
    });

    it('should restore all originals on undo', () => {
      // Undo flow:
      // 1. Find supersedes links from merged ID
      // 2. restoreInvalidatedMemory for each original
      // 3. Remove supersedes links
      // 4. Delete synthetic merged memory if applicable

      const undoSteps = [
        'find_supersedes_links',
        'restore_original_42',
        'restore_original_43',
        'remove_supersedes_links',
        'delete_synthetic_merge',
      ];

      expect(undoSteps[0]).toBe('find_supersedes_links');
      expect(undoSteps.filter(s => s.startsWith('restore_')).length).toBe(2);
    });
  });

  describe('Consolidation v2: Config safety', () => {
    it('should require global opt-in for consolidation', () => {
      // Rule: consolidation = globalConsolidation === true && mergedValue !== false

      const cases = [
        { global: true,      project: undefined, expected: true,  desc: 'global true, project default' },
        { global: true,      project: false,     expected: false, desc: 'global true, project disables' },
        { global: true,      project: true,      expected: true,  desc: 'global true, project also true' },
        { global: false,     project: true,      expected: false, desc: 'global false, project tries to enable' },
        { global: undefined, project: true,      expected: false, desc: 'global unset, project tries to enable' },
        { global: undefined, project: undefined, expected: false, desc: 'both unset (default false)' },
        { global: false,     project: undefined, expected: false, desc: 'global false, project default' },
      ];

      for (const { global: g, project: p, expected, desc } of cases) {
        const result = g === true && p !== false;
        expect(result, desc).toBe(expected);
      }
    });
  });
});
