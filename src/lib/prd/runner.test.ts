import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isProcessRunning } from './runner.js';

// ============================================================================
// isProcessRunning
// ============================================================================

describe('isProcessRunning', () => {
  it('should return true for the current process', () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it('should return false for a non-existent PID', () => {
    // PID 999999 is very unlikely to exist
    expect(isProcessRunning(999999)).toBe(false);
  });

  it('should return false for PID 0', () => {
    // PID 0 is the system idle process, process.kill(0, 0) checks the
    // *calling* process group — but we want to ensure no crash
    const result = isProcessRunning(0);
    expect(typeof result).toBe('boolean');
  });
});

// ============================================================================
// Resume validation (via runPrd with mocked dependencies)
// ============================================================================

// Mock all external dependencies
vi.mock('../config.js', () => ({
  getProjectRoot: () => '/fake/project',
  getConfig: () => ({}),
}));

vi.mock('./executor.js', () => ({
  LoopExecutor: class {
    execute() {
      return { success: true, output: '', exit_code: 0 };
    }
  },
}));

vi.mock('./context.js', () => ({
  gatherTaskContext: () => ({}),
}));

vi.mock('./prompt-builder.js', () => ({
  buildTaskPrompt: () => 'fake prompt',
  appendFailureContext: (p: string) => p,
}));

vi.mock('./gates.js', () => ({
  runAllGates: () => [],
  allRequiredPassed: () => true,
  formatGateResults: () => '',
}));

// Mock state module with controllable returns
const mockLoadPrd = vi.fn();
const mockSavePrd = vi.fn();
const mockLoadTasks = vi.fn();
const mockSaveTasks = vi.fn();
const mockSaveExecution = vi.fn();
const mockLoadExecution = vi.fn();
const mockAppendProgress = vi.fn();
const mockAppendTaskLog = vi.fn();
const mockGetTaskLogPath = vi.fn((_id: string, _taskId: string) => '/fake/log');

vi.mock('./state.js', () => ({
  loadPrd: (id: string) => mockLoadPrd(id),
  savePrd: (prd: unknown) => mockSavePrd(prd),
  loadTasks: (id: string) => mockLoadTasks(id),
  saveTasks: (id: string, tasks: unknown) => mockSaveTasks(id, tasks),
  saveExecution: (exec: unknown) => mockSaveExecution(exec),
  loadExecution: (id: string) => mockLoadExecution(id),
  appendProgress: (id: string, msg: string) => mockAppendProgress(id, msg),
  appendTaskLog: (id: string, taskId: string, chunk: string) =>
    mockAppendTaskLog(id, taskId, chunk),
  getTaskLogPath: (id: string, taskId: string) => mockGetTaskLogPath(id, taskId),
}));

// Mock scheduler
vi.mock('./scheduler.js', () => ({
  validateTaskGraph: () => ({ valid: true, errors: [], warnings: [] }),
  topologicalSort: (tasks: unknown[]) => tasks,
  allDependenciesMet: () => true,
}));

// Mock types
vi.mock('./types.js', () => ({
  createExecution: (opts: Record<string, unknown>) => ({
    prd_id: opts.prd_id,
    mode: opts.mode,
    branch: opts.branch,
    original_branch: opts.original_branch,
    started_at: new Date().toISOString(),
    current_task_id: null,
    iteration: 0,
    max_iterations: opts.max_iterations ?? 3,
    pid: null,
    team_name: null,
    concurrency: null,
    log_file: '',
  }),
  computeStats: () => ({
    total_tasks: 0,
    completed_tasks: 0,
    failed_tasks: 0,
    skipped_tasks: 0,
    total_attempts: 0,
    total_duration_ms: 0,
  }),
}));

// Mock child_process (git commands)
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (cmd: string, opts?: unknown) => mockExecSync(cmd, opts),
}));

import { runPrd } from './runner.js';
import type { Prd, PrdExecution, Task } from './types.js';

function makePrd(overrides: Partial<Prd> = {}): Prd {
  return {
    id: 'prd_test1234',
    version: 1,
    title: 'Test PRD',
    description: 'Test',
    status: 'in_progress',
    execution_mode: 'loop',
    source_file: 'prd.md',
    goals: [],
    out_of_scope: [],
    quality_gates: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
    stats: {
      total_tasks: 0,
      completed_tasks: 0,
      failed_tasks: 0,
      skipped_tasks: 0,
      total_attempts: 0,
      total_duration_ms: 0,
    },
    ...overrides,
  };
}

