import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Prd, Task, TaskAttempt, PrdExecution, QualityGate } from './types.js';

// Mock fs and state modules before imports
vi.mock('fs');
vi.mock('./state.js');
vi.mock('../config.js', () => ({
  getSuccDir: () => '/mock/.succ',
}));

import fs from 'fs';
import {
  exportPrdToObsidian,
  generateGanttChart,
  generateDependencyGraph,
  formatDuration,
  sanitizeMermaid,
} from './export.js';
import {
  loadPrd,
  loadTasks,
  loadExecution,
  findLatestPrd,
} from './state.js';

// ============================================================================
// Test fixtures
// ============================================================================

function makeGate(type: string = 'test', passed = true): QualityGate {
  return { type: type as any, command: `npm ${type}`, required: true, timeout_ms: 120000 };
}

function makeAttempt(num: number, opts: Partial<TaskAttempt> = {}): TaskAttempt {
  return {
    attempt_number: num,
    started_at: '2026-02-08T13:00:00.000Z',
    completed_at: '2026-02-08T13:01:00.000Z',
    status: 'passed',
    gate_results: [],
    files_actually_modified: [],
    memories_recalled: 0,
    memories_created: 0,
    dead_ends_recorded: 0,
    error: null,
    output_log: '/mock/log.log',
    ...opts,
  };
}

function makeTask(id: string, seq: number, opts: Partial<Task> = {}): Task {
  return {
    id,
    prd_id: 'prd_test123',
    sequence: seq,
    title: `Task ${seq} title`,
    description: `Description for task ${seq}`,
    status: 'completed',
    priority: 'medium',
    depends_on: [],
    acceptance_criteria: ['Criterion 1', 'Criterion 2'],
    files_to_modify: ['src/file.ts'],
    relevant_files: [],
    context_queries: [],
    attempts: [makeAttempt(1)],
    max_attempts: 3,
    created_at: '2026-02-08T13:00:00.000Z',
    updated_at: '2026-02-08T13:01:00.000Z',
    ...opts,
  };
}

function makePrd(opts: Partial<Prd> = {}): Prd {
  return {
    id: 'prd_test123',
    version: 1,
    title: 'Test PRD',
    description: 'A test PRD for export',
    status: 'completed',
    execution_mode: 'loop',
    source_file: 'prd.md',
    goals: ['Goal 1', 'Goal 2'],
    out_of_scope: ['Not this'],
    quality_gates: [makeGate('typecheck'), makeGate('test')],
    created_at: '2026-02-08T13:00:00.000Z',
    updated_at: '2026-02-08T13:05:00.000Z',
    started_at: '2026-02-08T13:00:00.000Z',
    completed_at: '2026-02-08T13:05:00.000Z',
    stats: {
      total_tasks: 3,
      completed_tasks: 3,
      failed_tasks: 0,
      skipped_tasks: 0,
      total_attempts: 3,
      total_duration_ms: 180000,
    },
    ...opts,
  };
}

