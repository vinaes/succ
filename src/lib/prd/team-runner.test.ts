import { describe, it, expect, vi } from 'vitest';
import type { Task } from './types.js';
import type { RunningTask } from './team-runner.js';

// Mock scheduler
vi.mock('./scheduler.js', () => ({
  allDependenciesMet: (task: Task, tasks: Task[]) => {
    for (const depId of task.depends_on) {
      const dep = tasks.find((t) => t.id === depId);
      if (dep && dep.status !== 'completed' && dep.status !== 'skipped') {
        return false;
      }
    }
    return true;
  },
}));

import { getReadyTasks } from './team-runner.js';

// ============================================================================
// Test helpers
// ============================================================================

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_001',
    prd_id: 'prd_test',
    sequence: 1,
    title: 'Test Task',
    description: 'Do something',
    status: 'pending',
    priority: 'medium',
    depends_on: [],
    acceptance_criteria: ['it works'],
    files_to_modify: [],
    relevant_files: [],
    context_queries: [],
    attempts: [],
    max_attempts: 3,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeRunning(task: Task): RunningTask {
  return {
    task,
    executor: { execute: vi.fn(), abort: vi.fn() } as never,
    promise: Promise.resolve() as never,
    worktreePath: '/fake/worktree',
  };
}

// ============================================================================
// getReadyTasks
// ============================================================================

describe('getReadyTasks', () => {
  it('should return pending tasks with no dependencies', () => {
    const tasks = [
      makeTask({ id: 'task_001', status: 'pending' }),
      makeTask({ id: 'task_002', status: 'pending' }),
    ];

    const ready = getReadyTasks(tasks, []);

    expect(ready).toHaveLength(2);
    expect(ready.map((t) => t.id)).toEqual(['task_001', 'task_002']);
  });

  it('should exclude non-pending tasks', () => {
    const tasks = [
      makeTask({ id: 'task_001', status: 'completed' }),
      makeTask({ id: 'task_002', status: 'in_progress' }),
      makeTask({ id: 'task_003', status: 'failed' }),
      makeTask({ id: 'task_004', status: 'skipped' }),
      makeTask({ id: 'task_005', status: 'pending' }),
    ];

    const ready = getReadyTasks(tasks, []);

    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe('task_005');
  });

  it('should exclude tasks with unmet dependencies', () => {
    const tasks = [
      makeTask({ id: 'task_001', status: 'pending' }),
      makeTask({ id: 'task_002', status: 'pending', depends_on: ['task_001'] }),
    ];

    const ready = getReadyTasks(tasks, []);

    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe('task_001');
  });

  it('should include tasks whose dependencies are completed', () => {
    const tasks = [
      makeTask({ id: 'task_001', status: 'completed' }),
      makeTask({ id: 'task_002', status: 'pending', depends_on: ['task_001'] }),
    ];

    const ready = getReadyTasks(tasks, []);

    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe('task_002');
  });

  it('should exclude tasks with file conflicts with running tasks', () => {
    const tasks = [
      makeTask({ id: 'task_001', status: 'in_progress', files_to_modify: ['src/auth.ts'] }),
      makeTask({ id: 'task_002', status: 'pending', files_to_modify: ['src/auth.ts'] }),
      makeTask({ id: 'task_003', status: 'pending', files_to_modify: ['src/utils.ts'] }),
    ];

    const running: RunningTask[] = [makeRunning(tasks[0])];

    const ready = getReadyTasks(tasks, running);

    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe('task_003');
  });

  it('should allow tasks when files_to_modify is empty', () => {
    const tasks = [
      makeTask({ id: 'task_001', status: 'in_progress', files_to_modify: ['src/auth.ts'] }),
      makeTask({ id: 'task_002', status: 'pending', files_to_modify: [] }),
    ];

    const running: RunningTask[] = [makeRunning(tasks[0])];

    const ready = getReadyTasks(tasks, running);

    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe('task_002');
  });

  it('should exclude tasks that exhausted max_attempts', () => {
    const tasks = [
      makeTask({
        id: 'task_001',
        status: 'pending',
        max_attempts: 2,
        attempts: [
          {
            attempt_number: 1,
            started_at: '',
            completed_at: '',
            status: 'failed',
            gate_results: [],
            files_actually_modified: [],
            memories_recalled: 0,
            memories_created: 0,
            dead_ends_recorded: 0,
            error: null,
            output_log: '',
          },
          {
            attempt_number: 2,
            started_at: '',
            completed_at: '',
            status: 'failed',
            gate_results: [],
            files_actually_modified: [],
            memories_recalled: 0,
            memories_created: 0,
            dead_ends_recorded: 0,
            error: null,
            output_log: '',
          },
        ],
      }),
    ];

    const ready = getReadyTasks(tasks, []);

    expect(ready).toHaveLength(0);
  });

  it('should handle multiple file overlaps correctly', () => {
    const tasks = [
      makeTask({ id: 'task_001', status: 'in_progress', files_to_modify: ['a.ts', 'b.ts'] }),
      makeTask({ id: 'task_002', status: 'pending', files_to_modify: ['b.ts', 'c.ts'] }),
      makeTask({ id: 'task_003', status: 'pending', files_to_modify: ['d.ts'] }),
    ];

    const running: RunningTask[] = [makeRunning(tasks[0])];

    const ready = getReadyTasks(tasks, running);

    // task_002 conflicts on b.ts, task_003 is clean
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe('task_003');
  });

  it('should return empty when all tasks have failed deps', () => {
    const tasks = [
      makeTask({ id: 'task_001', status: 'failed' }),
      makeTask({ id: 'task_002', status: 'pending', depends_on: ['task_001'] }),
    ];

    const ready = getReadyTasks(tasks, []);

    // task_002 depends on task_001 which is failed (not completed/skipped)
    expect(ready).toHaveLength(0);
  });
});