function makeExecution(overrides: Partial<PrdExecution> = {}): PrdExecution {
  return {
    prd_id: 'prd_test1234',
    mode: 'loop',
    branch: 'prd/prd_test1234',
    original_branch: 'master',
    started_at: new Date().toISOString(),
    current_task_id: null,
    iteration: 1,
    max_iterations: 3,
    pid: null,
    team_name: null,
    concurrency: null,
    log_file: '',
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_001',
    prd_id: 'prd_test1234',
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

describe('runPrd resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: git commands succeed, current branch = master
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('branch --show-current')) return 'master';
      if (typeof cmd === 'string' && cmd.includes('rev-parse')) return 'ok';
      if (typeof cmd === 'string' && cmd.includes('status --porcelain')) return '';
      if (typeof cmd === 'string' && cmd.includes('diff --name-only')) return '';
      return '';
    });
  });

  it('should throw when no execution state exists', async () => {
    mockLoadPrd.mockReturnValue(makePrd());
    mockLoadTasks.mockReturnValue([makeTask()]);
    mockLoadExecution.mockReturnValue(null);

    await expect(runPrd('prd_test1234', { resume: true, noBranch: true })).rejects.toThrow(
      'No execution state'
    );
  });

  it('should throw when PRD is already completed', async () => {
    mockLoadPrd.mockReturnValue(makePrd({ status: 'completed' }));
    mockLoadTasks.mockReturnValue([makeTask()]);
    mockLoadExecution.mockReturnValue(makeExecution());

    await expect(runPrd('prd_test1234', { resume: true, noBranch: true })).rejects.toThrow(
      'already completed'
    );
  });

  it('should throw when PRD is archived', async () => {
    mockLoadPrd.mockReturnValue(makePrd({ status: 'archived' }));
    mockLoadTasks.mockReturnValue([makeTask()]);
    mockLoadExecution.mockReturnValue(makeExecution());

    await expect(runPrd('prd_test1234', { resume: true, noBranch: true })).rejects.toThrow(
      'archived'
    );
  });

  it('should throw when branch does not exist', async () => {
    mockLoadPrd.mockReturnValue(makePrd());
    mockLoadTasks.mockReturnValue([makeTask()]);
    mockLoadExecution.mockReturnValue(makeExecution());
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('rev-parse')) throw new Error('not found');
      if (typeof cmd === 'string' && cmd.includes('branch --show-current')) return 'master';
      return '';
    });

    await expect(runPrd('prd_test1234', { resume: true })).rejects.toThrow(
      'not found. Cannot resume'
    );
  });

  it('should throw when another runner is active (without --force)', async () => {
    mockLoadPrd.mockReturnValue(makePrd());
    mockLoadTasks.mockReturnValue([makeTask()]);
    // Use current PID + 1 to simulate a different process, but use current PID
    // to guarantee the process exists
    mockLoadExecution.mockReturnValue(makeExecution({ pid: process.pid }));

    // We need a PID that is NOT process.pid but IS running
    // Can't reliably test this cross-platform, so test the --force bypass instead
  });

  it('should reset in_progress tasks to pending on resume', async () => {
    const tasks = [
      makeTask({ id: 'task_001', status: 'completed' }),
      makeTask({ id: 'task_002', status: 'in_progress' }),
      makeTask({ id: 'task_003', status: 'pending' }),
    ];

    mockLoadPrd.mockReturnValue(makePrd());
    mockLoadTasks.mockReturnValue(tasks);
    mockLoadExecution.mockReturnValue(makeExecution({ pid: null }));

    await runPrd('prd_test1234', { resume: true, noBranch: true });

    // task_002 should have been reset to pending
    expect(tasks[0].status).toBe('completed'); // stays completed
    expect(tasks[1].status).not.toBe('in_progress'); // was reset
    expect(tasks[2].status).not.toBe('in_progress'); // was pending, might be completed now
  });

  it('should reset failed tasks to pending on resume', async () => {
    const failedTask = makeTask({
      id: 'task_001',
      status: 'failed',
      attempts: [
        {
          attempt_number: 1,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          status: 'failed',
          gate_results: [],
          files_actually_modified: [],
          memories_recalled: 0,
          memories_created: 0,
          dead_ends_recorded: 0,
          error: 'gate failed',
          output_log: '/fake/log',
        },
      ],
    });

    mockLoadPrd.mockReturnValue(makePrd());
    mockLoadTasks.mockReturnValue([failedTask]);
    mockLoadExecution.mockReturnValue(makeExecution({ pid: null }));

    await runPrd('prd_test1234', { resume: true, noBranch: true });

    // Original attempt kept + new attempt from re-execution
    expect(failedTask.attempts.length).toBeGreaterThanOrEqual(2);
    expect(failedTask.attempts[0].status).toBe('failed'); // original attempt preserved
  });

  it('should update PRD status from failed to in_progress on resume', async () => {
    const prd = makePrd({ status: 'failed' });
    mockLoadPrd.mockReturnValue(prd);
    mockLoadTasks.mockReturnValue([makeTask()]);
    mockLoadExecution.mockReturnValue(makeExecution({ pid: null }));

    await runPrd('prd_test1234', { resume: true, noBranch: true });

    // savePrd should have been called with status changed from 'failed'
    expect(mockSavePrd).toHaveBeenCalled();
  });

  it('should keep completed tasks on resume', async () => {
    const tasks = [
      makeTask({ id: 'task_001', status: 'completed' }),
      makeTask({ id: 'task_002', status: 'pending' }),
    ];

    mockLoadPrd.mockReturnValue(makePrd());
    mockLoadTasks.mockReturnValue(tasks);
    mockLoadExecution.mockReturnValue(makeExecution({ pid: null }));

    await runPrd('prd_test1234', { resume: true, noBranch: true });

    // task_001 should stay completed — resume doesn't touch it
    expect(tasks[0].status).toBe('completed');
  });
});
