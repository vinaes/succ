/**
 * PRD Runner — Orchestration Loop
 *
 * Manages the full execution lifecycle:
 * 1. Branch setup (git checkout -b prd/{id})
 * 2. Iterate tasks in topological order
 * 3. For each task: gather context -> build prompt -> execute -> run gates -> commit
 * 4. Branch teardown (return to original branch)
 *
 * NOTE: execSync is used for git commands with internally-generated arguments
 * (prd IDs are hex-only from crypto.randomBytes, branch names are controlled).
 */

import { execSync } from 'child_process';
import { getProjectRoot } from '../config.js';
import { LoopExecutor } from './executor.js';
import type { ExecuteOptions } from './executor.js';
import { topologicalSort, allDependenciesMet, validateTaskGraph } from './scheduler.js';
import { runAllGates, allRequiredPassed, formatGateResults } from './gates.js';
import { gatherTaskContext } from './context.js';
import { buildTaskPrompt, appendFailureContext } from './prompt-builder.js';
import {
  loadPrd,
  savePrd,
  loadTasks,
  saveTasks,
  saveExecution,
  loadExecution,
  appendProgress,
  appendTaskLog,
  getTaskLogPath,
} from './state.js';
import { createExecution, computeStats } from './types.js';
import type { Prd, Task, TaskAttempt, PrdExecution } from './types.js';

// ============================================================================
// Run Options
// ============================================================================

export interface RunOptions {
  mode?: 'loop' | 'team';
  concurrency?: number;  // Max parallel workers in team mode (default: 3)
  resume?: boolean;
  taskId?: string;       // Run a specific task only
  dryRun?: boolean;
  maxIterations?: number;
  noBranch?: boolean;    // Skip branch isolation
  model?: string;
  force?: boolean;       // Force resume even if another runner may be active
}

export interface RunResult {
  prd: Prd;
  success: boolean;
  tasksCompleted: number;
  tasksFailed: number;
  branch?: string;
}

// ============================================================================
// Git helpers
// ============================================================================

function git(cmd: string, cwd: string): string {
  try {
    return execSync(`git ${cmd}`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    throw new Error(`git ${cmd} failed: ${err.stderr || err.message}`);
  }
}

function getCurrentBranch(cwd: string): string {
  return git('branch --show-current', cwd);
}

function hasUncommittedChanges(cwd: string): boolean {
  const status = git('status --porcelain', cwd);
  return status.length > 0;
}

function getModifiedFiles(cwd: string): string[] {
  try {
    const output = git('diff --name-only HEAD~1', cwd);
    return output ? output.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Check if a process with the given PID is still running.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = check existence, doesn't kill
    return true;
  } catch {
    return false;
  }
}

/**
 * Reset working tree to HEAD — discard all changes from failed attempt.
 * Uses `git clean -fd -e .succ` to preserve PRD state files.
 */
function resetWorkingTree(cwd: string): void {
  try {
    git('checkout -- .', cwd);
    git('clean -fd -e .succ', cwd);
  } catch {
    // best-effort
  }
}

// ============================================================================
// MCP config for worker agents
// ============================================================================

/**
 * Built-in tools + succ MCP tools that workers can use.
 * Workers can recall memories, record learnings, and flag dead-ends.
 */
export const WORKER_ALLOWED_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'mcp__succ__succ_recall',
  'mcp__succ__succ_remember',
  'mcp__succ__succ_dead_end',
  'mcp__succ__succ_search',
  'mcp__succ__succ_search_code',
];

/**
 * Build MCP server config for spawned claude processes.
 * Since user-scope MCP servers aren't inherited by spawned processes,
 * we pass the succ MCP server config explicitly via --mcp-config.
 */
export function buildMcpConfig(): Record<string, { command: string; args?: string[] }> {
  return {
    succ: { command: 'succ-mcp', args: [] },
  };
}

// ============================================================================
// Main Runner
// ============================================================================

/**
 * Run a PRD — execute its tasks in order with quality gates.
 */
