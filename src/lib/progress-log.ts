/**
 * Progress Log (DB-based)
 *
 * Stores session outcomes and knowledge growth in the learning_deltas table.
 * Replaces the previous file-based progress.log approach.
 */

import { appendLearningDelta, appendRawLearningDelta, getLearningDeltas } from './storage/index.js';
import type { LearningDelta } from './learning-delta.js';

/**
 * Row shape from learning_deltas table
 */
export interface LearningDeltaRow {
  id: number;
  timestamp: string;
  source: string;
  memories_before: number;
  memories_after: number;
  new_memories: number;
  types_added: string | null;
  avg_quality: number | null;
  created_at: string;
}

/**
 * Append a learning delta entry to the DB
 */
export async function appendProgressEntry(delta: LearningDelta): Promise<void> {
  await appendLearningDelta({
    timestamp: delta.timestamp,
    source: delta.source,
    memoriesBefore: delta.memoriesBefore,
    memoriesAfter: delta.memoriesAfter,
    newMemories: delta.newMemories,
    typesAdded: delta.typesAdded,
    avgQualityOfNew: delta.avgQualityOfNew ?? null,
  });
}

/**
 * Append a raw text entry to the progress log (for non-delta events)
 */
export async function appendRawEntry(text: string): Promise<void> {
  await appendRawLearningDelta(text);
}

/**
 * Read progress log entries, most recent first
 */
export async function readProgressLog(
  options: {
    limit?: number;
    since?: string; // ISO date or relative: "7d", "1w", "1m"
  } = {}
): Promise<string[]> {
  const rows = await getLearningDeltas({
    limit: options.limit,
    since: options.since,
  });

  return rows.map((row) => formatRow(row));
}

/**
 * Get raw progress entries as structured data
 */
export async function getProgressEntries(
  options: {
    limit?: number;
    since?: string;
  } = {}
): Promise<LearningDeltaRow[]> {
  const rows = await getLearningDeltas({
    limit: options.limit,
    since: options.since,
  });

  return rows as LearningDeltaRow[];
}

/**
 * Format a DB row as a human-readable log line
 */
function formatRow(row: LearningDeltaRow): string {
  const types = row.types_added ? JSON.parse(row.types_added) : {};
  const topicStr = Object.entries(types)
    .map(([type, count]) => `${type}:${count}`)
    .join(', ');

  return `[${row.timestamp}] ${row.source} | +${row.new_memories} facts (${row.memories_before} → ${row.memories_after})${topicStr ? ` | types: ${topicStr}` : ''}`;
}
