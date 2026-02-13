import { describe, it, expect } from 'vitest';
import { topologicalSort, allDependenciesMet, validateTaskGraph } from './scheduler.js';
import { createTask } from './types.js';

function makeTask(seq: number, deps: string[] = [], files: string[] = []) {
  return createTask({
    prd_id: 'prd_test',
    sequence: seq,
    title: `Task ${seq}`,
    description: `Description ${seq}`,
    depends_on: deps,
    files_to_modify: files,
  });
}

describe('Scheduler', () => {
  describe('topologicalSort', () => {
    it('should sort independent tasks by sequence', () => {
      const tasks = [makeTask(3), makeTask(1), makeTask(2)];
      const sorted = topologicalSort(tasks);
      expect(sorted.map((t) => t.id)).toEqual(['task_003', 'task_001', 'task_002']);
    });

    it('should respect dependencies', () => {
      const tasks = [makeTask(1), makeTask(2, ['task_001']), makeTask(3, ['task_002'])];
      const sorted = topologicalSort(tasks);
      const ids = sorted.map((t) => t.id);
      expect(ids.indexOf('task_001')).toBeLessThan(ids.indexOf('task_002'));
      expect(ids.indexOf('task_002')).toBeLessThan(ids.indexOf('task_003'));
    });

    it('should handle diamond dependencies', () => {
      const tasks = [
        makeTask(1),
        makeTask(2, ['task_001']),
        makeTask(3, ['task_001']),
        makeTask(4, ['task_002', 'task_003']),
      ];
      const sorted = topologicalSort(tasks);
      const ids = sorted.map((t) => t.id);
      expect(ids.indexOf('task_001')).toBeLessThan(ids.indexOf('task_002'));
      expect(ids.indexOf('task_001')).toBeLessThan(ids.indexOf('task_003'));
      expect(ids.indexOf('task_002')).toBeLessThan(ids.indexOf('task_004'));
      expect(ids.indexOf('task_003')).toBeLessThan(ids.indexOf('task_004'));
    });

    it('should throw on circular dependency', () => {
      const tasks = [makeTask(1, ['task_002']), makeTask(2, ['task_001'])];
      expect(() => topologicalSort(tasks)).toThrow('Circular dependency');
    });
  });

  describe('allDependenciesMet', () => {
    it('should return true for task with no dependencies', () => {
      const task = makeTask(1);
      expect(allDependenciesMet(task, [task])).toBe(true);
    });

    it('should return true when all deps are completed', () => {
      const dep = makeTask(1);
      dep.status = 'completed';
      const task = makeTask(2, ['task_001']);
      expect(allDependenciesMet(task, [dep, task])).toBe(true);
    });

    it('should return true when all deps are skipped', () => {
      const dep = makeTask(1);
      dep.status = 'skipped';
      const task = makeTask(2, ['task_001']);
      expect(allDependenciesMet(task, [dep, task])).toBe(true);
    });

    it('should return false when a dep is pending', () => {
      const dep = makeTask(1);
      dep.status = 'pending';
      const task = makeTask(2, ['task_001']);
      expect(allDependenciesMet(task, [dep, task])).toBe(false);
    });

    it('should return false when a dep is in_progress', () => {
      const dep = makeTask(1);
      dep.status = 'in_progress';
      const task = makeTask(2, ['task_001']);
      expect(allDependenciesMet(task, [dep, task])).toBe(false);
    });

    it('should return false when a dep is failed', () => {
      const dep = makeTask(1);
      dep.status = 'failed';
      const task = makeTask(2, ['task_001']);
      expect(allDependenciesMet(task, [dep, task])).toBe(false);
    });
  });

  describe('validateTaskGraph', () => {
    it('should pass for valid graph', () => {
      const tasks = [
        makeTask(1, [], ['src/a.ts']),
        makeTask(2, ['task_001'], ['src/b.ts']),
        makeTask(3, ['task_002'], ['src/c.ts']),
      ];
      const result = validateTaskGraph(tasks);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should error on circular dependency', () => {
      const tasks = [
        makeTask(1, ['task_002'], ['src/a.ts']),
        makeTask(2, ['task_001'], ['src/b.ts']),
      ];
      const result = validateTaskGraph(tasks);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Circular'))).toBe(true);
    });

    it('should error on invalid dep reference', () => {
      const tasks = [makeTask(1, ['task_099'], ['src/a.ts'])];
      const result = validateTaskGraph(tasks);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('non-existent'))).toBe(true);
    });

    it('should warn about file overlap without dependency', () => {
      const tasks = [
        makeTask(1, [], ['src/shared.ts']),
        makeTask(2, [], ['src/shared.ts']),
        makeTask(3, [], ['src/other.ts']),
      ];
      const result = validateTaskGraph(tasks);
      expect(result.warnings.some((w) => w.includes('src/shared.ts'))).toBe(true);
    });

    it('should not warn about file overlap with dependency', () => {
      const tasks = [
        makeTask(1, [], ['src/shared.ts']),
        makeTask(2, ['task_001'], ['src/shared.ts']),
      ];
      const result = validateTaskGraph(tasks);
      const fileWarnings = result.warnings.filter((w) => w.includes('src/shared.ts'));
      expect(fileWarnings).toHaveLength(0);
    });

    it('should warn about tasks with no files_to_modify', () => {
      const tasks = [makeTask(1), makeTask(2, [], ['src/a.ts']), makeTask(3, [], ['src/b.ts'])];
      const result = validateTaskGraph(tasks);
      expect(result.warnings.some((w) => w.includes('no files_to_modify'))).toBe(true);
    });
  });
});
