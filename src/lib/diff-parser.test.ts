/**
 * Tests for structured diff parser
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('./fault-logger.js', () => ({
  logWarn: vi.fn(),
}));

import {
  parseDiffText,
  extractChangedSymbols,
  summarizeDiff,
  getFileChanges,
} from './diff-parser.js';

// Build diff as array to avoid template literal issues
const SAMPLE_DIFF = [
  'diff --git a/src/main.ts b/src/main.ts',
  'index abc1234..def5678 100644',
  '--- a/src/main.ts',
  '+++ b/src/main.ts',
  '@@ -10,5 +10,7 @@ function initialize() {',
  '   const config = loadConfig();',
  '+  const logger = createLogger();',
  "+  logger.info('Starting application');",
  '   setupDatabase(config);',
  '   startServer(config);',
  ' }',
  '@@ -25,3 +27,4 @@ function shutdown() {',
  '   closeConnections();',
  "+  logger.info('Shutdown complete');",
  ' }',
  'diff --git a/src/utils.ts b/src/utils.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/utils.ts',
  '@@ -0,0 +1,5 @@',
  '+export function createLogger() {',
  '+  return {',
  '+    info: console.log,',
  '+  };',
  '+}',
  'diff --git a/src/old.ts b/src/old.ts',
  'deleted file mode 100644',
  '--- a/src/old.ts',
  '+++ /dev/null',
  '@@ -1,3 +0,0 @@',
  '-export function deprecated() {',
  '-  return null;',
  '-}',
].join('\n');

describe('diff-parser', () => {
  describe('parseDiffText', () => {
    it('should parse a multi-file diff', () => {
      const result = parseDiffText(SAMPLE_DIFF);
      expect(result.totalFiles).toBe(3);
      expect(result.totalAdditions).toBe(7);
      expect(result.totalDeletions).toBe(3);
    });

    it('should identify new files', () => {
      const result = parseDiffText(SAMPLE_DIFF);
      const newFile = result.files.find((f) => f.to === 'src/utils.ts');
      expect(newFile).toBeDefined();
      expect(newFile!.isNew).toBe(true);
      expect(newFile!.isDeleted).toBe(false);
    });

    it('should identify deleted files', () => {
      const result = parseDiffText(SAMPLE_DIFF);
      const deletedFile = result.files.find((f) => f.from === 'src/old.ts');
      expect(deletedFile).toBeDefined();
      expect(deletedFile!.isDeleted).toBe(true);
      expect(deletedFile!.isNew).toBe(false);
    });

    it('should group files by extension', () => {
      const result = parseDiffText(SAMPLE_DIFF);
      expect(result.filesByExtension['ts']).toBeDefined();
      expect(result.filesByExtension['ts'].length).toBe(3);
    });

    it('should parse chunks correctly', () => {
      const result = parseDiffText(SAMPLE_DIFF);
      const mainFile = result.files.find((f) => f.to === 'src/main.ts');
      expect(mainFile).toBeDefined();
      expect(mainFile!.chunks.length).toBeGreaterThanOrEqual(1);
      expect(mainFile!.chunks[0].oldStart).toBe(10);
    });

    it('should handle empty input', () => {
      const result = parseDiffText('');
      expect(result.totalFiles).toBe(0);
      expect(result.files).toEqual([]);
    });

    it('should handle malformed input gracefully', () => {
      const result = parseDiffText('not a diff at all');
      expect(result.totalFiles).toBe(0);
    });
  });

  describe('extractChangedSymbols', () => {
    it('should extract function names from chunk headers', () => {
      const diff = parseDiffText(SAMPLE_DIFF);
      const symbols = extractChangedSymbols(diff);
      expect(symbols.length).toBeGreaterThan(0);
      expect(symbols.some((s) => s.symbol.includes('initialize'))).toBe(true);
    });

    it('should deduplicate symbols', () => {
      const diff = parseDiffText(SAMPLE_DIFF);
      const symbols = extractChangedSymbols(diff);
      const keys = symbols.map((s) => `${s.file}:${s.symbol}`);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  describe('summarizeDiff', () => {
    it('should produce a compact summary', () => {
      const diff = parseDiffText(SAMPLE_DIFF);
      const summary = summarizeDiff(diff);
      expect(summary).toContain('3 file(s) changed');
      expect(summary).toContain('+7');
      expect(summary).toContain('-3');
      expect(summary).toContain('src/main.ts');
      expect(summary).toContain('(new)');
      expect(summary).toContain('(deleted)');
    });

    it('should handle empty diff', () => {
      const diff = parseDiffText('');
      expect(summarizeDiff(diff)).toBe('No changes.');
    });
  });

  describe('getFileChanges', () => {
    it('should return added and removed lines for a file', () => {
      const diff = parseDiffText(SAMPLE_DIFF);
      const changes = getFileChanges(diff, 'src/main.ts');
      expect(changes).not.toBeNull();
      expect(changes!.added.length).toBe(2);
      expect(changes!.removed.length).toBe(0);
    });

    it('should return null for non-existent file', () => {
      const diff = parseDiffText(SAMPLE_DIFF);
      const changes = getFileChanges(diff, 'nonexistent.ts');
      expect(changes).toBeNull();
    });

    it('should handle deleted file', () => {
      const diff = parseDiffText(SAMPLE_DIFF);
      const changes = getFileChanges(diff, 'src/old.ts');
      expect(changes).not.toBeNull();
      expect(changes!.removed.length).toBe(3);
      expect(changes!.added.length).toBe(0);
    });
  });
});
