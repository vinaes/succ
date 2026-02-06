/**
 * Learning Delta Calculator
 *
 * Measures what was learned in a session by comparing
 * memory snapshots before and after extraction.
 *
 * Provides quantitative metrics on knowledge growth.
 */

import { getMemoryStats } from './db/index.js';

export interface MemorySnapshot {
  totalMemories: number;
  byType: Record<string, number>;
  timestamp: string;
}

export interface LearningDelta {
  timestamp: string;
  memoriesBefore: number;
  memoriesAfter: number;
  newMemories: number;
  typesAdded: Record<string, number>;
  avgQualityOfNew?: number;
  source: string;  // "session-summary", "manual", "remember"
}

/**
 * Take a snapshot of current memory state
 */
export function takeMemorySnapshot(): MemorySnapshot {
  const stats = getMemoryStats();
  return {
    totalMemories: stats.active_memories,
    byType: { ...stats.by_type },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Calculate the learning delta between two snapshots
 */
export function calculateLearningDelta(
  before: MemorySnapshot,
  after: MemorySnapshot,
  source: string = 'session-summary'
): LearningDelta {
  const newMemories = after.totalMemories - before.totalMemories;

  // Calculate per-type changes
  const typesAdded: Record<string, number> = {};
  const allTypes = new Set([...Object.keys(before.byType), ...Object.keys(after.byType)]);

  for (const type of allTypes) {
    const diff = (after.byType[type] || 0) - (before.byType[type] || 0);
    if (diff > 0) {
      typesAdded[type] = diff;
    }
  }

  return {
    timestamp: after.timestamp,
    memoriesBefore: before.totalMemories,
    memoriesAfter: after.totalMemories,
    newMemories: Math.max(0, newMemories),
    typesAdded,
    source,
  };
}

/**
 * Format a learning delta as a one-line progress log entry
 */
export function formatDeltaLogEntry(delta: LearningDelta): string {
  const topics = Object.entries(delta.typesAdded)
    .map(([type, count]) => `${type}:${count}`)
    .join(', ');

  return `[${delta.timestamp}] ${delta.source} | +${delta.newMemories} facts (${delta.memoriesBefore} → ${delta.memoriesAfter})${topics ? ` | types: ${topics}` : ''}`;
}