function makeExecution(mode: 'loop' | 'team' = 'loop'): PrdExecution {
  return {
    prd_id: 'prd_test123',
    mode,
    branch: 'prd/prd_test123',
    original_branch: 'main',
    started_at: '2026-02-08T13:00:00.000Z',
    current_task_id: null,
    iteration: 1,
    max_iterations: 3,
    pid: 1234,
    team_name: mode === 'team' ? 'test-team' : null,
    concurrency: mode === 'team' ? 3 : null,
    log_file: '/mock/exec.log',
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('PRD Export', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // sanitizeMermaid
  // --------------------------------------------------------------------------

  describe('sanitizeMermaid', () => {
    it('should strip double quotes', () => {
      expect(sanitizeMermaid('hello "world"')).toBe("hello 'world'");
    });

    it('should strip angle brackets', () => {
      expect(sanitizeMermaid('a<b>c')).toBe('abc');
    });

    it('should replace hash, semicolon, colon with space', () => {
      expect(sanitizeMermaid('type#1; check: done')).toBe('type 1 check done');
    });

    it('should collapse multiple spaces', () => {
      expect(sanitizeMermaid('a  b   c')).toBe('a b c');
    });
  });

  // --------------------------------------------------------------------------
  // formatDuration
  // --------------------------------------------------------------------------

  describe('formatDuration', () => {
    it('should format milliseconds', () => {
      expect(formatDuration(500)).toBe('500ms');
    });

    it('should format seconds', () => {
      expect(formatDuration(45000)).toBe('45s');
    });

    it('should format minutes and seconds', () => {
      expect(formatDuration(125000)).toBe('2m 05s');
    });

    it('should format hours and minutes', () => {
      expect(formatDuration(3661000)).toBe('1h 1m');
    });
  });

  // --------------------------------------------------------------------------
  // Gantt chart (loop mode)
  // --------------------------------------------------------------------------

  describe('generateGanttChart - loop mode', () => {
    it('should generate valid Mermaid gantt for sequential tasks', () => {
      const prd = makePrd();
      const tasks = [
        makeTask('task_001', 1, {
          attempts: [makeAttempt(1, {
            started_at: '2026-02-08T13:00:00.000Z',
            completed_at: '2026-02-08T13:01:00.000Z',
          })],
        }),
        makeTask('task_002', 2, {
          depends_on: ['task_001'],
          attempts: [makeAttempt(1, {
            started_at: '2026-02-08T13:01:30.000Z',
            completed_at: '2026-02-08T13:02:30.000Z',
          })],
        }),
        makeTask('task_003', 3, {
          depends_on: ['task_002'],
          attempts: [makeAttempt(1, {
            started_at: '2026-02-08T13:03:00.000Z',
            completed_at: '2026-02-08T13:05:00.000Z',
          })],
        }),
      ];

      const gantt = generateGanttChart(prd, tasks, makeExecution('loop'));

      expect(gantt).toContain('gantt');
      expect(gantt).toContain('title PRD');
      expect(gantt).toContain('section Tasks');
      expect(gantt).toContain(':done,');
      expect(gantt).toContain('t001');
      expect(gantt).toContain('t002');
      expect(gantt).toContain('t003');
    });

    it('should show failed tasks as crit', () => {
      const prd = makePrd();
      const tasks = [
        makeTask('task_001', 1, {
          status: 'failed',
          attempts: [makeAttempt(1, {
            status: 'failed',
            started_at: '2026-02-08T13:00:00.000Z',
            completed_at: '2026-02-08T13:01:00.000Z',
          })],
        }),
      ];

      const gantt = generateGanttChart(prd, tasks, null);
      expect(gantt).toContain(':crit,');
    });

    it('should handle tasks with no attempts', () => {
      const prd = makePrd();
      const tasks = [
        makeTask('task_001', 1, { attempts: [] }),
      ];

      const gantt = generateGanttChart(prd, tasks, null);
      expect(gantt).toContain('gantt');
      // No task entries since no attempts
      expect(gantt).not.toContain('t001');
    });
  });

  // --------------------------------------------------------------------------
  // Gantt chart (team mode)
  // --------------------------------------------------------------------------

  describe('generateGanttChart - team mode', () => {
    it('should generate worker sections for parallel tasks', () => {
      const prd = makePrd({ execution_mode: 'team' });
      const tasks = [
        makeTask('task_001', 1, {
          attempts: [makeAttempt(1, {
            started_at: '2026-02-08T13:00:00.000Z',
            completed_at: '2026-02-08T13:05:00.000Z',
          })],
        }),
        makeTask('task_002', 2, {
          attempts: [makeAttempt(1, {
            started_at: '2026-02-08T13:00:30.000Z',
            completed_at: '2026-02-08T13:04:00.000Z',
          })],
        }),
        makeTask('task_003', 3, {
          attempts: [makeAttempt(1, {
            started_at: '2026-02-08T13:01:00.000Z',
            completed_at: '2026-02-08T13:03:00.000Z',
          })],
        }),
      ];

      const gantt = generateGanttChart(prd, tasks, makeExecution('team'));

      expect(gantt).toContain('Worker 1');
      expect(gantt).toContain('Worker 2');
      expect(gantt).toContain('Worker 3');
      expect(gantt).not.toContain('section Tasks');
    });
  });

  // --------------------------------------------------------------------------
  // Gantt with retries
  // --------------------------------------------------------------------------

  describe('generateGanttChart - retries', () => {
    it('should show each attempt for tasks with multiple attempts', () => {
      const prd = makePrd();
      const tasks = [
        makeTask('task_001', 1, {
          status: 'completed',
          attempts: [
            makeAttempt(1, {
              status: 'failed',
              started_at: '2026-02-08T13:00:00.000Z',
              completed_at: '2026-02-08T13:01:00.000Z',
            }),
            makeAttempt(2, {
              status: 'passed',
              started_at: '2026-02-08T13:01:30.000Z',
              completed_at: '2026-02-08T13:02:30.000Z',
            }),
          ],
        }),
      ];

      const gantt = generateGanttChart(prd, tasks, null);
      expect(gantt).toContain('(1)');
      expect(gantt).toContain('(2)');
      expect(gantt).toContain(':crit,');
      expect(gantt).toContain(':done,');
    });
  });

  // --------------------------------------------------------------------------
  // Dependency graph
  // --------------------------------------------------------------------------

  describe('generateDependencyGraph', () => {
    it('should generate flowchart with nodes and edges', () => {
      const tasks = [
        makeTask('task_001', 1),
        makeTask('task_002', 2, { depends_on: ['task_001'] }),
        makeTask('task_003', 3, { depends_on: ['task_002'] }),
      ];

      const graph = generateDependencyGraph(tasks);

      expect(graph).toContain('flowchart TD');
      expect(graph).toContain('task_001');
      expect(graph).toContain('task_002');
      expect(graph).toContain('task_003');
      expect(graph).toContain('task_001 --> task_002');
      expect(graph).toContain('task_002 --> task_003');
      expect(graph).toContain('classDef done');
      expect(graph).toContain('class task_001,task_002,task_003 done');
    });

    it('should color-code failed and skipped tasks', () => {
      const tasks = [
        makeTask('task_001', 1, { status: 'completed' }),
        makeTask('task_002', 2, { status: 'failed' }),
        makeTask('task_003', 3, { status: 'skipped' }),
      ];

      const graph = generateDependencyGraph(tasks);

      expect(graph).toContain('class task_001 done');
      expect(graph).toContain('class task_002 failed');
      expect(graph).toContain('class task_003 skipped');
    });

    it('should include status emoji and duration in node labels', () => {
      const tasks = [
        makeTask('task_001', 1, {
          title: 'Setup types',
          attempts: [makeAttempt(1, {
            started_at: '2026-02-08T13:00:00.000Z',
            completed_at: '2026-02-08T13:01:05.000Z',
          })],
        }),
      ];

      const graph = generateDependencyGraph(tasks);
      expect(graph).toContain('✅');
      expect(graph).toContain('1m 05s');
    });

    it('should handle tasks with no dependencies', () => {
      const tasks = [
        makeTask('task_001', 1),
        makeTask('task_002', 2),
      ];

      const graph = generateDependencyGraph(tasks);
      expect(graph).not.toContain('-->');
    });
  });

  // --------------------------------------------------------------------------
  // Full export
  // --------------------------------------------------------------------------

  describe('exportPrdToObsidian', () => {
    it('should create expected file structure', () => {
      const prd = makePrd();
      const tasks = [
        makeTask('task_001', 1, {
          attempts: [makeAttempt(1, {
            started_at: '2026-02-08T13:00:00.000Z',
            completed_at: '2026-02-08T13:01:00.000Z',
          })],
        }),
        makeTask('task_002', 2, {
          depends_on: ['task_001'],
          attempts: [makeAttempt(1, {
            started_at: '2026-02-08T13:01:30.000Z',
            completed_at: '2026-02-08T13:02:30.000Z',
          })],
        }),
      ];

      vi.mocked(loadPrd).mockReturnValue(prd);
      vi.mocked(loadTasks).mockReturnValue(tasks);
      vi.mocked(loadExecution).mockReturnValue(makeExecution('loop'));

      const result = exportPrdToObsidian('prd_test123');

      expect(result.prdId).toBe('prd_test123');
      expect(result.filesCreated).toBe(5); // Overview + Dependencies + Timeline + 2 tasks

      // Check mkdirSync was called for Tasks subdirectory
      expect(fs.mkdirSync).toHaveBeenCalled();

      // Check all files were written
      const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
      const filenames = writeCalls.map(c => String(c[0]));

      expect(filenames.some(f => f.includes('Overview.md'))).toBe(true);
      expect(filenames.some(f => f.includes('Dependencies.md'))).toBe(true);
      expect(filenames.some(f => f.includes('Timeline.md'))).toBe(true);
      expect(filenames.some(f => f.includes('task_001.md'))).toBe(true);
      expect(filenames.some(f => f.includes('task_002.md'))).toBe(true);
    });

    it('should use latest PRD when no ID provided', () => {
      vi.mocked(findLatestPrd).mockReturnValue({
        id: 'prd_latest',
        title: 'Latest',
        status: 'completed',
        execution_mode: 'loop',
        created_at: '2026-02-08T13:00:00.000Z',
        updated_at: '2026-02-08T13:05:00.000Z',
      });
      vi.mocked(loadPrd).mockReturnValue(makePrd({ id: 'prd_latest' }));
      vi.mocked(loadTasks).mockReturnValue([]);
      vi.mocked(loadExecution).mockReturnValue(null);

      const result = exportPrdToObsidian();
      expect(result.prdId).toBe('prd_latest');
    });

    it('should throw when PRD not found', () => {
      vi.mocked(loadPrd).mockReturnValue(null);

      expect(() => exportPrdToObsidian('prd_nonexistent')).toThrow('PRD not found');
    });

    it('should throw when no PRDs exist and no ID given', () => {
      vi.mocked(findLatestPrd).mockReturnValue(null);

      expect(() => exportPrdToObsidian()).toThrow('No PRDs found');
    });

    it('should skip Timeline for draft PRDs with no timestamps', () => {
      const prd = makePrd({ status: 'draft' });
      const tasks = [
        makeTask('task_001', 1, { status: 'pending', attempts: [] }),
      ];

      vi.mocked(loadPrd).mockReturnValue(prd);
      vi.mocked(loadTasks).mockReturnValue(tasks);
      vi.mocked(loadExecution).mockReturnValue(null);

      const result = exportPrdToObsidian('prd_test123');
      // Overview + Dependencies + 1 task = 3 (no Timeline)
      expect(result.filesCreated).toBe(3);

      const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
      const filenames = writeCalls.map(c => String(c[0]));
      expect(filenames.some(f => f.includes('Timeline.md'))).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Overview content
  // --------------------------------------------------------------------------

  describe('Overview content', () => {
    it('should include frontmatter, stats, quality gates, and goals', () => {
      const prd = makePrd();
      const tasks = [makeTask('task_001', 1)];

      vi.mocked(loadPrd).mockReturnValue(prd);
      vi.mocked(loadTasks).mockReturnValue(tasks);
      vi.mocked(loadExecution).mockReturnValue(null);

      exportPrdToObsidian('prd_test123');

      const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
      const overviewCall = writeCalls.find(c => String(c[0]).includes('Overview.md'));
      expect(overviewCall).toBeDefined();

      const content = String(overviewCall![1]);
      expect(content).toContain('prd_id: prd_test123');
      expect(content).toContain('status: completed');
      expect(content).toContain('## Stats');
      expect(content).toContain('## Quality Gates');
      expect(content).toContain('typecheck');
      expect(content).toContain('## Goals');
      expect(content).toContain('Goal 1');
      expect(content).toContain('## Dependency Graph');
      expect(content).toContain('```mermaid');
    });
  });

  // --------------------------------------------------------------------------
  // Task page content
  // --------------------------------------------------------------------------

  describe('Task page content', () => {
    it('should include frontmatter, criteria, attempts, and gates', () => {
      const prd = makePrd();
      const task = makeTask('task_001', 1, {
        attempts: [makeAttempt(1, {
          gate_results: [
            { gate: makeGate('typecheck'), passed: true, output: '', duration_ms: 3000 },
            { gate: makeGate('test'), passed: true, output: '', duration_ms: 5000 },
          ],
          files_actually_modified: ['src/file.ts', 'src/other.ts'],
        })],
      });

      vi.mocked(loadPrd).mockReturnValue(prd);
      vi.mocked(loadTasks).mockReturnValue([task]);
      vi.mocked(loadExecution).mockReturnValue(null);

      exportPrdToObsidian('prd_test123');

      const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
      const taskCall = writeCalls.find(c => String(c[0]).includes('task_001.md'));
      expect(taskCall).toBeDefined();

      const content = String(taskCall![1]);
      expect(content).toContain('task_id: task_001');
      expect(content).toContain('status: completed');
      expect(content).toContain('## Acceptance Criteria');
      expect(content).toContain('Criterion 1');
      expect(content).toContain('## Attempts');
      expect(content).toContain('### Gate Results');
      expect(content).toContain('✅typecheck');
      expect(content).toContain('**Actually modified:**');
      expect(content).toContain('src/other.ts');
    });

    it('should show error for failed tasks', () => {
      const prd = makePrd();
      const task = makeTask('task_001', 1, {
        status: 'failed',
        attempts: [makeAttempt(1, {
          status: 'failed',
          error: 'TypeScript compilation failed',
        })],
      });

      vi.mocked(loadPrd).mockReturnValue(prd);
      vi.mocked(loadTasks).mockReturnValue([task]);
      vi.mocked(loadExecution).mockReturnValue(null);

      exportPrdToObsidian('prd_test123');

      const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
      const taskCall = writeCalls.find(c => String(c[0]).includes('task_001.md'));
      const content = String(taskCall![1]);
      expect(content).toContain('## Error');
      expect(content).toContain('TypeScript compilation failed');
    });
  });
});
