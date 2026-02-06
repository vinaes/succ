import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  loadAnalyzeState,
  saveAnalyzeState,
  hashFile,
  shouldRerunAgent,
  getGitHead,
  getChangedFiles,
} from './analyze-state.js';
import type { AnalyzeState } from './analyze-state.js';

describe('analyze-state', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'succ-analyze-state-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeState = (overrides: Partial<AnalyzeState> = {}): AnalyzeState => ({
    lastRun: '2025-01-01T00:00:00.000Z',
    gitCommit: 'abc123',
    fileCount: 50,
    agents: {
      dependencies: { lastRun: '2025-01-01T00:00:00.000Z', outputHash: 'aaa' },
      architecture: { lastRun: '2025-01-01T00:00:00.000Z', outputHash: 'bbb' },
      conventions: { lastRun: '2025-01-01T00:00:00.000Z', outputHash: 'ccc' },
      api: { lastRun: '2025-01-01T00:00:00.000Z', outputHash: 'ddd' },
      'systems-overview': { lastRun: '2025-01-01T00:00:00.000Z', outputHash: 'eee' },
      features: { lastRun: '2025-01-01T00:00:00.000Z', outputHash: 'fff' },
      strategy: { lastRun: '2025-01-01T00:00:00.000Z', outputHash: 'ggg' },
    },
    ...overrides,
  });

  describe('loadAnalyzeState', () => {
    it('should return null when no state file exists', () => {
      expect(loadAnalyzeState(tmpDir)).toBeNull();
    });

    it('should load saved state', () => {
      const state = makeState();
      fs.writeFileSync(
        path.join(tmpDir, 'analyze-state.json'),
        JSON.stringify(state)
      );

      const loaded = loadAnalyzeState(tmpDir);
      expect(loaded).toEqual(state);
    });

    it('should return null for corrupted JSON', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'analyze-state.json'),
        'not valid json{'
      );

      expect(loadAnalyzeState(tmpDir)).toBeNull();
    });
  });

  describe('saveAnalyzeState', () => {
    it('should save state to file', () => {
      const state = makeState();
      saveAnalyzeState(tmpDir, state);

      const raw = fs.readFileSync(
        path.join(tmpDir, 'analyze-state.json'),
        'utf-8'
      );
      expect(JSON.parse(raw)).toEqual(state);
    });

    it('should pretty-print with 2-space indent', () => {
      const state = makeState({ agents: {} });
      saveAnalyzeState(tmpDir, state);

      const raw = fs.readFileSync(
        path.join(tmpDir, 'analyze-state.json'),
        'utf-8'
      );
      expect(raw).toBe(JSON.stringify(state, null, 2));
    });

    it('should roundtrip with loadAnalyzeState', () => {
      const state = makeState();
      saveAnalyzeState(tmpDir, state);
      expect(loadAnalyzeState(tmpDir)).toEqual(state);
    });
  });

  describe('hashFile', () => {
    it('should return empty string for non-existent file', () => {
      expect(hashFile(path.join(tmpDir, 'nope.txt'))).toBe('');
    });

    it('should return MD5 hash of file content', () => {
      const filePath = path.join(tmpDir, 'test.txt');
      fs.writeFileSync(filePath, 'hello world');

      const hash = hashFile(filePath);
      expect(hash).toMatch(/^[a-f0-9]{32}$/);
    });

    it('should return consistent hash for same content', () => {
      const f1 = path.join(tmpDir, 'a.txt');
      const f2 = path.join(tmpDir, 'b.txt');
      fs.writeFileSync(f1, 'identical');
      fs.writeFileSync(f2, 'identical');

      expect(hashFile(f1)).toBe(hashFile(f2));
    });

    it('should return different hash for different content', () => {
      const f1 = path.join(tmpDir, 'a.txt');
      const f2 = path.join(tmpDir, 'b.txt');
      fs.writeFileSync(f1, 'content A');
      fs.writeFileSync(f2, 'content B');

      expect(hashFile(f1)).not.toBe(hashFile(f2));
    });
  });

  describe('getGitHead', () => {
    it('should return a commit hash for a git repo', () => {
      // Use the actual project root (which is a git repo)
      const projectRoot = path.resolve(__dirname, '../..');
      const head = getGitHead(projectRoot);

      expect(head).toMatch(/^[a-f0-9]{40}$/);
    });

    it('should return empty string for non-git directory', () => {
      expect(getGitHead(tmpDir)).toBe('');
    });
  });

  describe('getChangedFiles', () => {
    it('should return empty array when sinceCommit is empty', () => {
      expect(getChangedFiles(tmpDir, '')).toEqual([]);
    });

    it('should return empty array for invalid commit', () => {
      expect(getChangedFiles(tmpDir, 'invalidcommithash')).toEqual([]);
    });
  });

  describe('shouldRerunAgent', () => {
    it('should return true for agent never run before', () => {
      const state = makeState({ agents: {} });
      expect(shouldRerunAgent('dependencies', state, ['package.json'])).toBe(true);
    });

    it('should return false when no files changed', () => {
      const state = makeState();
      expect(shouldRerunAgent('dependencies', state, [])).toBe(false);
      expect(shouldRerunAgent('architecture', state, [])).toBe(false);
      expect(shouldRerunAgent('api', state, [])).toBe(false);
    });

    describe('dependencies agent', () => {
      it('should rerun when package.json changed', () => {
        const state = makeState();
        expect(shouldRerunAgent('dependencies', state, ['package.json'])).toBe(true);
      });

      it('should rerun when nested package.json changed', () => {
        const state = makeState();
        expect(shouldRerunAgent('dependencies', state, ['packages/core/package.json'])).toBe(true);
      });

      it('should rerun when go.mod changed', () => {
        const state = makeState();
        expect(shouldRerunAgent('dependencies', state, ['go.mod'])).toBe(true);
      });

      it('should rerun when pyproject.toml changed', () => {
        const state = makeState();
        expect(shouldRerunAgent('dependencies', state, ['pyproject.toml'])).toBe(true);
      });

      it('should rerun when Cargo.toml changed', () => {
        const state = makeState();
        expect(shouldRerunAgent('dependencies', state, ['Cargo.toml'])).toBe(true);
      });

      it('should rerun when requirements.txt changed', () => {
        const state = makeState();
        expect(shouldRerunAgent('dependencies', state, ['requirements.txt'])).toBe(true);
      });

      it('should NOT rerun for unrelated files', () => {
        const state = makeState();
        expect(shouldRerunAgent('dependencies', state, ['src/main.ts', 'README.md'])).toBe(false);
      });
    });

    describe('architecture agent', () => {
      it('should rerun when >10 files changed', () => {
        const state = makeState();
        const files = Array.from({ length: 11 }, (_, i) => `src/file${i}.ts`);
        expect(shouldRerunAgent('architecture', state, files)).toBe(true);
      });

      it('should rerun when top-level directory appeared', () => {
        const state = makeState();
        // A file with depth <=2 and no dot = likely a directory
        expect(shouldRerunAgent('architecture', state, ['newdir'])).toBe(true);
      });

      it('should NOT rerun for few deep file changes', () => {
        const state = makeState();
        expect(shouldRerunAgent('architecture', state, ['src/lib/deep/file.ts'])).toBe(false);
      });
    });

    describe('conventions agent', () => {
      it('should rerun when >10 source files changed', () => {
        const state = makeState();
        const files = Array.from({ length: 11 }, (_, i) => `src/module${i}.ts`);
        expect(shouldRerunAgent('conventions', state, files)).toBe(true);
      });

      it('should NOT rerun for non-source files', () => {
        const state = makeState();
        const files = Array.from({ length: 20 }, (_, i) => `docs/page${i}.md`);
        expect(shouldRerunAgent('conventions', state, files)).toBe(false);
      });

      it('should count .js, .py, .go, .rs, .java files', () => {
        const state = makeState();
        const files = [
          ...Array.from({ length: 3 }, (_, i) => `a${i}.js`),
          ...Array.from({ length: 3 }, (_, i) => `b${i}.py`),
          ...Array.from({ length: 3 }, (_, i) => `c${i}.go`),
          ...Array.from({ length: 3 }, (_, i) => `d${i}.rs`),
        ];
        // 12 source files > 10 threshold
        expect(shouldRerunAgent('conventions', state, files)).toBe(true);
      });
    });

    describe('api agent', () => {
      it('should rerun when route file changed', () => {
        const state = makeState();
        expect(shouldRerunAgent('api', state, ['src/routes/users.ts'])).toBe(true);
      });

      it('should rerun when handler file changed', () => {
        const state = makeState();
        expect(shouldRerunAgent('api', state, ['src/handler.ts'])).toBe(true);
      });

      it('should rerun when controller file changed', () => {
        const state = makeState();
        expect(shouldRerunAgent('api', state, ['controllers/auth.ts'])).toBe(true);
      });

      it('should rerun when api file changed', () => {
        const state = makeState();
        expect(shouldRerunAgent('api', state, ['src/api/v1.ts'])).toBe(true);
      });

      it('should rerun when endpoint file changed', () => {
        const state = makeState();
        expect(shouldRerunAgent('api', state, ['endpoints/health.ts'])).toBe(true);
      });

      it('should rerun when server file changed', () => {
        const state = makeState();
        expect(shouldRerunAgent('api', state, ['server.ts'])).toBe(true);
      });

      it('should NOT rerun for unrelated files', () => {
        const state = makeState();
        expect(shouldRerunAgent('api', state, ['src/utils/math.ts'])).toBe(false);
      });
    });

    describe('systems-overview and features agents', () => {
      it('should rerun when >5 files changed', () => {
        const state = makeState();
        const files = Array.from({ length: 6 }, (_, i) => `file${i}.ts`);
        expect(shouldRerunAgent('systems-overview', state, files)).toBe(true);
        expect(shouldRerunAgent('features', state, files)).toBe(true);
      });

      it('should NOT rerun for <=5 file changes', () => {
        const state = makeState();
        const files = Array.from({ length: 5 }, (_, i) => `file${i}.ts`);
        expect(shouldRerunAgent('systems-overview', state, files)).toBe(false);
        expect(shouldRerunAgent('features', state, files)).toBe(false);
      });
    });

    describe('strategy agent', () => {
      it('should rerun when README changed', () => {
        const state = makeState();
        expect(shouldRerunAgent('strategy', state, ['README.md'])).toBe(true);
      });

      it('should rerun when CHANGELOG changed', () => {
        const state = makeState();
        expect(shouldRerunAgent('strategy', state, ['CHANGELOG.md'])).toBe(true);
      });

      it('should rerun when docs/ file changed', () => {
        const state = makeState();
        expect(shouldRerunAgent('strategy', state, ['docs/api.md'])).toBe(true);
      });

      it('should rerun when any .md file changed', () => {
        const state = makeState();
        expect(shouldRerunAgent('strategy', state, ['CONTRIBUTING.md'])).toBe(true);
      });

      it('should NOT rerun for non-doc files', () => {
        const state = makeState();
        expect(shouldRerunAgent('strategy', state, ['src/main.ts'])).toBe(false);
      });
    });

    describe('unknown agent', () => {
      it('should always rerun', () => {
        const state = makeState();
        expect(shouldRerunAgent('custom-agent', state, ['anything.txt'])).toBe(true);
      });
    });
  });
});
