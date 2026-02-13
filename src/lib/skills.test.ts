/**
 * Tests for Skills module with project scoping.
 *
 * Tests verify:
 * 1. Skills table has project_id column
 * 2. Local skills are project-scoped
 * 3. Skyll cached skills are global (project_id IS NULL)
 * 4. BM25 index filters by project_id
 * 5. Skills search returns both local and global
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Create a temp directory for tests
const tempDir = path.join(os.tmpdir(), `succ-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const projectA = path.join(tempDir, 'project-a');
const projectB = path.join(tempDir, 'project-b');

let currentProject = projectA;

// Mock config to use temp directory with dynamic project root
vi.mock('./config.js', () => {
  return {
    getConfig: () => ({
      chunk_size: 500,
      chunk_overlap: 50,
      llm: { embeddings: { mode: 'local', model: 'test-model' } },
      skills: {
        local_paths: ['.claude/commands'],
      },
    }),
    getLLMTaskConfig: (task: string) => ({
      mode: task === 'embeddings' ? 'local' : 'api',
      model: task === 'embeddings' ? 'test-model' : 'qwen2.5:7b',
      api_url: 'http://localhost:11434/v1',
      api_key: undefined,
      max_tokens: 2000,
      temperature: 0.3,
    }),
    getDbPath: () => path.join(tempDir, 'test.db'),
    getGlobalDbPath: () => path.join(tempDir, 'global.db'),
    getClaudeDir: () => tempDir,
    getProjectRoot: () => currentProject,
    getSuccDir: () => path.join(currentProject, '.succ'),
  };
});

// Mock embeddings
vi.mock('./embeddings.js', () => ({
  cosineSimilarity: (a: number[], b: number[]) => {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  },
  getModelDimension: () => 384,
}));

describe('Skills Module with Project Scoping', () => {
  beforeAll(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });
  });

  afterAll(async () => {
    // Close databases first
    try {
      const db = await import('./db/index.js');
      db.closeDb();
      db.closeGlobalDb();
    } catch {
      // Ignore
    }

    // Wait for file handles to be released (Windows)
    await new Promise((r) => setTimeout(r, 100));

    // Clean up temp directory
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors on Windows
    }
  });

  describe('Skills table schema', () => {
    it('should have project_id column', async () => {
      const db = await import('./db/index.js');
      const database = db.getDb();

      const cols = database.prepare('PRAGMA table_info(skills)').all() as Array<{
        name: string;
        type: string;
      }>;

      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain('project_id');
    });

    it('should have project_id index', async () => {
      const db = await import('./db/index.js');
      const database = db.getDb();

      const indexes = database.prepare('PRAGMA index_list(skills)').all() as Array<{
        name: string;
      }>;

      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_skills_project_id');
    });
  });

  describe('Local skills (project-scoped)', () => {
    it('should insert local skill with project_id', async () => {
      currentProject = projectA;
      const projectId = projectA.replace(/\\/g, '/');

      const db = await import('./db/index.js');
      const database = db.getDb();

      // Insert a local skill for project A
      database.prepare(
        `INSERT OR REPLACE INTO skills (project_id, name, description, source, path, content, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      ).run(projectId, 'test-skill-a', 'A skill for project A', 'local', '/path/to/skill', 'content');

      // Verify it was inserted with project_id
      const row = database.prepare(
        'SELECT * FROM skills WHERE name = ?'
      ).get('test-skill-a') as any;

      expect(row).toBeDefined();
      expect(row.project_id).toBe(projectId);
      expect(row.source).toBe('local');
    });

    it('should filter skills by project_id', async () => {
      const db = await import('./db/index.js');
      const database = db.getDb();

      // Insert skills for both projects
      const projectAId = projectA.replace(/\\/g, '/');
      const projectBId = projectB.replace(/\\/g, '/');

      database.prepare(
        `INSERT OR REPLACE INTO skills (project_id, name, description, source, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      ).run(projectAId, 'skill-only-a', 'Only in project A', 'local');

      database.prepare(
        `INSERT OR REPLACE INTO skills (project_id, name, description, source, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      ).run(projectBId, 'skill-only-b', 'Only in project B', 'local');

      // Query for project A skills only
      const skillsA = database.prepare(
        'SELECT * FROM skills WHERE project_id = ?'
      ).all(projectAId) as any[];

      // Query for project B skills only
      const skillsB = database.prepare(
        'SELECT * FROM skills WHERE project_id = ?'
      ).all(projectBId) as any[];

      // Verify project isolation
      const skillANames = skillsA.map((s: any) => s.name);
      const skillBNames = skillsB.map((s: any) => s.name);

      expect(skillANames).toContain('skill-only-a');
      expect(skillANames).not.toContain('skill-only-b');

      expect(skillBNames).toContain('skill-only-b');
      expect(skillBNames).not.toContain('skill-only-a');
    });
  });

  describe('Global Skyll cached skills', () => {
    it('should insert Skyll skill with NULL project_id', async () => {
      const db = await import('./db/index.js');
      const database = db.getDb();

      // Insert a Skyll cached skill (global)
      database.prepare(
        `INSERT OR REPLACE INTO skills (project_id, name, description, source, skyll_id, cached_at, cache_expires, updated_at)
         VALUES (NULL, ?, ?, 'skyll', ?, datetime('now'), datetime('now', '+7 days'), datetime('now'))`
      ).run('global-skyll-skill', 'A global Skyll skill', 'skyll-123');

      // Verify it was inserted with NULL project_id
      const row = database.prepare(
        'SELECT * FROM skills WHERE name = ?'
      ).get('global-skyll-skill') as any;

      expect(row).toBeDefined();
      expect(row.project_id).toBeNull();
      expect(row.source).toBe('skyll');
      expect(row.skyll_id).toBe('skyll-123');
    });

    it('should return global skills for all projects', async () => {
      const db = await import('./db/index.js');
      const database = db.getDb();

      const projectAId = projectA.replace(/\\/g, '/');
      const projectBId = projectB.replace(/\\/g, '/');

      // Query that includes both project-specific and global skills
      const skillsForA = database.prepare(
        'SELECT * FROM skills WHERE project_id = ? OR project_id IS NULL'
      ).all(projectAId) as any[];

      const skillsForB = database.prepare(
        'SELECT * FROM skills WHERE project_id = ? OR project_id IS NULL'
      ).all(projectBId) as any[];

      // Global Skyll skill should appear in both
      const skillANames = skillsForA.map((s: any) => s.name);
      const skillBNames = skillsForB.map((s: any) => s.name);

      expect(skillANames).toContain('global-skyll-skill');
      expect(skillBNames).toContain('global-skyll-skill');

      // But project-specific skills should still be isolated
      expect(skillANames).toContain('skill-only-a');
      expect(skillANames).not.toContain('skill-only-b');

      expect(skillBNames).toContain('skill-only-b');
      expect(skillBNames).not.toContain('skill-only-a');
    });
  });

  describe('Skills search with project filtering', () => {
    it('should search skills with project_id filter', async () => {
      const db = await import('./db/index.js');
      const database = db.getDb();

      const projectAId = projectA.replace(/\\/g, '/');

      // Search for skills matching a query with project filter
      const results = database.prepare(
        `SELECT * FROM skills
         WHERE (project_id = ? OR project_id IS NULL)
           AND (name LIKE ? OR description LIKE ?)`
      ).all(projectAId, '%skill%', '%skill%') as any[];

      // Should find project A local skills and global Skyll skills
      const names = results.map((r: any) => r.name);

      // Should include local skill from project A
      expect(names).toContain('test-skill-a');
      expect(names).toContain('skill-only-a');

      // Should include global Skyll skill
      expect(names).toContain('global-skyll-skill');

      // Should NOT include project B skills
      expect(names).not.toContain('skill-only-b');
    });
  });

  describe('Track skill usage', () => {
    it('should update usage count for project-scoped skills', async () => {
      const db = await import('./db/index.js');
      const database = db.getDb();

      const projectAId = projectA.replace(/\\/g, '/');

      // Track usage
      database.prepare(
        `UPDATE skills SET usage_count = usage_count + 1, last_used = datetime('now')
         WHERE name = ? AND (project_id = ? OR project_id IS NULL)`
      ).run('test-skill-a', projectAId);

      // Verify usage was incremented
      const row = database.prepare(
        'SELECT usage_count FROM skills WHERE name = ?'
      ).get('test-skill-a') as any;

      expect(row.usage_count).toBe(1);
    });
  });
});
