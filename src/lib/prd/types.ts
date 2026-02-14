/**
 * PRD-to-Task Pipeline — Type Definitions
 *
 * Core types for the PRD pipeline: generate PRD → parse into tasks → execute.
 * Inspired by Ralph (iterative loop), Anthropic best practices (git commits,
 * quality gates), and Claude Code Teams protocol.
 */

import crypto from 'crypto';

// ============================================================================
// Status Types
// ============================================================================

export type PrdStatus = 'draft' | 'ready' | 'in_progress' | 'completed' | 'archived' | 'failed';
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
export type ExecutionMode = 'loop' | 'team';
export type GateType = 'typecheck' | 'test' | 'lint' | 'build' | 'custom';

// ============================================================================
// PRD
// ============================================================================

export interface Prd {
  id: string; // "prd_" + crypto hex (8 chars)
  version: number;
  title: string;
  description: string;
  status: PrdStatus;
  execution_mode: ExecutionMode;
  source_file: string; // relative path to prd.md within prd dir
  goals: string[];
  out_of_scope: string[];
  quality_gates: QualityGate[];
  created_at: string; // ISO 8601
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  stats: PrdStats;
}

export interface PrdStats {
  total_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  skipped_tasks: number;
  total_attempts: number;
  total_duration_ms: number;
}

// ============================================================================
// Task
// ============================================================================

export interface Task {
  id: string; // "task_001", "task_002", ...
  prd_id: string;
  sequence: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: 'critical' | 'high' | 'medium' | 'low';
  depends_on: string[]; // Task IDs
  acceptance_criteria: string[];
  files_to_modify: string[]; // Predicted files task WILL change (for conflict detection)
  relevant_files: string[]; // Context files (read-only)
  context_queries: string[]; // Queries for succ_recall before execution
  attempts: TaskAttempt[];
  max_attempts: number; // default: 3
  created_at: string;
  updated_at: string;
}

export interface TaskAttempt {
  attempt_number: number;
  started_at: string;
  completed_at: string | null;
  status: 'running' | 'passed' | 'failed';
  gate_results: GateResult[];
  files_actually_modified: string[]; // git diff --name-only after execution
  memories_recalled: number;
  memories_created: number;
  dead_ends_recorded: number;
  error: string | null;
  output_log: string; // path to log file
}

// ============================================================================
// Quality Gates
// ============================================================================

export interface GateResult {
  gate: QualityGate;
  passed: boolean;
  output: string;
  duration_ms: number;
}

export interface QualityGate {
  type: GateType;
  command: string;
  required: boolean;
  timeout_ms: number; // default: 120000
}

// ============================================================================
// Execution
// ============================================================================

export interface PrdExecution {
  prd_id: string;
  mode: ExecutionMode;
  branch: string; // "prd/prd_xxx" — execution branch
  original_branch: string; // branch to return to after execution
  started_at: string;
  current_task_id: string | null;
  iteration: number; // number of full passes
  max_iterations: number; // default: 3 (Ralph-style retry whole PRD)
  pid: number | null;
  team_name: string | null; // for team mode
  concurrency: number | null; // max parallel workers (team mode)
  log_file: string;
}

// ============================================================================
// Index entry (for .succ/prds/index.json)
// ============================================================================

export interface PrdIndexEntry {
  id: string;
  title: string;
  status: PrdStatus;
  execution_mode: ExecutionMode;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Codebase Context (gathered before LLM calls)
// ============================================================================

export interface CodebaseContext {
  file_tree: string; // formatted file tree string
  code_search_results: string; // relevant code snippets
  memories: string; // recalled memories/decisions
  brain_docs: string; // brain vault documentation
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a unique PRD ID: "prd_" + 8 hex chars
 */
export function generatePrdId(): string {
  return `prd_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Generate a task ID: "task_001", "task_002", etc.
 */
export function generateTaskId(sequence: number): string {
  return `task_${String(sequence).padStart(3, '0')}`;
}

/**
 * Create an empty PrdStats object
 */
export function emptyPrdStats(): PrdStats {
  return {
    total_tasks: 0,
    completed_tasks: 0,
    failed_tasks: 0,
    skipped_tasks: 0,
    total_attempts: 0,
    total_duration_ms: 0,
  };
}

/**
 * Create a default QualityGate
 */
export function createGate(
  type: GateType,
  command: string,
  required = true,
  timeout_ms = 120_000
): QualityGate {
  return { type, command, required, timeout_ms };
}

/**
 * Create a new Prd object with defaults
 */
export function createPrd(opts: {
  title: string;
  description: string;
  execution_mode?: ExecutionMode;
  goals?: string[];
  out_of_scope?: string[];
  quality_gates?: QualityGate[];
}): Prd {
  const id = generatePrdId();
  const now = new Date().toISOString();
  return {
    id,
    version: 1,
    title: opts.title,
    description: opts.description,
    status: 'draft',
    execution_mode: opts.execution_mode ?? 'loop',
    source_file: 'prd.md',
    goals: opts.goals ?? [],
    out_of_scope: opts.out_of_scope ?? [],
    quality_gates: opts.quality_gates ?? [],
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
    stats: emptyPrdStats(),
  };
}

/**
 * Create a new Task object with defaults
 */
export function createTask(opts: {
  prd_id: string;
  sequence: number;
  title: string;
  description: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  depends_on?: string[];
  acceptance_criteria?: string[];
  files_to_modify?: string[];
  relevant_files?: string[];
  context_queries?: string[];
  max_attempts?: number;
}): Task {
  const now = new Date().toISOString();
  return {
    id: generateTaskId(opts.sequence),
    prd_id: opts.prd_id,
    sequence: opts.sequence,
    title: opts.title,
    description: opts.description,
    status: 'pending',
    priority: opts.priority ?? 'medium',
    depends_on: opts.depends_on ?? [],
    acceptance_criteria: opts.acceptance_criteria ?? [],
    files_to_modify: opts.files_to_modify ?? [],
    relevant_files: opts.relevant_files ?? [],
    context_queries: opts.context_queries ?? [],
    attempts: [],
    max_attempts: opts.max_attempts ?? 3,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Create a PrdExecution object for starting a run
 */
export function createExecution(opts: {
  prd_id: string;
  mode: ExecutionMode;
  branch: string;
  original_branch: string;
  max_iterations?: number;
}): PrdExecution {
  return {
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
  };
}

/**
 * Convert a Prd to an index entry
 */
export function prdToIndexEntry(prd: Prd): PrdIndexEntry {
  return {
    id: prd.id,
    title: prd.title,
    status: prd.status,
    execution_mode: prd.execution_mode,
    created_at: prd.created_at,
    updated_at: prd.updated_at,
  };
}

/**
 * Compute updated PrdStats from tasks
 */
export function computeStats(tasks: Task[]): PrdStats {
  return {
    total_tasks: tasks.length,
    completed_tasks: tasks.filter((t) => t.status === 'completed').length,
    failed_tasks: tasks.filter((t) => t.status === 'failed').length,
    skipped_tasks: tasks.filter((t) => t.status === 'skipped').length,
    total_attempts: tasks.reduce((sum, t) => sum + t.attempts.length, 0),
    total_duration_ms: tasks.reduce((sum, t) => {
      return (
        sum +
        t.attempts.reduce((aSum, a) => {
          if (!a.completed_at) return aSum;
          return aSum + (new Date(a.completed_at).getTime() - new Date(a.started_at).getTime());
        }, 0)
      );
    }, 0),
  };
}
