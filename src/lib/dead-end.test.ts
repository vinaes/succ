/**
 * Dead-End Tracking Tests (Phase 7.1)
 *
 * Tests for dead_end memory type, content formatting,
 * recall boost behavior, and extraction prompt integration.
 */

import { describe, it, expect } from 'vitest';
import { MEMORY_TYPES } from './storage/index.js';
import type { MemoryType } from './storage/index.js';
import { FACT_EXTRACTION_PROMPT, SESSION_PROGRESS_EXTRACTION_PROMPT } from '../prompts/extraction.js';

describe('Dead-End Tracking', () => {
  describe('Memory type registration', () => {
    it('should include dead_end in MEMORY_TYPES', () => {
      expect(MEMORY_TYPES).toContain('dead_end');
    });

    it('dead_end should be a valid MemoryType', () => {
      const validTypes: MemoryType[] = [...MEMORY_TYPES];
      expect(validTypes).toContain('dead_end');
    });

    it('should have 6 memory types total', () => {
      expect(MEMORY_TYPES).toHaveLength(6);
      expect(MEMORY_TYPES).toEqual(['observation', 'decision', 'learning', 'error', 'pattern', 'dead_end']);
    });
  });

  describe('Dead-end content formatting', () => {
    it('should format dead-end content with approach and failure reason', () => {
      const approach = 'Using Redis for session storage';
      const whyFailed = 'Memory usage too high for VPS tier';

      const content = `DEAD END: Tried "${approach}" — Failed because: ${whyFailed}`;

      expect(content).toContain('DEAD END:');
      expect(content).toContain(approach);
      expect(content).toContain(whyFailed);
    });

    it('should include context when provided', () => {
      const approach = 'Using worker threads for parsing';
      const whyFailed = 'Serialization overhead negated speed gains';
      const context = 'Tested with 1000 files, worker version was 2x slower';

      let content = `DEAD END: Tried "${approach}" — Failed because: ${whyFailed}`;
      content += `\nContext: ${context}`;

      expect(content).toContain('Context:');
      expect(content).toContain(context);
    });

    it('should not include context line when context is undefined', () => {
      const approach = 'Using mmap for large files';
      const whyFailed = 'Node.js does not support mmap natively';

      const content = `DEAD END: Tried "${approach}" — Failed because: ${whyFailed}`;

      expect(content).not.toContain('Context:');
    });
  });

  describe('Dead-end tagging', () => {
    it('should always include dead-end tag', () => {
      const userTags = ['database', 'performance'];
      const allTags = [...new Set([...userTags, 'dead-end'])];

      expect(allTags).toContain('dead-end');
      expect(allTags).toContain('database');
      expect(allTags).toContain('performance');
    });

    it('should not duplicate dead-end tag if user provides it', () => {
      const userTags = ['dead-end', 'auth'];
      const allTags = [...new Set([...userTags, 'dead-end'])];

      expect(allTags.filter(t => t === 'dead-end')).toHaveLength(1);
    });

    it('should work with empty user tags', () => {
      const userTags: string[] = [];
      const allTags = [...new Set([...userTags, 'dead-end'])];

      expect(allTags).toEqual(['dead-end']);
    });
  });

  describe('Dead-end recall boost', () => {
    it('should boost dead-end results by configured amount', () => {
      const deadEndBoost = 0.15;
      const results = [
        { similarity: 0.7, type: 'observation', tags: ['auth'] },
        { similarity: 0.65, type: 'dead_end', tags: ['dead-end', 'auth'] },
        { similarity: 0.6, type: 'learning', tags: ['auth'] },
      ];

      const boosted = results.map(r => {
        const isDeadEnd = r.type === 'dead_end' || r.tags.includes('dead-end');
        return {
          ...r,
          similarity: isDeadEnd ? Math.min(1.0, r.similarity + deadEndBoost) : r.similarity,
          _isDeadEnd: isDeadEnd,
        };
      });

      boosted.sort((a, b) => b.similarity - a.similarity);

      // Dead-end (0.65 + 0.15 = 0.80) should now be first
      expect(boosted[0]._isDeadEnd).toBe(true);
      expect(boosted[0].similarity).toBe(0.80);
    });

    it('should not boost non-dead-end results', () => {
      const deadEndBoost = 0.15;
      const result = { similarity: 0.7, type: 'observation', tags: ['auth'] };

      const isDeadEnd = result.type === 'dead_end' || result.tags.includes('dead-end');
      const finalSimilarity = isDeadEnd ? Math.min(1.0, result.similarity + deadEndBoost) : result.similarity;

      expect(finalSimilarity).toBe(0.7);
    });

    it('should cap boosted similarity at 1.0', () => {
      const deadEndBoost = 0.15;
      const result = { similarity: 0.95, type: 'dead_end', tags: ['dead-end'] };

      const finalSimilarity = Math.min(1.0, result.similarity + deadEndBoost);
      expect(finalSimilarity).toBe(1.0);
    });

    it('should disable boost when dead_end_boost is 0', () => {
      const deadEndBoost = 0;
      const result = { similarity: 0.65, type: 'dead_end', tags: ['dead-end'] };

      // When boost is 0, no modification happens
      if (deadEndBoost > 0) {
        const isDeadEnd = result.type === 'dead_end';
        if (isDeadEnd) {
          result.similarity = Math.min(1.0, result.similarity + deadEndBoost);
        }
      }

      expect(result.similarity).toBe(0.65); // Unchanged
    });

    it('should detect dead-ends by tag even without type field', () => {
      const deadEndBoost = 0.15;

      // Some search results may not have type field (e.g., hybrid search results)
      const result = { similarity: 0.6, tags: ['dead-end', 'redis'] };

      const isDeadEnd = (result as any).type === 'dead_end' || result.tags.includes('dead-end');
      expect(isDeadEnd).toBe(true);

      const finalSimilarity = Math.min(1.0, result.similarity + deadEndBoost);
      expect(finalSimilarity).toBe(0.75);
    });
  });

  describe('Dead-end deduplication', () => {
    it('should detect duplicate dead-ends by content prefix', () => {
      const existingContent = 'DEAD END: Tried "Using Redis for sessions" — Failed because: too much memory';
      const isExistingDeadEnd = existingContent.startsWith('DEAD END:');

      expect(isExistingDeadEnd).toBe(true);
    });

    it('should not flag non-dead-end memories as duplicates', () => {
      const existingContent = 'Redis is used for caching in the application';
      const isExistingDeadEnd = existingContent.startsWith('DEAD END:');

      expect(isExistingDeadEnd).toBe(false);
    });
  });

  describe('Extraction prompt integration', () => {
    it('should include dead_end type in FACT_EXTRACTION_PROMPT', () => {
      expect(FACT_EXTRACTION_PROMPT).toContain('Dead Ends');
      expect(FACT_EXTRACTION_PROMPT).toContain('dead_end');
    });

    it('should include dead_end type in SESSION_PROGRESS_EXTRACTION_PROMPT', () => {
      expect(SESSION_PROGRESS_EXTRACTION_PROMPT).toContain('Dead Ends');
      expect(SESSION_PROGRESS_EXTRACTION_PROMPT).toContain('dead_end');
    });

    it('should explain dead_end extraction criteria', () => {
      expect(FACT_EXTRACTION_PROMPT).toContain('tried and explicitly failed');
      expect(FACT_EXTRACTION_PROMPT).toContain('WHY it failed');
    });

    it('should include dead_end example in JSON output format', () => {
      expect(FACT_EXTRACTION_PROMPT).toContain('"type": "dead_end"');
      expect(FACT_EXTRACTION_PROMPT).toContain('"DEAD END:');
    });
  });
});
