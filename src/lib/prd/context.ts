/**
 * PRD Task Context Gatherer
 *
 * Gathers context from succ memory system before executing a task.
 * This provides the agent with relevant memories, dead-end warnings,
 * and documentation context.
 *
 * Uses the storage abstraction (hybridSearchMemories) which works with
 * SQLite, PostgreSQL, and Qdrant backends transparently.
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
 * Queries hybridSearchMemories for relevant memories and dead-ends based on
 * the task's context_queries and description.
 */
export async function gatherTaskContext(
  task: Task,
  prdId: string,
): Promise<TaskContext> {
  const recalled: string[] = [];
  const deadEnds: string[] = [];

  // 1. Search memories via storage abstraction (works with SQLite, PG, Qdrant)
  try {
    const { hybridSearchMemories } = await import('../storage/index.js');
    const { getEmbedding } = await import('../embeddings.js');

    // Build a combined query from task context
    const queries = [
      ...task.context_queries,
      task.title,
      ...task.files_to_modify.map(f => f.split('/').pop() ?? f),
    ];

    // Deduplicate results across queries
    const seen = new Set<number>();

    for (const query of queries.slice(0, 5)) {
      try {
        const queryEmbedding = await getEmbedding(query);
        const memories = await hybridSearchMemories(query, queryEmbedding, 3, 0.3);

        for (const m of memories) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);

          const tag = m.type === 'dead_end' ? '[DEAD-END]' : `[${m.type ?? 'observation'}]`;
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
    // Storage not available — that's fine, we just won't have memory context
    recalled.push('(No succ memories available — storage not initialized)');
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
