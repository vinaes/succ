/**
 * Hook Rules — matchRules() unit tests
 *
 * Tests the pure matching logic for dynamic hook rules from memory.
 */

import { describe, it, expect } from 'vitest';
import { matchRules } from './hook-rules.js';
import type { Memory } from './storage/types.js';

function makeMemory(
  overrides: Partial<Memory> & { id: number; content: string; tags: string[] }
): Memory {
  return {
    source: null,
    type: 'decision',
    quality_score: null,
    quality_factors: null,
    access_count: 0,
    last_accessed: null,
    valid_from: null,
    valid_until: null,
    correction_count: 0,
    is_invariant: false,
    priority_score: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('matchRules', () => {
  describe('tool filter', () => {
    it('should match when tool:{Name} matches tool name', () => {
      const memories = [
        makeMemory({ id: 1, content: 'rule for bash', tags: ['hook-rule', 'tool:Bash'] }),
      ];
      const result = matchRules(memories, 'Bash', { command: 'echo hi' });
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('rule for bash');
    });

    it('should not match when tool:{Name} does not match', () => {
      const memories = [
        makeMemory({ id: 1, content: 'rule for bash', tags: ['hook-rule', 'tool:Bash'] }),
      ];
      const result = matchRules(memories, 'Edit', { file_path: '/src/foo.ts' });
      expect(result).toHaveLength(0);
    });

    it('should match case-insensitively', () => {
      const memories = [makeMemory({ id: 1, content: 'rule', tags: ['hook-rule', 'tool:bash'] })];
      const result = matchRules(memories, 'Bash', { command: 'ls' });
      expect(result).toHaveLength(1);
    });

    it('should match all tools when no tool: tag present', () => {
      const memories = [makeMemory({ id: 1, content: 'universal rule', tags: ['hook-rule'] })];
      expect(matchRules(memories, 'Bash', { command: 'ls' })).toHaveLength(1);
      expect(matchRules(memories, 'Edit', { file_path: '/foo.ts' })).toHaveLength(1);
      expect(matchRules(memories, 'Skill', { skill: 'deploy' })).toHaveLength(1);
    });
  });

  describe('regex match filter', () => {
    it('should match Bash command against match:{regex}', () => {
      const memories = [
        makeMemory({
          id: 1,
          content: 'pre-deploy rule',
          tags: ['hook-rule', 'tool:Bash', 'match:deploy'],
        }),
      ];
      expect(matchRules(memories, 'Bash', { command: 'npm run deploy' })).toHaveLength(1);
      expect(matchRules(memories, 'Bash', { command: 'npm test' })).toHaveLength(0);
    });

    it('should match Skill name against match:{regex}', () => {
      const memories = [
        makeMemory({
          id: 1,
          content: 'deploy rule',
          tags: ['hook-rule', 'tool:Skill', 'match:deploy'],
        }),
      ];
      expect(matchRules(memories, 'Skill', { skill: 'deploy' })).toHaveLength(1);
      expect(matchRules(memories, 'Skill', { skill: 'commit' })).toHaveLength(0);
    });

    it('should match Edit/Write file_path basename against match:{regex}', () => {
      const memories = [
        makeMemory({
          id: 1,
          content: 'test file rule',
          tags: ['hook-rule', 'tool:Edit', 'match:\\.test\\.'],
        }),
      ];
      expect(matchRules(memories, 'Edit', { file_path: '/src/lib/db.test.ts' })).toHaveLength(1);
      expect(matchRules(memories, 'Edit', { file_path: '/src/lib/db.ts' })).toHaveLength(0);
    });

    it('should match Task prompt against match:{regex}', () => {
      const memories = [
        makeMemory({
          id: 1,
          content: 'review rule',
          tags: ['hook-rule', 'tool:Task', 'match:review'],
        }),
      ];
      expect(matchRules(memories, 'Task', { prompt: 'Review the staged diff' })).toHaveLength(1);
      expect(matchRules(memories, 'Task', { prompt: 'Build the project' })).toHaveLength(0);
    });

    it('should match all inputs when no match: tag present', () => {
      const memories = [
        makeMemory({ id: 1, content: 'all bash', tags: ['hook-rule', 'tool:Bash'] }),
      ];
      expect(matchRules(memories, 'Bash', { command: 'anything' })).toHaveLength(1);
      expect(matchRules(memories, 'Bash', { command: '' })).toHaveLength(1);
    });

    it('should skip regex patterns exceeding max length', () => {
      const longPattern = 'a'.repeat(201);
      const memories = [
        makeMemory({ id: 1, content: 'long regex', tags: ['hook-rule', `match:${longPattern}`] }),
      ];
      expect(matchRules(memories, 'Bash', { command: 'a'.repeat(300) })).toHaveLength(0);
    });

    it('should skip invalid regex gracefully', () => {
      const memories = [
        makeMemory({ id: 1, content: 'bad regex', tags: ['hook-rule', 'match:[invalid('] }),
      ];
      // Invalid regex → no match (skipped), not an error
      expect(matchRules(memories, 'Bash', { command: 'anything' })).toHaveLength(0);
    });

    it('should match if any match: tag matches', () => {
      const memories = [
        makeMemory({
          id: 1,
          content: 'multi-match',
          tags: ['hook-rule', 'match:deploy', 'match:release'],
        }),
      ];
      expect(matchRules(memories, 'Bash', { command: 'npm run deploy' })).toHaveLength(1);
      expect(matchRules(memories, 'Bash', { command: 'npm run release' })).toHaveLength(1);
      expect(matchRules(memories, 'Bash', { command: 'npm test' })).toHaveLength(0);
    });
  });

  describe('action mapping', () => {
    it('should map error type to deny', () => {
      const memories = [
        makeMemory({ id: 1, content: 'block this', tags: ['hook-rule'], type: 'error' }),
      ];
      expect(matchRules(memories, 'Bash', { command: 'ls' })[0].action).toBe('deny');
    });

    it('should map pattern type to ask', () => {
      const memories = [
        makeMemory({ id: 1, content: 'confirm this', tags: ['hook-rule'], type: 'pattern' }),
      ];
      expect(matchRules(memories, 'Bash', { command: 'ls' })[0].action).toBe('ask');
    });

    it('should map decision/observation/learning to inject', () => {
      for (const type of ['decision', 'observation', 'learning'] as const) {
        const memories = [makeMemory({ id: 1, content: 'inject this', tags: ['hook-rule'], type })];
        expect(matchRules(memories, 'Bash', { command: 'ls' })[0].action).toBe('inject');
      }
    });

    it('should default null type to inject', () => {
      const memories = [makeMemory({ id: 1, content: 'no type', tags: ['hook-rule'], type: null })];
      expect(matchRules(memories, 'Bash', { command: 'ls' })[0].action).toBe('inject');
    });
  });

  describe('sort order', () => {
    it('should sort deny before ask before inject', () => {
      const memories = [
        makeMemory({ id: 1, content: 'inject', tags: ['hook-rule'], type: 'decision' }),
        makeMemory({ id: 2, content: 'deny', tags: ['hook-rule'], type: 'error' }),
        makeMemory({ id: 3, content: 'ask', tags: ['hook-rule'], type: 'pattern' }),
      ];
      const result = matchRules(memories, 'Bash', { command: 'ls' });
      expect(result).toHaveLength(3);
      expect(result[0].action).toBe('deny');
      expect(result[1].action).toBe('ask');
      expect(result[2].action).toBe('inject');
    });
  });

  describe('edge cases', () => {
    it('should return empty array when no memories match', () => {
      const memories = [
        makeMemory({ id: 1, content: 'bash only', tags: ['hook-rule', 'tool:Bash'] }),
      ];
      expect(matchRules(memories, 'Edit', { file_path: '/foo.ts' })).toHaveLength(0);
    });

    it('should return empty array for empty memories', () => {
      expect(matchRules([], 'Bash', { command: 'ls' })).toHaveLength(0);
    });

    it('should handle memories with empty tags array', () => {
      const memories = [makeMemory({ id: 1, content: 'no tags', tags: [] })];
      // No tool: tag = matches all, no match: tag = matches all
      expect(matchRules(memories, 'Bash', { command: 'ls' })).toHaveLength(1);
    });

    it('should use JSON.stringify fallback for unknown tools', () => {
      const memories = [
        makeMemory({ id: 1, content: 'custom match', tags: ['hook-rule', 'match:foobar'] }),
      ];
      expect(matchRules(memories, 'CustomTool', { data: 'foobar' })).toHaveLength(1);
      expect(matchRules(memories, 'CustomTool', { data: 'other' })).toHaveLength(0);
    });
  });
});
