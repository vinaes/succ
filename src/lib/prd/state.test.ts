import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  ensurePrdsDir,
  savePrd,
  loadPrd,
  deletePrd,
  listPrds,
  findLatestPrd,
  savePrdMarkdown,
  loadPrdMarkdown,
  saveTasks,
  loadTasks,
  saveExecution,
  loadExecution,
  appendProgress,
  loadProgress,
  getTaskLogPath,
  appendTaskLog,
} from './state.js';
import { createPrd, createTask, createExecution } from './types.js';

// Mock config to use temp directory
let tempDir: string;

vi.mock('../config.js', () => ({
  getSuccDir: () => tempDir,
}));

describe('PRD State', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prd-state-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('ensurePrdsDir', () => {
    it('should create .succ/prds/ directory', () => {
      ensurePrdsDir();
      expect(fs.existsSync(path.join(tempDir, 'prds'))).toBe(true);
    });

    it('should be idempotent', () => {
      ensurePrdsDir();
      ensurePrdsDir();
      expect(fs.existsSync(path.join(tempDir, 'prds'))).toBe(true);
    });
  });

  describe('PRD CRUD', () => {
    it('should save and load a PRD', () => {
      const prd = createPrd({ title: 'Test PRD', description: 'desc' });
      savePrd(prd);

      const loaded = loadPrd(prd.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.title).toBe('Test PRD');
      expect(loaded!.id).toBe(prd.id);
    });

    it('should return null for non-existent PRD', () => {
      ensurePrdsDir();
      expect(loadPrd('prd_nonexistent')).toBeNull();
    });

    it('should delete a PRD and its files', () => {
      const prd = createPrd({ title: 'To Delete', description: 'desc' });
      savePrd(prd);
      savePrdMarkdown(prd.id, '# Test');

      expect(loadPrd(prd.id)).not.toBeNull();

      deletePrd(prd.id);
      expect(loadPrd(prd.id)).toBeNull();
    });

    it('should update index on save', () => {
      const prd1 = createPrd({ title: 'PRD 1', description: 'desc1' });
      const prd2 = createPrd({ title: 'PRD 2', description: 'desc2' });

      savePrd(prd1);
      savePrd(prd2);

      const entries = listPrds();
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.title).sort()).toEqual(['PRD 1', 'PRD 2']);
    });

    it('should remove from index on delete', () => {
      const prd = createPrd({ title: 'Deletable', description: 'desc' });
      savePrd(prd);
      expect(listPrds()).toHaveLength(1);

      deletePrd(prd.id);
      expect(listPrds()).toHaveLength(0);
    });
  });

  describe('listPrds', () => {
    it('should return empty array when no PRDs', () => {
      ensurePrdsDir();
      expect(listPrds()).toEqual([]);
    });

    it('should filter archived PRDs by default', () => {
      const prd = createPrd({ title: 'Archived', description: 'desc' });
      prd.status = 'archived';
      savePrd(prd);

      expect(listPrds()).toHaveLength(0);
      expect(listPrds(true)).toHaveLength(1);
    });
  });

  describe('findLatestPrd', () => {
    it('should return null when no PRDs', () => {
      ensurePrdsDir();
      expect(findLatestPrd()).toBeNull();
    });

    it('should return the most recently updated PRD', () => {
      // savePrd() overwrites updated_at with new Date().toISOString(),
      // so we mock Date to control ordering deterministically
      vi.useFakeTimers();

      const prd1 = createPrd({ title: 'Old', description: 'old' });
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
      savePrd(prd1);

      const prd2 = createPrd({ title: 'New', description: 'new' });
      vi.setSystemTime(new Date('2024-06-01T00:00:00Z'));
      savePrd(prd2);

      vi.useRealTimers();

      const latest = findLatestPrd();
      expect(latest).not.toBeNull();
      expect(latest!.title).toBe('New');
    });
  });

  describe('PRD Markdown', () => {
    it('should save and load markdown', () => {
      const prd = createPrd({ title: 'MD Test', description: 'desc' });
      savePrd(prd);
      savePrdMarkdown(prd.id, '# My PRD\n\nContent here.');

      const md = loadPrdMarkdown(prd.id);
      expect(md).toBe('# My PRD\n\nContent here.');
    });

    it('should return null for missing markdown', () => {
      ensurePrdsDir();
      expect(loadPrdMarkdown('prd_nonexistent')).toBeNull();
    });
  });

  describe('Tasks', () => {
    it('should save and load tasks', () => {
      const prd = createPrd({ title: 'Tasks', description: 'desc' });
      savePrd(prd);

      const tasks = [
        createTask({ prd_id: prd.id, sequence: 1, title: 'Task 1', description: 'Do 1' }),
        createTask({ prd_id: prd.id, sequence: 2, title: 'Task 2', description: 'Do 2' }),
      ];
      saveTasks(prd.id, tasks);

      const loaded = loadTasks(prd.id);
      expect(loaded).toHaveLength(2);
      expect(loaded[0].title).toBe('Task 1');
      expect(loaded[1].title).toBe('Task 2');
    });

    it('should return empty array for missing tasks', () => {
      ensurePrdsDir();
      expect(loadTasks('prd_nonexistent')).toEqual([]);
    });
  });

  describe('Execution', () => {
    it('should save and load execution state', () => {
      const prd = createPrd({ title: 'Exec', description: 'desc' });
      savePrd(prd);

      const exec = createExecution({
        prd_id: prd.id,
        mode: 'loop',
        branch: `prd/${prd.id}`,
        original_branch: 'master',
      });
      saveExecution(exec);

      const loaded = loadExecution(prd.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.mode).toBe('loop');
      expect(loaded!.branch).toBe(`prd/${prd.id}`);
      expect(loaded!.original_branch).toBe('master');
    });

    it('should return null for missing execution', () => {
      ensurePrdsDir();
      expect(loadExecution('prd_nonexistent')).toBeNull();
    });
  });

  describe('Progress', () => {
    it('should append and load progress', () => {
      const prd = createPrd({ title: 'Progress', description: 'desc' });
      savePrd(prd);

      appendProgress(prd.id, 'Task 1 started');
      appendProgress(prd.id, 'Task 1 completed');

      const progress = loadProgress(prd.id);
      expect(progress).toContain('Task 1 started');
      expect(progress).toContain('Task 1 completed');
      // Should have timestamps
      expect(progress).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/);
    });

    it('should return empty string for missing progress', () => {
      ensurePrdsDir();
      expect(loadProgress('prd_nonexistent')).toBe('');
    });
  });

  describe('Task Logs', () => {
    it('should create log path in logs directory', () => {
      const prd = createPrd({ title: 'Logs', description: 'desc' });
      savePrd(prd);

      const logPath = getTaskLogPath(prd.id, 'task_001');
      expect(logPath).toContain('task_001.log');
      expect(logPath).toContain('logs');
    });

    it('should append to task log', () => {
      const prd = createPrd({ title: 'Logs', description: 'desc' });
      savePrd(prd);

      appendTaskLog(prd.id, 'task_001', 'Output line 1\n');
      appendTaskLog(prd.id, 'task_001', 'Output line 2\n');

      const logPath = getTaskLogPath(prd.id, 'task_001');
      const content = fs.readFileSync(logPath, 'utf-8');
      expect(content).toBe('Output line 1\nOutput line 2\n');
    });
  });
});
