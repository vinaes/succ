/**
 * PRD Parser
 *
 * Parses a PRD markdown document into executable Task[] via LLM.
 * Enriches the LLM prompt with real codebase context before parsing.
 */

import { callLLM, callLLMWithFallback, getLLMConfig, type LLMBackend } from '../llm.js';
import { logWarn } from '../fault-logger.js';
import { PRD_PARSE_PROMPT } from '../../prompts/prd.js';
import { gatherCodebaseContext, formatContext } from './codebase-context.js';
import { createTask } from './types.js';
import type { Task } from './types.js';
import { ValidationError } from '../errors.js';

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
  const prompt = PRD_PARSE_PROMPT.replace('{codebase_context}', contextStr).replace(
    '{prd_content}',
    prdContent
  );

  const llmOpts = {
    maxTokens: 8000,
    temperature: 0.2, // Low temperature for structured output
    timeout: 120_000, // Parsing needs more time than default 30s
  };

  // 3. Call LLM (with backend fallback on transport errors)
  let response = await callLLMWithFallback(prompt, llmOpts);

  // 4. Extract JSON from response
  let rawTasks = extractJson(response);

  // 4b. Retry once with corrective prompt if extraction failed
  if (!rawTasks) {
    logWarn('prd', 'JSON extraction failed, retrying with corrective prompt...');
    const retryPrompt = `Your previous response was not valid JSON. Here is what you returned:

${response.slice(0, 1000)}

Return ONLY a valid JSON array starting with [ and ending with ]. No markdown, no explanation, no prose. Each element must have: sequence, title, description, priority, depends_on, acceptance_criteria, files_to_modify, relevant_files.`;

    response = await callLLMWithFallback(retryPrompt, llmOpts);
    rawTasks = extractJson(response);
  }

  // 4c. If local LLM can't produce JSON, escalate to a stronger backend
  if (!rawTasks) {
    const currentBackend = getLLMConfig().backend;
    const escalateBackends = ['api', 'claude'].filter((b) => b !== currentBackend) as LLMBackend[];

    for (const backend of escalateBackends) {
      try {
        logWarn(
          'prd',
          `Escalating PRD parse to '${backend}' backend after local LLM failed to produce valid JSON`
        );
        response = await callLLM(prompt, llmOpts, { backend });
        rawTasks = extractJson(response);
        if (rawTasks) break;
      } catch {
        // Backend unavailable — try next
      }
    }
  }

  if (!rawTasks) {
    throw new ValidationError(
      'Failed to parse LLM response as JSON task array after retry. Response:\n' +
        response.slice(0, 500)
    );
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
 * Try to parse a value as a RawTask array.
 * Handles both direct arrays and object wrappers like {"tasks": [...]}.
 */
function asTaskArray(parsed: unknown): RawTask[] | null {
  if (Array.isArray(parsed)) return parsed;
  // Object wrapper — find the first array value
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const values = Object.values(parsed as Record<string, unknown>);
    const arr = values.find((v) => Array.isArray(v));
    if (arr) return arr as RawTask[];
  }
  return null;
}

/**
 * Fix common JSON malformations from local LLMs:
 * - Trailing commas before ] or }
 * - Single-line // comments
 */
function fixMalformedJson(text: string): string {
  // Remove single-line // comments that appear outside of JSON strings.
  // Only strip // that follows whitespace, comma, or line start — avoids breaking URLs.
  let fixed = text.replace(/^(\s*)\/\/[^\n]*/gm, ''); // Line-start comments
  fixed = fixed.replace(/,(\s*)\/\/[^\n]*/g, ','); // After-comma comments
  // Remove trailing commas before ] or }
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');
  return fixed;
}

/**
 * Try to JSON.parse text, with malformation fix as fallback.
 */
function tryParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    // Try with malformation fixes
    try {
      return JSON.parse(fixMalformedJson(text));
    } catch {
      return null;
    }
  }
}

/**
 * Extract a JSON array from LLM response.
 * Handles: direct JSON, markdown code blocks, object wrappers,
 * trailing commas, and embedded arrays in prose.
 */
function extractJson(response: string): RawTask[] | null {
  const trimmed = response.trim();

  // Strategy 1: Direct parse
  const direct = tryParse(trimmed);
  if (direct) {
    const arr = asTaskArray(direct);
    if (arr) return arr;
  }

  // Strategy 2: Extract from markdown code block
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    const blockContent = tryParse(codeBlockMatch[1].trim());
    if (blockContent) {
      const arr = asTaskArray(blockContent);
      if (arr) return arr;
    }
  }

  // Strategy 3: Find array in response (first [ to last ])
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    const slice = trimmed.slice(firstBracket, lastBracket + 1);
    const sliceContent = tryParse(slice);
    if (sliceContent) {
      const arr = asTaskArray(sliceContent);
      if (arr) return arr;
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
    const dependsOn = (raw.depends_on ?? []).map((dep) => {
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
      warnings.push(
        `Task ${sequence} "${raw.title}": no files_to_modify — may conflict with other tasks`
      );
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

    const task = tasks.find((t) => t.id === taskId);
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
  const taskIds = new Set(tasks.map((t) => t.id));
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i];
      const b = tasks[j];
      const overlap = a.files_to_modify.filter((f) => b.files_to_modify.includes(f));
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