export async function runPrd(
  prdId: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const root = getProjectRoot();

  // 1. Load PRD and tasks
  const prd = loadPrd(prdId);
  if (!prd) throw new Error(`PRD not found: ${prdId}`);

  const tasks = loadTasks(prdId);
  if (tasks.length === 0) throw new Error(`No tasks for PRD ${prdId}. Run: succ prd parse ${prdId}`);

  // 2. Validate task graph
  const validation = validateTaskGraph(tasks);
  if (!validation.valid) {
    throw new Error(`Invalid task graph:\n${validation.errors.join('\n')}`);
  }
  if (validation.warnings.length > 0) {
    console.log('Warnings:');
    for (const w of validation.warnings) {
      console.log(`  - ${w}`);
    }
  }

  // 3. Dry run — just show the plan
  if (options.dryRun) {
    return showDryRun(prd, tasks, validation, options.mode ?? 'loop', options.concurrency ?? 3);
  }

  // 4. Branch setup
  let execution: PrdExecution;
  let stashed = false;

  if (options.resume) {
    // Resume existing execution
    const existing = loadExecution(prdId);
    if (!existing) throw new Error(`No execution state for ${prdId}. Start fresh without --resume`);

    // Validate PRD status
    if (prd.status === 'completed') throw new Error(`PRD ${prdId} already completed. Nothing to resume.`);
    if (prd.status === 'archived') throw new Error(`PRD ${prdId} is archived. Unarchive first.`);

    // Check branch exists
    if (!options.noBranch) {
      try {
        git(`rev-parse --verify ${existing.branch}`, root);
      } catch {
        throw new Error(`Branch ${existing.branch} not found. Cannot resume.`);
      }
    }

    // Stale process detection
    if (existing.pid && existing.pid !== process.pid && isProcessRunning(existing.pid)) {
      if (!options.force) {
        throw new Error(
          `Another runner (PID ${existing.pid}) may still be running.\n` +
          `Use --force to override, or kill the process first.`
        );
      }
    }

    execution = existing;
    execution.pid = process.pid;
    console.log(`Resuming PRD ${prdId} on branch ${execution.branch}`);

    // Checkout branch if needed
    const currentBranch = getCurrentBranch(root);
    if (currentBranch !== execution.branch) {
      if (!options.noBranch) {
        git(`checkout ${execution.branch}`, root);
      }
    }

    // Reset working tree to clean state
    resetWorkingTree(root);

    // Reset stuck tasks: in_progress → pending, failed → pending
    for (const task of tasks) {
      if (task.status === 'in_progress') {
        task.status = 'pending';
        appendProgress(prdId, `Reset ${task.id} from in_progress to pending`);
      }
      if (task.status === 'failed') {
        task.status = 'pending';
        appendProgress(prdId, `Reset ${task.id} from failed to pending (retry on resume)`);
      }
    }
    saveTasks(prdId, tasks);

    // Team mode: clean up stale worktrees from crashed run
    if (existing.mode === 'team') {
      const { cleanupAllWorktrees } = await import('./worktree.js');
      cleanupAllWorktrees(root);
    }

    // Update PRD status if it was 'failed'
    if (prd.status === 'failed') {
      prd.status = 'in_progress';
      savePrd(prd);
    }

    saveExecution(execution);
    appendProgress(prdId, `Resumed execution (PID ${process.pid})`);
  } else {
    const originalBranch = getCurrentBranch(root);
    const branch = `prd/${prdId}`;

    if (!options.noBranch) {
      // Stash uncommitted changes
      if (hasUncommittedChanges(root)) {
        console.log('Stashing uncommitted changes...');
        git(`stash push -m "prd: auto-stash before ${prdId}"`, root);
        stashed = true;
      }

      // Create and checkout prd branch
      console.log(`Creating branch: ${branch}`);
      git(`checkout -b ${branch}`, root);
    }

    execution = createExecution({
      prd_id: prdId,
      mode: options.mode ?? 'loop',
      branch,
      original_branch: originalBranch,
      max_iterations: options.maxIterations ?? 3,
    });
    execution.pid = process.pid;
    saveExecution(execution);

    // Update PRD status
    prd.status = 'in_progress';
    prd.started_at = new Date().toISOString();
    savePrd(prd);
    appendProgress(prdId, `Execution started — branch: ${branch}, mode: ${options.mode ?? 'loop'}`);
  }

  // 5. Execute tasks
  const model = options.model ?? 'sonnet';

  try {
    if ((options.mode ?? 'loop') === 'team') {
      // Parallel execution via team runner
      const { runTeam } = await import('./team-runner.js');
      await runTeam(tasks, {
        concurrency: options.concurrency ?? 3,
        model,
        prdId,
        root,
        prd,
        execution,
      });
    } else {
    // Sequential execution (loop mode)
    const executor = new LoopExecutor();
    for (let iteration = 1; iteration <= execution.max_iterations; iteration++) {
      execution.iteration = iteration;
      saveExecution(execution);

      const allComplete = tasks.every(t => t.status === 'completed' || t.status === 'skipped');
      if (allComplete) break;

      if (iteration > 1) {
        appendProgress(prdId, `--- Iteration ${iteration} ---`);
        console.log(`\n--- Iteration ${iteration} ---`);
      }

      // Get execution order
      const sorted = topologicalSort(tasks);

      for (const task of sorted) {
        if (task.status === 'completed' || task.status === 'skipped') continue;
        if (!allDependenciesMet(task, tasks)) {
          // Check if dependencies are failed — skip this task
          const hasFailedDep = task.depends_on.some(depId => {
            const dep = tasks.find(t => t.id === depId);
            return dep && dep.status === 'failed';
          });
          if (hasFailedDep) {
            task.status = 'skipped';
            task.updated_at = new Date().toISOString();
            appendProgress(prdId, `Skipped ${task.id} "${task.title}" — dependency failed`);
            console.log(`[-] Skipping ${task.id}: dependency failed`);
            continue;
          }
          continue;
        }

        // Optional: run only specific task
        if (options.taskId && task.id !== options.taskId) continue;

        await executeTask(task, prd, tasks, execution, executor, model, root, prdId);

        // Save state after each task
        saveTasks(prdId, tasks);
        prd.stats = computeStats(tasks);
        savePrd(prd);

        // Escalation: critical task failed -> pause
        if (task.status === 'failed' && task.priority === 'critical') {
          appendProgress(prdId, `PAUSED — critical task ${task.id} failed`);
          console.log(`\n[!] Critical task ${task.id} failed. Execution paused.`);
          console.log(`Fix manually, then: succ prd run ${prdId} --resume`);
          saveExecution(execution);
          return {
            prd,
            success: false,
            tasksCompleted: tasks.filter(t => t.status === 'completed').length,
            tasksFailed: tasks.filter(t => t.status === 'failed').length,
            branch: execution.branch,
          };
        }
      }

      // Check if we can break early
      const remaining = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress');
      if (remaining.length === 0) break;
    }
    } // end else (loop mode)
  } finally {
    // 6. Branch teardown
    if (!options.noBranch && !options.resume) {
      try {
        const currentBranch = getCurrentBranch(root);
        if (currentBranch !== execution.original_branch) {
          git(`checkout ${execution.original_branch}`, root);
        }
        if (stashed) {
          try {
            // Ensure clean working tree before stash pop to avoid conflicts
            resetWorkingTree(root);
            git('stash pop', root);
          } catch {
            console.log('Warning: Could not pop stash. Check git stash list.');
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`Warning: Branch teardown issue: ${msg}`);
      }
    }
  }

  // 7. Finalize
  const allComplete = tasks.every(t => t.status === 'completed' || t.status === 'skipped');
  prd.status = allComplete ? 'completed' : 'failed';
  prd.completed_at = new Date().toISOString();
  prd.stats = computeStats(tasks);
  savePrd(prd);
  saveExecution(execution);

  const result: RunResult = {
    prd,
    success: allComplete,
    tasksCompleted: prd.stats.completed_tasks,
    tasksFailed: prd.stats.failed_tasks,
    branch: execution.branch,
  };

  appendProgress(prdId, `Execution finished — status: ${prd.status}`);

  // Display results
  console.log(`\nPRD ${prdId}: ${prd.status}`);
  console.log(`  Completed: ${result.tasksCompleted}/${prd.stats.total_tasks}`);
  if (result.tasksFailed > 0) console.log(`  Failed: ${result.tasksFailed}`);

  if (!options.noBranch) {
    console.log(`\nReview: git diff ${execution.original_branch}...${execution.branch}`);
    console.log(`Merge:  git merge ${execution.branch}`);
    console.log(`PR:     gh pr create --base ${execution.original_branch} --head ${execution.branch}`);
  }

  return result;
}

// ============================================================================
// Execute a single task
// ============================================================================

async function executeTask(
  task: Task,
  prd: Prd,
  allTasks: Task[],
  execution: PrdExecution,
  executor: LoopExecutor,
  model: string,
  root: string,
  prdId: string,
): Promise<void> {
  console.log(`\n[~] ${task.id}: ${task.title}`);
  task.status = 'in_progress';
  task.updated_at = new Date().toISOString();
  execution.current_task_id = task.id;
  saveExecution(execution);
  appendProgress(prdId, `Started ${task.id} "${task.title}"`);

  // Gather context
  const context = await gatherTaskContext(task, prdId);
  let prompt = buildTaskPrompt(task, prd, context);

  for (let attempt = 1; attempt <= task.max_attempts; attempt++) {
    console.log(`  Attempt ${attempt}/${task.max_attempts}...`);

    const taskAttempt: TaskAttempt = {
      attempt_number: attempt,
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

    // Execute via claude --print
    const executeOptions: ExecuteOptions = {
      cwd: root,
      timeout_ms: 900_000, // 15 minutes per task
      model,
      permissionMode: 'acceptEdits',
      allowedTools: WORKER_ALLOWED_TOOLS,
      mcpConfig: buildMcpConfig(),
      onOutput: (chunk) => appendTaskLog(prdId, task.id, chunk),
    };

    const result = await executor.execute(prompt, executeOptions);
    taskAttempt.completed_at = new Date().toISOString();

    // Check for BLOCKED response
    if (result.output.includes('BLOCKED:')) {
      taskAttempt.status = 'failed';
      taskAttempt.error = result.output.match(/BLOCKED:(.*)/)?.[1]?.trim() ?? 'Agent reported blocked';
      console.log(`  [x] Agent reported BLOCKED: ${taskAttempt.error}`);
      appendProgress(prdId, `${task.id} attempt ${attempt} BLOCKED: ${taskAttempt.error}`);
      task.status = 'failed';
      break;
    }

    if (!result.success) {
      taskAttempt.status = 'failed';
      taskAttempt.error = `Exit code: ${result.exit_code}`;
      console.log(`  [x] Agent failed (exit ${result.exit_code})`);
      appendProgress(prdId, `${task.id} attempt ${attempt} failed (exit ${result.exit_code})`);
      resetWorkingTree(root);

      if (attempt < task.max_attempts) {
        prompt = appendFailureContext(prompt, attempt, '', result.output);
      } else {
        task.status = 'failed';
      }
      continue;
    }

    // Run quality gates
    if (prd.quality_gates.length > 0) {
      console.log('  Running quality gates...');
      const gateResults = runAllGates(prd.quality_gates, root);
      taskAttempt.gate_results = gateResults;

      if (allRequiredPassed(gateResults)) {
        console.log('  [+] All gates passed');
      } else {
        taskAttempt.status = 'failed';
        const failedGates = gateResults.filter(r => !r.passed && r.gate.required);
        taskAttempt.error = `Gates failed: ${failedGates.map(r => r.gate.type).join(', ')}`;
        console.log(`  [x] Gates failed:\n${formatGateResults(gateResults)}`);
        appendProgress(prdId, `${task.id} attempt ${attempt} gates failed: ${taskAttempt.error}`);
        resetWorkingTree(root);

        if (attempt < task.max_attempts) {
          const gateOutput = formatGateResults(gateResults);
          prompt = appendFailureContext(prompt, attempt, gateOutput, result.output);
        } else {
          task.status = 'failed';
        }
        continue;
      }
    }

    // Success!
    taskAttempt.status = 'passed';
    task.status = 'completed';
    task.updated_at = new Date().toISOString();
    console.log(`  [+] ${task.id} completed`);
    appendProgress(prdId, `Completed ${task.id} "${task.title}"`);

    // Git commit
    try {
      if (hasUncommittedChanges(root)) {
        git('add -A', root);
        const commitMsg = `prd(${prdId}): ${task.id} — ${task.title}`;
        git(`commit -m "${commitMsg}"`, root);
        console.log(`  [git] Committed: ${commitMsg}`);

        // Track actually modified files
        taskAttempt.files_actually_modified = getModifiedFiles(root);
        const unpredicted = taskAttempt.files_actually_modified.filter(
          f => !task.files_to_modify.includes(f)
        );
        if (unpredicted.length > 0) {
          const warning = `Task ${task.id} modified unpredicted files: ${unpredicted.join(', ')}`;
          appendProgress(prdId, `WARNING: ${warning}`);
          console.log(`  [!] ${warning}`);
        }
      } else {
        console.log('  [git] No changes to commit');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [!] Git commit failed: ${msg}`);
    }

    break; // Success — no more attempts needed
  }

  execution.current_task_id = null;
  saveTasks(prdId, allTasks);
}

// ============================================================================
// Dry Run
// ============================================================================

function showDryRun(
  prd: Prd,
  tasks: Task[],
  validation: ReturnType<typeof validateTaskGraph>,
  mode: 'loop' | 'team',
  concurrency: number,
): RunResult {
  console.log(`\n[DRY RUN] PRD: ${prd.title} (${prd.id})`);
  console.log(`Mode: ${mode}${mode === 'team' ? ` (concurrency: ${concurrency})` : ''}\n`);

  if (mode === 'team') {
    // Show parallelization waves — simulate dispatch to show concurrency
    const simTasks = tasks.map(t => ({ ...t }));
    let wave = 1;
    while (simTasks.some(t => t.status === 'pending')) {
      // Inline ready-task check (same logic as getReadyTasks but without the import)
      const ready = simTasks.filter(t => {
        if (t.status !== 'pending') return false;
        return t.depends_on.every(depId => {
          const dep = simTasks.find(d => d.id === depId);
          return dep && (dep.status === 'completed' || dep.status === 'skipped');
        });
      });
      if (ready.length === 0) break;

      const batch = ready.slice(0, concurrency);
      console.log(`  Wave ${wave}:`);
      for (const task of batch) {
        const deps = task.depends_on.length > 0 ? ` (after: ${task.depends_on.join(', ')})` : '';
        console.log(`    ${task.id} [${task.priority}] ${task.title}${deps}`);
      }

      // Simulate completion for next wave
      for (const task of batch) {
        const sim = simTasks.find(t => t.id === task.id);
        if (sim) sim.status = 'completed';
      }
      wave++;
    }
  } else {
    console.log('Execution plan:\n');
    const sorted = topologicalSort(tasks);
    for (const task of sorted) {
      const deps = task.depends_on.length > 0 ? ` (after: ${task.depends_on.join(', ')})` : '';
      console.log(`  ${task.id} [${task.priority}] ${task.title}${deps}`);
      if (task.files_to_modify.length > 0) {
        console.log(`    files: ${task.files_to_modify.join(', ')}`);
      }
    }
  }

  if (prd.quality_gates.length > 0) {
    console.log('\nQuality gates:');
    for (const g of prd.quality_gates) {
      console.log(`  - ${g.type}: ${g.command}`);
    }
  }

  if (validation.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of validation.warnings) {
      console.log(`  - ${w}`);
    }
  }

  console.log('\nTo execute: succ prd run ' + prd.id);

  return {
    prd,
    success: true,
    tasksCompleted: 0,
    tasksFailed: 0,
  };
}
