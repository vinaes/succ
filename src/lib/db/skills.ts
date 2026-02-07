/**
 * SQLite Skills CRUD helpers
 *
 * Extracted from skills.ts / skyll-client.ts so the dispatcher
 * can call SQLite-backed skill operations without raw getDb() bypass.
 */

import { getDb } from './connection.js';
import { getProjectRoot } from '../config.js';

// ============================================================================
// Types
// ============================================================================

export interface SkillRow {
  id: number;
  name: string;
  description: string;
  source: string;
  path?: string;
  content?: string;
  skyll_id?: string;
  usage_count: number;
  last_used?: string;
}

// ============================================================================
// CRUD
// ============================================================================

/**
 * Upsert a skill (local or Skyll cached).
 * Local skills are project-scoped, Skyll skills are global (project_id = NULL).
 */
export function upsertSkill(skill: {
  name: string;
  description: string;
  source: 'local' | 'skyll';
  path?: string;
  content?: string;
  skyllId?: string;
  cacheExpires?: string; // ISO date
}): number {
  const db = getDb();
  const projectId = skill.source === 'local' ? getProjectRoot().replace(/\\/g, '/') : null;

  const result = db.prepare(
    `INSERT OR REPLACE INTO skills (project_id, name, description, source, path, content, skyll_id, cached_at, cache_expires, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, COALESCE((SELECT created_at FROM skills WHERE project_id IS ? AND name = ?), datetime('now')), datetime('now'))`
  ).run(
    projectId,
    skill.name,
    skill.description,
    skill.source,
    skill.path ?? null,
    skill.content ?? null,
    skill.skyllId ?? null,
    skill.cacheExpires ?? null,
    projectId,
    skill.name,
  );

  return Number(result.lastInsertRowid);
}

/**
 * Get all skills (project-specific + global Skyll cache).
 */
export function getAllSkills(): SkillRow[] {
  const db = getDb();
  const projectId = getProjectRoot().replace(/\\/g, '/');
  return db.prepare(
    `SELECT id, name, description, source, path, content, skyll_id, usage_count, last_used
     FROM skills
     WHERE project_id = ? OR project_id IS NULL
     ORDER BY usage_count DESC, updated_at DESC`
  ).all(projectId) as SkillRow[];
}

/**
 * Search skills by name or description.
 */
export function searchSkills(query: string, limit: number = 10): SkillRow[] {
  const db = getDb();
  const projectId = getProjectRoot().replace(/\\/g, '/');
  return db.prepare(
    `SELECT id, name, description, source, path, usage_count, last_used
     FROM skills
     WHERE (project_id = ? OR project_id IS NULL)
       AND (name LIKE ? OR description LIKE ?)
     ORDER BY usage_count DESC, updated_at DESC
     LIMIT ?`
  ).all(projectId, `%${query}%`, `%${query}%`, limit) as SkillRow[];
}

/**
 * Get a skill by name.
 */
export function getSkillByName(name: string): SkillRow | null {
  const db = getDb();
  const projectId = getProjectRoot().replace(/\\/g, '/');
  const row = db.prepare(
    `SELECT id, name, description, source, path, content, skyll_id, usage_count, last_used
     FROM skills
     WHERE name = ? AND (project_id = ? OR project_id IS NULL)
     LIMIT 1`
  ).get(name, projectId) as SkillRow | undefined;
  return row ?? null;
}

/**
 * Track skill usage (increment count + update last_used).
 */
export function trackSkillUsage(name: string): void {
  const db = getDb();
  const projectId = getProjectRoot().replace(/\\/g, '/');
  db.prepare(
    `UPDATE skills SET usage_count = usage_count + 1, last_used = datetime('now')
     WHERE name = ? AND (project_id = ? OR project_id IS NULL)`
  ).run(name, projectId);
}

/**
 * Delete a skill by name.
 */
export function deleteSkill(name: string): boolean {
  const db = getDb();
  const projectId = getProjectRoot().replace(/\\/g, '/');
  const result = db.prepare(
    'DELETE FROM skills WHERE name = ? AND project_id = ?'
  ).run(name, projectId);
  return result.changes > 0;
}

/**
 * Clear expired Skyll cache entries.
 */
export function clearExpiredSkyllCache(): number {
  const db = getDb();
  const result = db.prepare(
    `DELETE FROM skills WHERE source = 'skyll' AND project_id IS NULL AND cache_expires < datetime('now')`
  ).run();
  return result.changes;
}

/**
 * Get cached Skyll skill by ID.
 */
export function getCachedSkyllSkill(skyllId: string): SkillRow | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT id, name, description, content, skyll_id, usage_count, last_used
     FROM skills
     WHERE skyll_id = ? AND project_id IS NULL AND cache_expires > datetime('now')`
  ).get(skyllId) as SkillRow | undefined;
  return row ?? null;
}

/**
 * Get Skyll cache stats.
 */
export function getSkyllCacheStats(): { cachedSkills: number } {
  const db = getDb();
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM skills WHERE source = 'skyll' AND project_id IS NULL`
  ).get() as { count: number };
  return { cachedSkills: row.count };
}
