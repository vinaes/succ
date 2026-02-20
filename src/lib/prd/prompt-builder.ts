/**
 * PRD Task Prompt Builder
 *
 * Assembles the full prompt for a Claude Code agent executing a task.
 * Uses TASK_EXECUTION_PROMPT template and fills in context.
 */

import { TASK_EXECUTION_SYSTEM, TASK_EXECUTION_USER_PROMPT } from '../../prompts/prd.js';
import type { Task, Prd } from './types.js';
import type { TaskContext } from './context.js';

// ============================================================================
// Build the agent prompt
// ============================================================================

export interface TaskPrompt {
  /** Stable system instructions — cacheable across all tasks */
  system: string;
  /** Per-task user content with filled placeholders */
  user: string;
}

/**
 * Build the prompt for executing a task.
 * Returns separate system/user parts for prompt caching optimization.
 */
export function buildTaskPrompt(task: Task, prd: Prd, context: TaskContext): TaskPrompt {
  const acceptanceCriteria =
    task.acceptance_criteria.length > 0
      ? task.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
      : '(No specific acceptance criteria — use your best judgment)';

  const filesToModify =
    task.files_to_modify.length > 0
      ? task.files_to_modify.map((f) => `- ${f}`).join('\n')
      : '(No specific files predicted — determine from context)';

  const relevantFiles =
    task.relevant_files.length > 0
      ? task.relevant_files.map((f) => `- ${f}`).join('\n')
      : '(None specified)';

  const qualityGates =
    prd.quality_gates.length > 0
      ? prd.quality_gates.map((g) => `- ${g.type}: \`${g.command}\``).join('\n')
      : '(No quality gates configured)';

  const user = TASK_EXECUTION_USER_PROMPT.replace('{task_title}', `${task.id}: ${task.title}`)
    .replace('{task_description}', task.description)
    .replace('{acceptance_criteria}', acceptanceCriteria)
    .replace('{files_to_modify}', filesToModify)
    .replace('{relevant_files}', relevantFiles)
    .replace('{recalled_memories}', context.recalled_memories)
    .replace('{dead_end_warnings}', context.dead_end_warnings)
    .replace('{progress_so_far}', context.progress_so_far)
    .replace('{quality_gates}', qualityGates);

  return { system: TASK_EXECUTION_SYSTEM, user };
}

/**
 * Append failure context to a prompt for retry attempts.
 * Gives the agent info about what went wrong in the previous attempt.
 */
export function appendFailureContext(
  prompt: string,
  attemptNumber: number,
  gateOutput: string,
  agentOutput: string
): string {
  // Strip any previous failure context to prevent prompt bloat across retries
  const stripped = prompt.replace(/\n\n## Previous Attempt.*$/s, '');
  const truncatedGate = gateOutput.slice(-2000) || '(No gate output)';
  const truncatedAgent = agentOutput.slice(-1000) || '(No output)';

  return (
    stripped +
    `\n\n## Previous Attempt (${attemptNumber}) Failed

### Gate Failures
${truncatedGate}

### Agent Output (last 1000 chars)
${truncatedAgent}

### Instructions for Retry
- Fix the issues identified above
- Do NOT repeat the same approach if it clearly failed
- If the task seems impossible, explain why with "BLOCKED:" prefix
`
  );
}
