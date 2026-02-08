import { describe, it, expect } from 'vitest';
import {
  generatePrdId,
  generateTaskId,
  emptyPrdStats,
  createGate,
  createPrd,
  createTask,
  createExecution,
  prdToIndexEntry,
  computeStats,
} from './types.js';

describe('PRD Types', () => {
  describe('generatePrdId', () => {
    it('should generate id with prd_ prefix', () => {
      const id = generatePrdId();
      expect(id).toMatch(/^prd_[a-f0-9]{8}$/);
    });

    it('should generate unique ids', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generatePrdId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('generateTaskId', () => {
    it('should generate zero-padded task ids', () => {
      expect(generateTaskId(1)).toBe('task_001');
      expect(generateTaskId(10)).toBe('task_010');
      expect(generateTaskId(100)).toBe('task_100');
    });
  });

  describe('emptyPrdStats', () => {
    it('should return zeroed stats', () => {
      const stats = emptyPrdStats();
      expect(stats.total_tasks).toBe(0);
      expect(stats.completed_tasks).toBe(0);
      expect(stats.failed_tasks).toBe(0);
      expect(stats.skipped_tasks).toBe(0);
      expect(stats.total_attempts).toBe(0);
      expect(stats.total_duration_ms).toBe(0);
    });
  });

  describe('createGate', () => {
    it('should create a gate with defaults', () => {
      const gate = createGate('typecheck', 'npx tsc --noEmit');
      expect(gate.type).toBe('typecheck');
      expect(gate.command).toBe('npx tsc --noEmit');
      expect(gate.required).toBe(true);
      expect(gate.timeout_ms).toBe(120_000);
    });

    it('should accept custom required and timeout', () => {
      const gate = createGate('test', 'npm test', false, 60_000);
      expect(gate.required).toBe(false);
      expect(gate.timeout_ms).toBe(60_000);
    });
  });

  describe('createPrd', () => {
    it('should create a PRD with defaults', () => {
      const prd = createPrd({ title: 'Test', description: 'Test desc' });
      expect(prd.id).toMatch(/^prd_/);
      expect(prd.version).toBe(1);
      expect(prd.title).toBe('Test');
      expect(prd.description).toBe('Test desc');
      expect(prd.status).toBe('draft');
      expect(prd.execution_mode).toBe('loop');
      expect(prd.goals).toEqual([]);
      expect(prd.out_of_scope).toEqual([]);
      expect(prd.quality_gates).toEqual([]);
      expect(prd.started_at).toBeNull();
      expect(prd.completed_at).toBeNull();
      expect(prd.created_at).toBeTruthy();
      expect(prd.stats.total_tasks).toBe(0);
    });

    it('should accept optional fields', () => {
      const prd = createPrd({
        title: 'Auth',
        description: 'JWT',
        execution_mode: 'team',
        goals: ['Secure', 'Fast'],
        quality_gates: [createGate('test', 'npm test')],
      });
      expect(prd.execution_mode).toBe('team');
      expect(prd.goals).toEqual(['Secure', 'Fast']);
      expect(prd.quality_gates).toHaveLength(1);
    });
  });

  describe('createTask', () => {
    it('should create a task with defaults', () => {
      const task = createTask({
        prd_id: 'prd_12345678',
        sequence: 3,
        title: 'Add auth',
        description: 'Implement auth',
      });
      expect(task.id).toBe('task_003');
      expect(task.prd_id).toBe('prd_12345678');
      expect(task.sequence).toBe(3);
      expect(task.status).toBe('pending');
      expect(task.priority).toBe('medium');
      expect(task.depends_on).toEqual([]);
      expect(task.attempts).toEqual([]);
      expect(task.max_attempts).toBe(3);
    });

    it('should accept optional fields', () => {
      const task = createTask({
        prd_id: 'prd_12345678',
        sequence: 1,
        title: 'Core',
        description: 'Core impl',
        priority: 'critical',
        depends_on: ['task_001'],
        files_to_modify: ['src/auth.ts'],
        max_attempts: 5,
      });
      expect(task.priority).toBe('critical');
      expect(task.depends_on).toEqual(['task_001']);
      expect(task.files_to_modify).toEqual(['src/auth.ts']);
      expect(task.max_attempts).toBe(5);
    });
  });

  describe('createExecution', () => {
    it('should create execution with defaults', () => {
      const exec = createExecution({
        prd_id: 'prd_12345678',
        mode: 'loop',
        branch: 'prd/prd_12345678',
        original_branch: 'master',
      });
      expect(exec.prd_id).toBe('prd_12345678');
      expect(exec.mode).toBe('loop');
      expect(exec.branch).toBe('prd/prd_12345678');
      expect(exec.original_branch).toBe('master');
      expect(exec.max_iterations).toBe(3);
      expect(exec.iteration).toBe(0);
      expect(exec.current_task_id).toBeNull();
      expect(exec.pid).toBeNull();
      expect(exec.team_name).toBeNull();
    });
  });

  describe('prdToIndexEntry', () => {
    it('should extract index fields from PRD', () => {
      const prd = createPrd({ title: 'Test', description: 'Desc' });
      const entry = prdToIndexEntry(prd);
      expect(entry.id).toBe(prd.id);
      expect(entry.title).toBe('Test');
      expect(entry.status).toBe('draft');
      expect(entry.execution_mode).toBe('loop');
      expect(entry.created_at).toBe(prd.created_at);
    });
  });

  describe('computeStats', () => {
    it('should compute stats from empty tasks', () => {
      const stats = computeStats([]);
      expect(stats.total_tasks).toBe(0);
      expect(stats.completed_tasks).toBe(0);
    });

    it('should count task statuses correctly', () => {
      const tasks = [
        createTask({ prd_id: 'p', sequence: 1, title: 'A', description: '' }),
        createTask({ prd_id: 'p', sequence: 2, title: 'B', description: '' }),
        createTask({ prd_id: 'p', sequence: 3, title: 'C', description: '' }),
      ];
      tasks[0].status = 'completed';
      tasks[1].status = 'failed';
      tasks[2].status = 'skipped';

      const stats = computeStats(tasks);
      expect(stats.total_tasks).toBe(3);
      expect(stats.completed_tasks).toBe(1);
      expect(stats.failed_tasks).toBe(1);
      expect(stats.skipped_tasks).toBe(1);
    });

    it('should count total attempts', () => {
      const task = createTask({ prd_id: 'p', sequence: 1, title: 'A', description: '' });
      task.attempts = [
        { attempt_number: 1, started_at: '2024-01-01T00:00:00Z', completed_at: '2024-01-01T00:05:00Z', status: 'failed', gate_results: [], files_actually_modified: [], memories_recalled: 0, memories_created: 0, dead_ends_recorded: 0, error: null, output_log: '' },
        { attempt_number: 2, started_at: '2024-01-01T00:06:00Z', completed_at: '2024-01-01T00:10:00Z', status: 'passed', gate_results: [], files_actually_modified: [], memories_recalled: 0, memories_created: 0, dead_ends_recorded: 0, error: null, output_log: '' },
      ];

      const stats = computeStats([task]);
      expect(stats.total_attempts).toBe(2);
      // 5 minutes + 4 minutes = 540_000ms
      expect(stats.total_duration_ms).toBe(540_000);
    });
  });
});
