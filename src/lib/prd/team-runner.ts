/**
 * Team Runner — Parallel Task Execution
 *
 * Orchestrates concurrent Claude processes, each in an isolated git worktree.
 * - Parallel dispatch with configurable concurrency limit
 * - File conflict prevention via files_to_modify overlap check
 * - Serial merge back to PRD branch after each task completes
 * - Quality gates per task (run in the worktree)
 * - Deadlock detection and critical task abort
 */

import { LoopExecutor, WSExecutor } from './executor.js';
import type { ExecuteOptions, ExecuteResult } from './executor.js';
import { getClaudeMode } from '../llm.js';
import { allDependenciesMet } from './scheduler.js';
import { runAllGates, allRequiredPassed, formatGateResults } from './gates.js';
import { gatherTaskContext } from './context.js';
import { buildTaskPrompt } from './prompt-builder.js';
import { WORKER_ALLOWED_TOOLS, buildMcpConfig } from './runner.js';
import {
  saveTasks,
  savePrd,
  saveExecution,
  appendProgress,
  appendTaskLog,
  getTaskLogPath,
} from './state.js';
import { computeStats } from './types.js';
import type { Prd, Task, TaskAttempt, PrdExecution } from './types.js';
import {
  createWorktree,
  mergeWorktreeChanges,
  removeWorktree,
  cleanupAllWorktrees,
} from './worktree.js';

// ============================================================================
// Types
// ============================================================================

export interface TeamRunOptions {
  concurrency: number;
  model: string;
  prdId: string;
  root: string;
  prd: Prd;
  execution: PrdExecution;
}

export interface RunningTask {
  task: Task;
  executor: LoopExecutor | WSExecutor;
  promise: Promise<WorkerResult>;
  worktreePath: string;
}

interface WorkerResult {
  task: Task;
  result: ExecuteResult;
  worktreePath: string;
}

// ============================================================================
// Ready task selection
// ============================================================================

/**
 * Get tasks that can be dispatched right now.
 *
 * A task is ready when:
 * 1. status is 'pending'
 * 2. all dependencies are met (completed/skipped)
 * 3. no files_to_modify overlap with currently running tasks
 * 4. hasn't exhausted max_attempts
 */
export function getReadyTasks(tasks: Task[], runningTasks: RunningTask[]): Task[] {
  // Collect all files being modified by running tasks
  const runningFiles = new Set<string>();
  for (const rt of runningTasks) {
    for (const f of rt.task.files_to_modify) {
      runningFiles.add(f);
    }
  }

  return tasks.filter((task) => {
    if (task.status !== 'pending') return false;
    if (!allDependenciesMet(task, tasks)) return false;
    if (task.attempts.length >= task.max_attempts) return false;

    // File conflict check
    if (runningFiles.size > 0 && task.files_to_modify.length > 0) {
      const hasConflict = task.files_to_modify.some((f) => runningFiles.has(f));
      if (hasConflict) return false;
    }

    return true;
  });
}

// ============================================================================
// Main parallel dispatch loop
// ============================================================================

/**
 * Run tasks in parallel with worktree isolation.
 */
