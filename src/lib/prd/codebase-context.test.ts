import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { gatherCodebaseContext, formatContext } from './codebase-context.js';
import type { CodebaseContext } from './types.js';

let tempDir: string;

vi.mock('../config.js', () => ({
  getProjectRoot: () => tempDir,
  getSuccDir: () => path.join(tempDir, '.succ'),
}));

describe('Codebase Context', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-ctx-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('gatherCodebaseContext', () => {
    it('should gather file tree from project root', async () => {
      // Create some project structure
      fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
      fs.writeFileSync(path.join(tempDir, 'tsconfig.json'), '{}');
      fs.mkdirSync(path.join(tempDir, 'src', 'lib'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src', 'index.ts'), 'export {}');
      fs.writeFileSync(path.join(tempDir, 'src', 'lib', 'utils.ts'), 'export {}');

      const ctx = await gatherCodebaseContext('test feature');

      expect(ctx.file_tree).toContain('package.json');
      expect(ctx.file_tree).toContain('tsconfig.json');
      expect(ctx.file_tree).toContain('src/index.ts');
      expect(ctx.file_tree).toContain('src/lib/');
    });

    it('should exclude node_modules and dist from file tree', async () => {
      fs.mkdirSync(path.join(tempDir, 'node_modules', 'pkg'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'index.ts'), 'export {}');

      const ctx = await gatherCodebaseContext('test');

      expect(ctx.file_tree).not.toContain('node_modules');
      expect(ctx.file_tree).not.toContain('dist');
      expect(ctx.file_tree).toContain('index.ts');
    });

    it('should handle project with no src directory', async () => {
      fs.writeFileSync(path.join(tempDir, 'main.py'), 'print("hello")');

      const ctx = await gatherCodebaseContext('python project');

      expect(ctx.file_tree).toContain('main.py');
    });

    it('should note when succ DB is not available', async () => {
      const ctx = await gatherCodebaseContext('test');

      expect(ctx.memories).toContain('No succ memories available');
    });

    it('should note when brain vault is empty', async () => {
      const ctx = await gatherCodebaseContext('test');

      expect(ctx.brain_docs).toMatch(/No brain vault|Brain vault is empty/);
    });

    it('should list brain vault docs when available', async () => {
      const brainDir = path.join(tempDir, '.succ', 'brain');
      fs.mkdirSync(brainDir, { recursive: true });
      fs.writeFileSync(path.join(brainDir, 'architecture.md'), '# Arch');
      fs.writeFileSync(path.join(brainDir, 'patterns.md'), '# Patterns');

      const ctx = await gatherCodebaseContext('test');

      expect(ctx.brain_docs).toContain('architecture.md');
      expect(ctx.brain_docs).toContain('patterns.md');
    });
  });

  describe('formatContext', () => {
    it('should format all sections', () => {
      const ctx: CodebaseContext = {
        file_tree: 'src/\n  lib/\n  commands/',
        code_search_results: '--- src/auth.ts ---\nexport function auth() {}',
        memories: 'Decided to use JWT for auth',
        brain_docs: 'Available docs:\n  - auth.md',
      };

      const formatted = formatContext(ctx);

      expect(formatted).toContain('### Project File Structure');
      expect(formatted).toContain('src/');
      expect(formatted).toContain('### Relevant Source Code');
      expect(formatted).toContain('auth.ts');
      expect(formatted).toContain('### Project Memories');
      expect(formatted).toContain('JWT');
      expect(formatted).toContain('### Documentation');
    });

    it('should skip sections that start with parenthetical notes', () => {
      const ctx: CodebaseContext = {
        file_tree: 'src/',
        code_search_results: '',
        memories: '(No succ memories available)',
        brain_docs: '(Brain vault is empty)',
      };

      const formatted = formatContext(ctx);

      expect(formatted).toContain('### Project File Structure');
      expect(formatted).not.toContain('### Project Memories');
      expect(formatted).not.toContain('### Documentation');
    });

    it('should skip empty code search results', () => {
      const ctx: CodebaseContext = {
        file_tree: 'src/',
        code_search_results: '',
        memories: '',
        brain_docs: '',
      };

      const formatted = formatContext(ctx);
      expect(formatted).not.toContain('### Relevant Source Code');
    });
  });
});
