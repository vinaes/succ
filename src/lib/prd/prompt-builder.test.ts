import { describe, it, expect } from 'vitest';
import { buildTaskPrompt, appendFailureContext } from './prompt-builder.js';
import { createTask, createPrd, createGate } from './types.js';
import type { TaskContext } from './context.js';

describe('Prompt Builder', () => {
  const mockContext: TaskContext = {
    recalled_memories: '[learning] Use ESM imports with .js extensions',
    dead_end_warnings: '[DEAD-END] Tried using CommonJS — failed because ESM required',
    progress_so_far: '[2024-01-01 12:00:00] Started task_001',
  };

  describe('buildTaskPrompt', () => {
    it('should include task title and description', () => {
      const task = createTask({
        prd_id: 'prd_test',
        sequence: 1,
        title: 'Add schema column',
        description: 'Add a new column to the database schema',
      });
      const prd = createPrd({ title: 'Test PRD', description: 'desc' });
      const prompt = buildTaskPrompt(task, prd, mockContext);

      expect(prompt).toContain('task_001: Add schema column');
      expect(prompt).toContain('Add a new column to the database schema');
    });

    it('should include acceptance criteria', () => {
      const task = createTask({
        prd_id: 'prd_test',
        sequence: 1,
        title: 'Test task',
        description: 'desc',
        acceptance_criteria: ['Column exists in DB', 'Migration runs without errors'],
      });
      const prd = createPrd({ title: 'Test PRD', description: 'desc' });
      const prompt = buildTaskPrompt(task, prd, mockContext);

      expect(prompt).toContain('Column exists in DB');
      expect(prompt).toContain('Migration runs without errors');
    });

    it('should include files to modify', () => {
      const task = createTask({
        prd_id: 'prd_test',
        sequence: 1,
        title: 'Test task',
        description: 'desc',
        files_to_modify: ['src/db/schema.ts', 'src/db/migration.ts'],
      });
      const prd = createPrd({ title: 'Test PRD', description: 'desc' });
      const prompt = buildTaskPrompt(task, prd, mockContext);

      expect(prompt).toContain('src/db/schema.ts');
      expect(prompt).toContain('src/db/migration.ts');
    });

    it('should include recalled memories and dead-end warnings', () => {
      const task = createTask({
        prd_id: 'prd_test',
        sequence: 1,
        title: 'Test task',
        description: 'desc',
      });
      const prd = createPrd({ title: 'Test PRD', description: 'desc' });
      const prompt = buildTaskPrompt(task, prd, mockContext);

      expect(prompt).toContain('Use ESM imports');
      expect(prompt).toContain('DEAD-END');
      expect(prompt).toContain('CommonJS');
    });

    it('should include quality gates', () => {
      const task = createTask({
        prd_id: 'prd_test',
        sequence: 1,
        title: 'Test task',
        description: 'desc',
      });
      const prd = createPrd({
        title: 'Test PRD',
        description: 'desc',
        quality_gates: [
          createGate('typecheck', 'npx tsc --noEmit'),
          createGate('test', 'npm test'),
        ],
      });
      const prompt = buildTaskPrompt(task, prd, mockContext);

      expect(prompt).toContain('npx tsc --noEmit');
      expect(prompt).toContain('npm test');
    });

    it('should include progress so far', () => {
      const task = createTask({
        prd_id: 'prd_test',
        sequence: 1,
        title: 'Test task',
        description: 'desc',
      });
      const prd = createPrd({ title: 'Test PRD', description: 'desc' });
      const prompt = buildTaskPrompt(task, prd, mockContext);

      expect(prompt).toContain('Started task_001');
    });
  });

  describe('appendFailureContext', () => {
    it('should append failure info to prompt', () => {
      const prompt = 'Original prompt content';
      const result = appendFailureContext(prompt, 1, 'Gate output here', 'Agent output here');

      expect(result).toContain('Original prompt content');
      expect(result).toContain('Previous Attempt (1) Failed');
      expect(result).toContain('Gate output here');
      expect(result).toContain('Agent output here');
    });

    it('should truncate long agent output', () => {
      const prompt = 'Original';
      const longOutput = 'x'.repeat(5000);
      const result = appendFailureContext(prompt, 2, '', longOutput);

      expect(result).toContain('Previous Attempt (2) Failed');
      // Should contain the last 2000 chars
      expect(result.length).toBeLessThan(prompt.length + 5000 + 500);
    });

    it('should handle empty outputs', () => {
      const result = appendFailureContext('Base', 1, '', '');
      expect(result).toContain('(No gate output)');
      expect(result).toContain('(No output)');
    });
  });
});
