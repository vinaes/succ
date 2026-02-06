/**
 * Progress Log (DB-based)
 *
 * Stores session outcomes and knowledge growth in the learning_deltas table.
 * Replaces the previous file-based progress.log approach.
 */

import { getDb } from './db/connection.js';
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
export function appendProgressEntry(delta: LearningDelta): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO learning_deltas (timestamp, source, memories_before, memories_after, new_memories, types_added, avg_quality)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    delta.timestamp,
    delta.source,
    delta.memoriesBefore,
    delta.memoriesAfter,
    delta.newMemories,
    Object.keys(delta.typesAdded).length > 0 ? JSON.stringify(delta.typesAdded) : null,
    delta.avgQualityOfNew ?? null,
  );
}

/**
 * Append a raw text entry to the progress log (for non-delta events)
 */
export function appendRawEntry(text: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO learning_deltas (timestamp, source, memories_before, memories_after, new_memories)
    VALUES (?, ?, 0, 0, 0)
  `).run(
    new Date().toISOString(),
    text,
  );
}

/**
 * Read progress log entries, most recent first
 */
export function readProgressLog(options: {
  limit?: number;
  since?: string;  // ISO date or relative: "7d", "1w", "1m"
} = {}): string[] {
  const db = getDb();
  const limit = options.limit && options.limit > 0 ? options.limit : 20;

  let sql = 'SELECT * FROM learning_deltas';
  const params: any[] = [];

  if (options.since) {
    const sinceDate = parseSinceDate(options.since);
    sql += ' WHERE timestamp >= ?';
    params.push(sinceDate.toISOString());
  }

  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as LearningDeltaRow[];

  return rows.map(row => formatRow(row));
}

/**
 * Get raw progress entries as structured data
 */
export function getProgressEntries(options: {
  limit?: number;
  since?: string;
} = {}): LearningDeltaRow[] {
  const db = getDb();
  const limit = options.limit && options.limit > 0 ? options.limit : 20;

  let sql = 'SELECT * FROM learning_deltas';
  const params: any[] = [];

  if (options.since) {
    const sinceDate = parseSinceDate(options.since);
    sql += ' WHERE timestamp >= ?';
    params.push(sinceDate.toISOString());
  }

  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params) as LearningDeltaRow[];
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

/**
 * Parse a "since" parameter into a Date
 */
function parseSinceDate(since: string): Date {
  // Try ISO date first
  const iso = new Date(since);
  if (!isNaN(iso.getTime())) return iso;

  // Parse relative format: "7d", "1w", "1m"
  const match = since.match(/^(\d+)([dwm])$/i);
  if (!match) return new Date(0); // Fall back to beginning of time

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const now = new Date();

  switch (unit) {
    case 'd':
      now.setDate(now.getDate() - value);
      break;
    case 'w':
      now.setDate(now.getDate() - value * 7);
      break;
    case 'm':
      now.setMonth(now.getMonth() - value);
      break;
  }

  return now;
}
