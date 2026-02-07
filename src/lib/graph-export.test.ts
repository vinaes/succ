import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Create temp directory for tests
const createTempDir = () =>
  path.join(os.tmpdir(), `succ-graph-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

let tempDir: string;

// Mock config
vi.mock('./config.js', () => {
  return {
    getConfig: () => ({
      graph_auto_export: false,
      graph_export_format: 'obsidian',
    }),
    getClaudeDir: () => tempDir,
    getProjectRoot: () => tempDir,
    getDbPath: () => ':memory:',
    getGlobalDbPath: () => ':memory:',
  };
});

// Mock db
const mockMemories: any[] = [];
const mockLinks: any[] = [];

vi.mock('./storage/index.js', () => ({
  getAllMemoriesForExport: async () => mockMemories.map((m: any) => ({
    id: m.id, content: m.content,
    tags: m.tags ? (typeof m.tags === 'string' ? JSON.parse(m.tags) : m.tags) : [],
    source: m.source, type: m.type,
    embedding: null,
    quality_score: m.quality_score ?? null,
    quality_factors: null,
    access_count: m.access_count ?? 0,
    last_accessed: m.last_accessed ?? null,
    created_at: m.created_at,
    invalidated_by: null,
  })),
  getAllMemoryLinksForExport: async () => mockLinks.map((l: any) => ({
    id: l.id ?? 0, source_id: l.source_id, target_id: l.target_id,
    relation: l.relation, weight: l.weight, created_at: l.created_at ?? new Date().toISOString(),
  })),
  getMemoryById: async (id: number) => {
    const m = mockMemories.find((m: any) => m.id === id);
    return m ? { id: m.id, content: m.content, type: m.type, tags: m.tags ?? [] } : null;
  },
  getMemoryLinks: async (id: number) => ({
    outgoing: mockLinks.filter((l: any) => l.source_id === id).map((l: any) => ({
      target_id: l.target_id,
      relation: l.relation,
      weight: l.weight,
    })),
    incoming: mockLinks.filter((l: any) => l.target_id === id).map((l: any) => ({
      source_id: l.source_id,
      relation: l.relation,
      weight: l.weight,
    })),
  }),
  getGraphStats: async () => ({
    total_memories: mockMemories.length,
    total_links: mockLinks.length,
    avg_links_per_memory: mockMemories.length > 0 ? mockLinks.length / mockMemories.length : 0,
    isolated_memories: mockMemories.filter((m: any) =>
      !mockLinks.some((l: any) => l.source_id === m.id || l.target_id === m.id)
    ).length,
    relations: mockLinks.reduce((acc: Record<string, number>, l: any) => {
      acc[l.relation] = (acc[l.relation] || 0) + 1;
      return acc;
    }, {}),
  }),
}));

describe('Graph Export Module', () => {
  beforeEach(() => {
    tempDir = createTempDir();
    fs.mkdirSync(tempDir, { recursive: true });

    // Reset mock data
    mockMemories.length = 0;
    mockLinks.length = 0;

    vi.resetModules();
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('exportGraphSilent', () => {
    it('should export to JSON format', async () => {
      mockMemories.push({
        id: 1,
        content: 'Test memory',
        tags: '["tag1"]',
        source: 'test',
        type: 'observation',
        created_at: '2026-01-01T00:00:00.000Z',
      });

      const { exportGraphSilent } = await import('./graph-export.js');
      const result = await exportGraphSilent('json', tempDir);

      expect(result.memoriesExported).toBe(1);

      const jsonPath = path.join(tempDir, 'memories-graph.json');
      expect(fs.existsSync(jsonPath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      expect(data.memories.length).toBe(1);
      expect(data.memories[0].content).toBe('Test memory');
    });

    it('should export to Obsidian format', async () => {
      mockMemories.push({
        id: 1,
        content: 'Test memory for Obsidian',
        tags: '["obsidian", "test"]',
        source: 'test',
        type: 'observation',
        created_at: '2026-01-01T00:00:00.000Z',
      });

      const { exportGraphSilent } = await import('./graph-export.js');
      const result = await exportGraphSilent('obsidian', tempDir);

      expect(result.memoriesExported).toBe(1);

      // Check that index file was created
      const indexPath = path.join(tempDir, 'Memories.md');
      expect(fs.existsSync(indexPath)).toBe(true);

      // Check that memory file was created in Inbox
      const inboxDir = path.join(tempDir, '00_Inbox');
      expect(fs.existsSync(inboxDir)).toBe(true);
    });

    it('should handle empty memories', async () => {
      const { exportGraphSilent } = await import('./graph-export.js');
      const result = await exportGraphSilent('json', tempDir);

      expect(result.memoriesExported).toBe(0);
      expect(result.linksExported).toBe(0);
    });

    it('should include links in export', async () => {
      mockMemories.push(
        {
          id: 1,
          content: 'Memory 1',
          tags: null,
          source: 'test',
          type: 'observation',
          created_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 2,
          content: 'Memory 2',
          tags: null,
          source: 'test',
          type: 'observation',
          created_at: '2026-01-02T00:00:00.000Z',
        }
      );

      mockLinks.push({
        source_id: 1,
        target_id: 2,
        relation: 'related',
        weight: 1.0,
      });

      const { exportGraphSilent } = await import('./graph-export.js');
      const result = await exportGraphSilent('json', tempDir);

      expect(result.linksExported).toBe(1);

      const jsonPath = path.join(tempDir, 'memories-graph.json');
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      expect(data.links.length).toBe(1);
      expect(data.links[0].source).toBe(1);
      expect(data.links[0].target).toBe(2);
    });

    it('should organize memories by type in Obsidian format', async () => {
      mockMemories.push(
        {
          id: 1,
          content: 'Decision memory',
          tags: '["decision"]',
          source: 'test',
          type: 'decision',
          created_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 2,
          content: 'Learning memory',
          tags: null,
          source: 'test',
          type: 'learning',
          created_at: '2026-01-02T00:00:00.000Z',
        },
        {
          id: 3,
          content: 'Error memory',
          tags: null,
          source: 'test',
          type: 'error',
          created_at: '2026-01-03T00:00:00.000Z',
        }
      );

      const { exportGraphSilent } = await import('./graph-export.js');
      const result = await exportGraphSilent('obsidian', tempDir);

      expect(result.memoriesExported).toBe(3);

      // Check that directories were created
      const projectName = path.basename(tempDir);
      expect(fs.existsSync(path.join(tempDir, '01_Projects', projectName, 'Decisions'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, '02_Knowledge'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, '00_Inbox'))).toBe(true);
    });

    it('should include wiki-links in Obsidian export', async () => {
      mockMemories.push(
        {
          id: 1,
          content: 'Source memory',
          tags: null,
          source: 'test',
          type: 'observation',
          created_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 2,
          content: 'Target memory',
          tags: null,
          source: 'test',
          type: 'observation',
          created_at: '2026-01-02T00:00:00.000Z',
        }
      );

      mockLinks.push({
        source_id: 1,
        target_id: 2,
        relation: 'leads_to',
        weight: 0.9,
      });

      const { exportGraphSilent } = await import('./graph-export.js');
      await exportGraphSilent('obsidian', tempDir);

      // Find and read the source memory file
      const inboxDir = path.join(tempDir, '00_Inbox');
      const files = fs.readdirSync(inboxDir);
      const sourceFile = files.find((f) => f.includes('(1).md'));

      expect(sourceFile).toBeDefined();
      if (sourceFile) {
        const content = fs.readFileSync(path.join(inboxDir, sourceFile), 'utf-8');
        expect(content).toContain('## Related');
        expect(content).toContain('[[');
        expect(content).toContain('leads_to');
      }
    });
  });

  describe('scheduleAutoExport', () => {
    it('should not export when auto_export is disabled', async () => {
      const { scheduleAutoExport } = await import('./graph-export.js');

      // Should not throw even when called
      scheduleAutoExport();

      // Verify no files were created
      expect(fs.readdirSync(tempDir).length).toBe(0);
    });
  });

  describe('Memory content in Obsidian export', () => {
    it('should include YAML frontmatter', async () => {
      mockMemories.push({
        id: 1,
        content: 'Test memory content',
        tags: '["tag1", "tag2"]',
        source: 'unit-test',
        type: 'observation',
        created_at: '2026-01-15T10:30:00.000Z',
      });

      const { exportGraphSilent } = await import('./graph-export.js');
      await exportGraphSilent('obsidian', tempDir);

      const inboxDir = path.join(tempDir, '00_Inbox');
      const files = fs.readdirSync(inboxDir);
      const mdFile = files.find((f) => f.endsWith('.md'));

      expect(mdFile).toBeDefined();
      if (mdFile) {
        const content = fs.readFileSync(path.join(inboxDir, mdFile), 'utf-8');

        // Check YAML frontmatter
        expect(content).toContain('---');
        expect(content).toContain('id: 1');
        expect(content).toContain('type: observation');
        expect(content).toContain('tags: ["tag1", "tag2"]');
        expect(content).toContain('source: unit-test');
        expect(content).toContain('created: 2026-01-15T10:30:00.000Z');
      }
    });

    it('should use first line as title', async () => {
      mockMemories.push({
        id: 1,
        content: 'First line becomes title\nSecond line is body',
        tags: null,
        source: 'test',
        type: 'observation',
        created_at: '2026-01-01T00:00:00.000Z',
      });

      const { exportGraphSilent } = await import('./graph-export.js');
      await exportGraphSilent('obsidian', tempDir);

      const inboxDir = path.join(tempDir, '00_Inbox');
      const files = fs.readdirSync(inboxDir);
      const mdFile = files.find((f) => f.endsWith('.md'));

      expect(mdFile).toBeDefined();
      if (mdFile) {
        const content = fs.readFileSync(path.join(inboxDir, mdFile), 'utf-8');
        // Title has status emoji prefix (🟢 active, 🟡 fading, 🔵 future, ⚫ expired)
        expect(content).toMatch(/# [🟢🟡🔵⚫] First line becomes title/u);
      }
    });

    it('should truncate long titles', async () => {
      const longTitle = 'A'.repeat(100);
      mockMemories.push({
        id: 1,
        content: longTitle + '\nBody',
        tags: null,
        source: 'test',
        type: 'observation',
        created_at: '2026-01-01T00:00:00.000Z',
      });

      const { exportGraphSilent } = await import('./graph-export.js');
      await exportGraphSilent('obsidian', tempDir);

      const inboxDir = path.join(tempDir, '00_Inbox');
      const files = fs.readdirSync(inboxDir);
      const mdFile = files.find((f) => f.endsWith('.md'));

      expect(mdFile).toBeDefined();
      if (mdFile) {
        const content = fs.readFileSync(path.join(inboxDir, mdFile), 'utf-8');
        // Title should be truncated to 60 chars (57 + '...')
        // Title should be truncated to 60 chars (57 + '...') with status emoji prefix
        expect(content).toMatch(/# [🟢🟡🔵⚫] A{57}\.\.\./u);
      }
    });
  });

  describe('Index file generation', () => {
    it('should generate index with statistics', async () => {
      mockMemories.push(
        {
          id: 1,
          content: 'Memory 1',
          tags: null,
          source: 'test',
          type: 'observation',
          created_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 2,
          content: 'Memory 2',
          tags: null,
          source: 'test',
          type: 'decision',
          created_at: '2026-01-02T00:00:00.000Z',
        }
      );

      mockLinks.push({
        source_id: 1,
        target_id: 2,
        relation: 'related',
        weight: 1.0,
      });

      const { exportGraphSilent } = await import('./graph-export.js');
      await exportGraphSilent('obsidian', tempDir);

      const indexPath = path.join(tempDir, 'Memories.md');
      expect(fs.existsSync(indexPath)).toBe(true);

      const content = fs.readFileSync(indexPath, 'utf-8');
      expect(content).toContain('# Memories');
      expect(content).toContain('## Statistics');
      expect(content).toContain('**Total Memories:**');
      expect(content).toContain('**Total Links:**');
    });
  });
});