export async function runTeam(tasks: Task[], options: TeamRunOptions): Promise<void> {
  const { concurrency, model, prdId, root, prd, execution } = options;
  const running: RunningTask[] = [];

  execution.concurrency = concurrency;
  saveExecution(execution);
  appendProgress(prdId, `Team mode — concurrency: ${concurrency}`);
  console.log(`\n[team] Parallel execution — max ${concurrency} workers\n`);

  try {
    while (true) {
      // Check if all done
      const allDone = tasks.every(
        (t) => t.status === 'completed' || t.status === 'skipped' || t.status === 'failed'
      );
      if (allDone) break;

      // Find and dispatch ready tasks
      const ready = getReadyTasks(tasks, running);
      const slotsAvailable = concurrency - running.length;
      const toDispatch = ready.slice(0, slotsAvailable);

      for (const task of toDispatch) {
        const rt = dispatchTask(task, prd, execution, model, root, prdId);
        running.push(rt);
      }

      // Deadlock: nothing running, nothing ready, but tasks remain
      if (running.length === 0 && toDispatch.length === 0) {
        const pending = tasks.filter((t) => t.status === 'pending');
        if (pending.length === 0) break;

        // Skip tasks with failed dependencies
        let skipped = false;
        for (const t of pending) {
          const hasFailedDep = t.depends_on.some((depId) => {
            const dep = tasks.find((d) => d.id === depId);
            return dep && dep.status === 'failed';
          });
          if (hasFailedDep) {
            t.status = 'skipped';
            t.updated_at = new Date().toISOString();
            appendProgress(prdId, `Skipped ${t.id} "${t.title}" — dependency failed`);
            console.log(`  [-] Skipping ${t.id}: dependency failed`);
            skipped = true;
          }
        }

        if (skipped) continue; // Re-evaluate after skipping

        // True deadlock: pending tasks exist but none can start
        appendProgress(prdId, `DEADLOCK: ${pending.length} tasks cannot proceed`);
        console.log(`\n[!] Deadlock: ${pending.length} tasks stuck`);
        break;
      }

      // Wait for any worker to complete
      if (running.length > 0) {
        const { completed, index } = await raceWorkers(running);
        running.splice(index, 1);

        // Handle completion (serial: one at a time)
        await handleTaskCompletion(completed, tasks, prd, execution, root, prdId);

        // Save state after each completion
        saveTasks(prdId, tasks);
        prd.stats = computeStats(tasks);
        savePrd(prd);

        // Critical task failure: abort all running workers
        if (completed.task.status === 'failed' && completed.task.priority === 'critical') {
          appendProgress(prdId, `PAUSED — critical task ${completed.task.id} failed`);
          console.log(`\n[!] Critical task ${completed.task.id} failed. Aborting.`);

          for (const rt of running) {
            rt.executor.abort();
            removeWorktree(rt.task.id, root);
            rt.task.status = 'pending';
            rt.task.updated_at = new Date().toISOString();
          }
          running.length = 0;
          break;
        }
      }
    }
  } finally {
    // Clean up any remaining worktrees
    for (const rt of running) {
      rt.executor.abort();
      removeWorktree(rt.task.id, root);
    }
    cleanupAllWorktrees(root);
  }
}

// ============================================================================
// Dispatch a single task to a worker
// ============================================================================

function dispatchTask(
  task: Task,
  prd: Prd,
  execution: PrdExecution,
  model: string,
  root: string,
  prdId: string
): RunningTask {
  console.log(`  [>] Dispatching ${task.id}: ${task.title}`);
  task.status = 'in_progress';
  task.updated_at = new Date().toISOString();
  appendProgress(prdId, `Dispatched ${task.id} "${task.title}"`);

  // Create isolated worktree
  const wt = createWorktree(task.id, execution.branch, root);

  // Create attempt record
  const taskAttempt: TaskAttempt = {
    attempt_number: task.attempts.length + 1,
    started_at: new Date().toISOString(),
    completed_at: null,
    status: 'running',
    gate_results: [],
    files_actually_modified: [],
    memories_recalled: 0,
    memories_created: 0,
    dead_ends_recorded: 0,
    error: null,
    output_log: getTaskLogPath(prdId, task.id),
  };
  task.attempts.push(taskAttempt);

  // Spawn executor — context gathering happens synchronously before spawn
  const executor = getClaudeMode() === 'ws' ? new WSExecutor() : new LoopExecutor();

  // Build a promise that gathers context, builds prompt, then executes
  const promise = (async (): Promise<WorkerResult> => {
    const context = await gatherTaskContext(task, prdId);
    const { system, user } = buildTaskPrompt(task, prd, context);
    const prompt = `${system}\n\n${user}`;

    const executeOptions: ExecuteOptions = {
      cwd: wt.path, // worker runs in its own worktree
      timeout_ms: 900_000, // 15 minutes
      model,
      permissionMode: 'acceptEdits',
      allowedTools: WORKER_ALLOWED_TOOLS,
      mcpConfig: buildMcpConfig(),
      onOutput: (chunk) => appendTaskLog(prdId, task.id, chunk),
    };

    const result = await executor.execute(prompt, executeOptions);
    return { task, result, worktreePath: wt.path };
  })();

  return { task, executor, promise, worktreePath: wt.path };
}

