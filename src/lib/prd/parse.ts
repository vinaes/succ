/**
 * PRD Parser
 *
 * Parses a PRD markdown document into executable Task[] via LLM.
 * Enriches the LLM prompt with real codebase context before parsing.
 */

import { callLLM } from '../llm.js';
import { PRD_PARSE_PROMPT } from '../../prompts/prd.js';
import { gatherCodebaseContext, formatContext } from './codebase-context.js';
import { createTask } from './types.js';
import type { Task } from './types.js';

// ============================================================================
// Raw task shape from LLM (before normalization)
// ============================================================================

interface RawTask {
  sequence: number;
  title: string;
  description: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  depends_on?: string[];
  acceptance_criteria?: string[];
  files_to_modify?: string[];
  relevant_files?: string[];
  context_queries?: string[];
}

// ============================================================================
// Parse result
// ============================================================================

export interface ParseResult {
  tasks: Task[];
  warnings: string[];
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Parse a PRD markdown into tasks.
 *
 * @param prdContent - The PRD markdown content
 * @param prdId - The PRD ID to assign to tasks
 * @param description - Original description (for codebase context search)
 * @returns ParseResult with tasks and any validation warnings
 */
export async function parsePrd(
  prdContent: string,
  prdId: string,
  description: string
): Promise<ParseResult> {
  const warnings: string[] = [];

  // 1. Gather codebase context
  const context = await gatherCodebaseContext(description);
  const contextStr = formatContext(context);

  // 2. Build prompt
  const prompt = PRD_PARSE_PROMPT
    .replace('{codebase_context}', contextStr)
    .replace('{prd_content}', prdContent);

  // 3. Call LLM
  const response = await callLLM(prompt, {
    maxTokens: 8000,
    temperature: 0.2,  // Low temperature for structured output
    timeout: 120_000,  // Parsing needs more time than default 30s
  });

  // 4. Extract JSON from response
  const rawTasks = extractJson(response);
  if (!rawTasks) {
    throw new Error('Failed to parse LLM response as JSON task array. Response:\n' + response.slice(0, 500));
  }

  // 5. Validate and normalize
  const tasks = normalizeTasks(rawTasks, prdId, warnings);

  // 6. Run validation checks
  validateTasks(tasks, warnings);

  return { tasks, warnings };
}

// ============================================================================
// JSON Extraction
// ============================================================================

/**
 * Extract a JSON array from LLM response.
 * Handles responses wrapped in markdown code blocks.
 */
function extractJson(response: string): RawTask[] | null {
  // Try direct parse first
  try {
    const parsed = JSON.parse(response.trim());
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Continue to fallback
  }

  // Try extracting from markdown code block
  const codeBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Continue to next fallback
    }
  }

  // Try finding array in response (first [ to last ])
  const firstBracket = response.indexOf('[');
  const lastBracket = response.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    try {
      const parsed = JSON.parse(response.slice(firstBracket, lastBracket + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Give up
    }
  }

  return null;
}

// ============================================================================
// Normalization
// ============================================================================

/**
 * Convert raw LLM output into proper Task objects
 */
function normalizeTasks(rawTasks: RawTask[], prdId: string, warnings: string[]): Task[] {
  return rawTasks.map((raw, index) => {
    const sequence = raw.sequence ?? index + 1;

    // Normalize depends_on: convert sequence numbers to task IDs
    const dependsOn = (raw.depends_on ?? []).map(dep => {
      // If it's already a task ID (task_XXX format), keep it
      if (typeof dep === 'string' && dep.startsWith('task_')) return dep;
      // If it's a number or numeric string, convert to task ID
      const num = typeof dep === 'number' ? dep : parseInt(dep, 10);
      if (!isNaN(num)) return `task_${String(num).padStart(3, '0')}`;
      return dep;
    });

    if (!raw.title) {
      warnings.push(`Task ${sequence}: missing title`);
    }

    if (!raw.files_to_modify || raw.files_to_modify.length === 0) {
      warnings.push(`Task ${sequence} "${raw.title}": no files_to_modify — may conflict with other tasks`);
    }

    return createTask({
      prd_id: prdId,
      sequence,
      title: raw.title || `Task ${sequence}`,
      description: raw.description || '',
      priority: raw.priority,
      depends_on: dependsOn,
      acceptance_criteria: raw.acceptance_criteria,
      files_to_modify: raw.files_to_modify,
      relevant_files: raw.relevant_files,
      context_queries: raw.context_queries,
    });
  });
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate task list for common issues
 */
function validateTasks(tasks: Task[], warnings: string[]): void {
  // Task count check
  if (tasks.length < 3) {
    warnings.push(`Only ${tasks.length} tasks — PRD may be under-decomposed`);
  }
  if (tasks.length > 25) {
    warnings.push(`${tasks.length} tasks — PRD may be over-decomposed or scope too large`);
  }

  // Check for circular dependencies
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function hasCycle(taskId: string): boolean {
    if (inStack.has(taskId)) return true;
    if (visited.has(taskId)) return false;

    visited.add(taskId);
    inStack.add(taskId);

    const task = tasks.find(t => t.id === taskId);
    if (task) {
      for (const dep of task.depends_on) {
        if (hasCycle(dep)) return true;
      }
    }

    inStack.delete(taskId);
    return false;
  }

  for (const task of tasks) {
    if (hasCycle(task.id)) {
      warnings.push(`Circular dependency detected involving task ${task.id}`);
      break;
    }
  }

  // Check for file overlap without dependency
  const taskIds = new Set(tasks.map(t => t.id));
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i];
      const b = tasks[j];
      const overlap = a.files_to_modify.filter(f => b.files_to_modify.includes(f));
      if (overlap.length > 0) {
        const hasDep = a.depends_on.includes(b.id) || b.depends_on.includes(a.id);
        if (!hasDep) {
          warnings.push(
            `Tasks ${a.id} and ${b.id} both modify ${overlap.join(', ')} but have no dependency — potential conflict`
          );
        }
      }
    }
  }

  // Check for invalid dependency references
  for (const task of tasks) {
    for (const dep of task.depends_on) {
      if (!taskIds.has(dep)) {
        warnings.push(`Task ${task.id} depends on non-existent task ${dep}`);
      }
    }
  }
}
