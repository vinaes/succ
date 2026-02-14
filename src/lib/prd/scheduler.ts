/**
 * PRD Task Scheduler
 *
 * Validates the task graph and provides topological sort
 * for determining execution order with dependency resolution.
 */

import type { Task } from './types.js';
import { ValidationError } from '../errors.js';

// ============================================================================
// Topological Sort
// ============================================================================

/**
 * Topological sort of tasks respecting depends_on relationships.
 * Returns tasks in execution order. Throws on circular dependencies.
 */
export function topologicalSort(tasks: Task[]): Task[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const sorted: Task[] = [];

  function visit(taskId: string): void {
    if (inStack.has(taskId)) {
      throw new ValidationError(`Circular dependency detected involving task ${taskId}`);
    }
    if (visited.has(taskId)) return;

    inStack.add(taskId);
    const task = taskMap.get(taskId);
    if (task) {
      for (const dep of task.depends_on) {
        if (taskMap.has(dep)) {
          visit(dep);
        }
      }
      visited.add(taskId);
      sorted.push(task);
    }
    inStack.delete(taskId);
  }

  for (const task of tasks) {
    visit(task.id);
  }

  return sorted;
}

// ============================================================================
// Dependency Resolution
// ============================================================================

/**
 * Check if all dependencies of a task are met (completed or skipped).
 */
export function allDependenciesMet(task: Task, tasks: Task[]): boolean {
  if (task.depends_on.length === 0) return true;
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  for (const depId of task.depends_on) {
    const dep = taskMap.get(depId);
    if (!dep) continue; // Missing dep — treat as met (warning elsewhere)
    if (dep.status !== 'completed' && dep.status !== 'skipped') {
      return false;
    }
  }
  return true;
}

// ============================================================================
// Task Graph Validation
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

/**
 * Validate the task graph before execution.
 * Checks for: circular deps, invalid refs, file overlaps without deps.
 */
export function validateTaskGraph(tasks: Task[]): ValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const taskIds = new Set(tasks.map((t) => t.id));

  // 1. Check for circular dependencies
  try {
    topologicalSort(tasks);
  } catch (e: unknown) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  // 2. Check for invalid dependency references
  for (const task of tasks) {
    for (const dep of task.depends_on) {
      if (!taskIds.has(dep)) {
        errors.push(`Task ${task.id} depends on non-existent task ${dep}`);
      }
    }
  }

  // 3. Check for file overlap without dependency
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i];
      const b = tasks[j];
      const overlap = a.files_to_modify.filter((f) => b.files_to_modify.includes(f));
      if (overlap.length > 0) {
        const hasDep = a.depends_on.includes(b.id) || b.depends_on.includes(a.id);
        if (!hasDep) {
          warnings.push(
            `Tasks ${a.id} and ${b.id} both modify ${overlap.join(', ')} but have no dependency`
          );
        }
      }
    }
  }

  // 4. Check for tasks with no files_to_modify
  for (const task of tasks) {
    if (task.files_to_modify.length === 0) {
      warnings.push(`Task ${task.id} "${task.title}": no files_to_modify predicted`);
    }
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}