// ============================================================================
// Handle task completion
// ============================================================================

async function handleTaskCompletion(
  completed: WorkerResult,
  allTasks: Task[],
  prd: Prd,
  _execution: PrdExecution,
  root: string,
  prdId: string
): Promise<void> {
  const { task, result, worktreePath } = completed;
  const attempt = task.attempts[task.attempts.length - 1];
  attempt.completed_at = new Date().toISOString();

  // Check BLOCKED response
  if (result.output.includes('BLOCKED:')) {
    attempt.status = 'failed';
    attempt.error = result.output.match(/BLOCKED:(.*)/)?.[1]?.trim() ?? 'Agent reported blocked';
    console.log(`  [x] ${task.id} BLOCKED: ${attempt.error}`);
    appendProgress(prdId, `${task.id} BLOCKED: ${attempt.error}`);
    task.status = 'failed';
    removeWorktree(task.id, root);
    return;
  }

  if (!result.success) {
    attempt.status = 'failed';
    attempt.error = `Exit code: ${result.exit_code}`;
    console.log(`  [x] ${task.id} failed (exit ${result.exit_code})`);
    appendProgress(prdId, `${task.id} failed (exit ${result.exit_code})`);
    task.status = task.attempts.length >= task.max_attempts ? 'failed' : 'pending';
    removeWorktree(task.id, root);
    return;
  }

  // Run quality gates in the worktree
  if (prd.quality_gates.length > 0) {
    console.log(`  [~] ${task.id}: running quality gates...`);
    const gateResults = runAllGates(prd.quality_gates, worktreePath);
    attempt.gate_results = gateResults;

    if (!allRequiredPassed(gateResults)) {
      attempt.status = 'failed';
      const failedGates = gateResults.filter((r) => !r.passed && r.gate.required);
      attempt.error = `Gates failed: ${failedGates.map((r) => r.gate.type).join(', ')}`;
      console.log(`  [x] ${task.id} gates failed:\n${formatGateResults(gateResults)}`);
      appendProgress(prdId, `${task.id} gates failed: ${attempt.error}`);
      task.status = task.attempts.length >= task.max_attempts ? 'failed' : 'pending';
      removeWorktree(task.id, root);
      return;
    }
    console.log(`  [+] ${task.id}: all gates passed`);
  }

  // Merge worktree changes back to PRD branch
  const commitMsg = `prd(${prdId}): ${task.id} — ${task.title}`;
  const merge = mergeWorktreeChanges(worktreePath, root, commitMsg);

  if (merge.success) {
    attempt.status = 'passed';
    task.status = 'completed';
    task.updated_at = new Date().toISOString();
    console.log(`  [+] ${task.id} completed and merged`);
    appendProgress(prdId, `Completed ${task.id} "${task.title}"`);
  } else {
    // Merge conflict — task needs retry
    attempt.status = 'failed';
    attempt.error = `Merge conflict: ${merge.conflictFiles?.join(', ') ?? 'unknown'}`;
    console.log(`  [x] ${task.id} merge conflict: ${attempt.error}`);
    appendProgress(prdId, `${task.id} merge conflict: ${attempt.error}`);
    task.status = task.attempts.length >= task.max_attempts ? 'failed' : 'pending';
  }

  removeWorktree(task.id, root);
}

// ============================================================================
// Promise.race with index tracking
// ============================================================================

async function raceWorkers(
  running: RunningTask[]
): Promise<{ completed: WorkerResult; index: number }> {
  const indexed = running.map((rt, i) =>
    rt.promise.then((result) => ({ completed: result, index: i }))
  );
  return Promise.race(indexed);
}
