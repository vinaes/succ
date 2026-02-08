/**
 * PRD Task Context Gatherer
 *
 * Gathers context from succ memory system before executing a task.
 * This provides the agent with relevant memories, dead-end warnings,
 * and documentation context.
 */

import type { Task } from './types.js';
import { loadProgress } from './state.js';

// ============================================================================
// Task Context
// ============================================================================

export interface TaskContext {
  recalled_memories: string;
  dead_end_warnings: string;
  progress_so_far: string;
}

/**
 * Gather context for a task before execution.
 *
 * Queries succ_recall for relevant memories and dead-ends based on
 * the task's context_queries and description.
 */
export async function gatherTaskContext(
  task: Task,
  prdId: string,
): Promise<TaskContext> {
  const recalled: string[] = [];
  const deadEnds: string[] = [];

  // 1. Try to load succ recall results via the MCP bridge
  //    In CLI context, we don't have direct MCP access, so we use
  //    the local DB if available.
  try {
    // Dynamic import to avoid hard dependency
    const { getDb } = await import('../db/index.js');
    const db = getDb();

    // Recall memories by task context queries
    const queries = [
      ...task.context_queries,
      task.title,
      ...task.files_to_modify.map(f => f.split('/').pop() ?? f),
    ];

    for (const query of queries.slice(0, 5)) { // Limit queries
      try {
        const memories = db.prepare(
          `SELECT content, type, tags FROM memories
           WHERE content LIKE ? AND (invalidated_at IS NULL)
           ORDER BY updated_at DESC LIMIT 3`
        ).all(`%${query}%`) as Array<{ content: string; type: string; tags: string }>;

        for (const m of memories) {
          const tag = m.type === 'dead_end' ? '[DEAD-END]' : `[${m.type}]`;
          const line = `${tag} ${m.content}`;
          if (m.type === 'dead_end') {
            deadEnds.push(line);
          } else {
            recalled.push(line);
          }
        }
      } catch {
        // Query failed — skip this query
      }
    }
  } catch {
    // DB not available — that's fine, we just won't have memory context
    recalled.push('(No succ memories available — DB not initialized)');
  }

  // 2. Load progress so far
  const progress = loadProgress(prdId);

  return {
    recalled_memories: recalled.length > 0
      ? recalled.join('\n')
      : '(No relevant memories found)',
    dead_end_warnings: deadEnds.length > 0
      ? deadEnds.join('\n')
      : '(No dead-ends recorded for this area)',
    progress_so_far: progress || '(No progress recorded yet)',
  };
}
