import { describe, it, expect } from 'vitest';
import { extractCodePaths, inferBridgeRelation } from './bridge-edges.js';

describe('bridge-edges', () => {
  describe('extractCodePaths', () => {
    it('should extract file paths from content', () => {
      const content = 'Fixed auth bug in src/lib/auth.ts and updated src/lib/config.ts';
      const refs = extractCodePaths(content);
      expect(refs).toHaveLength(2);
      expect(refs[0].path).toBe('src/lib/auth.ts');
      expect(refs[1].path).toBe('src/lib/config.ts');
    });

    it('should extract paths with line numbers', () => {
      const content = 'Error at src/lib/storage/index.ts:42';
      const refs = extractCodePaths(content);
      expect(refs).toHaveLength(1);
      expect(refs[0].path).toBe('src/lib/storage/index.ts');
      expect(refs[0].lineRange).toEqual([42, 42]);
    });

    it('should extract paths in backticks', () => {
      const content = 'The file `src/mcp/tools/graph.ts` handles graph operations';
      const refs = extractCodePaths(content);
      expect(refs).toHaveLength(1);
      expect(refs[0].path).toBe('src/mcp/tools/graph.ts');
    });

    it('should extract relative paths (normalized, leading ./ stripped)', () => {
      const content = 'See ./components/Button.tsx for the component';
      const refs = extractCodePaths(content);
      expect(refs).toHaveLength(1);
      // Leading ./ is stripped during extraction so includes() comparisons
      // work correctly against paths stored without it.
      expect(refs[0].path).toBe('components/Button.tsx');
    });

    it('should ignore non-code extensions', () => {
      const content = 'Downloaded from path/to/file.zip and path/to/image.png';
      const refs = extractCodePaths(content);
      expect(refs).toHaveLength(0);
    });

    it('should deduplicate paths', () => {
      const content = 'File src/lib/auth.ts is used by src/lib/auth.ts for auth';
      const refs = extractCodePaths(content);
      expect(refs).toHaveLength(1);
    });

    it('should handle empty content', () => {
      expect(extractCodePaths('')).toHaveLength(0);
    });

    it('should handle content with no paths', () => {
      expect(extractCodePaths('Just some regular text with no file paths')).toHaveLength(0);
    });

    it('should extract multiple path formats', () => {
      const content = [
        'Modified src/lib/auth.ts',
        'Also `lib/storage/index.ts`',
        'And ./components/Header.vue',
        'Python file scripts/deploy.py',
      ].join('\n');
      const refs = extractCodePaths(content);
      expect(refs.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('inferBridgeRelation', () => {
    it('should detect bug-related content', () => {
      expect(inferBridgeRelation('Fixed a bug in the auth module', [])).toBe('bug_in');
      expect(inferBridgeRelation('Memory content', ['error'])).toBe('bug_in');
      expect(inferBridgeRelation('Crash when loading', ['debug'])).toBe('bug_in');
    });

    it('should detect test-related content', () => {
      expect(inferBridgeRelation('Added unit tests for auth', [])).toBe('test_covers');
      expect(inferBridgeRelation('Memory content', ['test'])).toBe('test_covers');
      expect(inferBridgeRelation('Vitest mock for storage', [])).toBe('test_covers');
    });

    it('should detect motivates relation', () => {
      expect(inferBridgeRelation('Architecture decision for caching', [])).toBe('motivates');
      expect(inferBridgeRelation('Memory content', ['pattern'])).toBe('motivates');
      expect(inferBridgeRelation('Design approach for auth flow', [])).toBe('motivates');
    });

    it('should default to documents', () => {
      expect(inferBridgeRelation('Updated the config handler', [])).toBe('documents');
      expect(inferBridgeRelation('General note about the project', [])).toBe('documents');
    });

    it('should prioritize bug over test', () => {
      // Bug keywords take precedence
      expect(inferBridgeRelation('Test failure caused by bug', [])).toBe('bug_in');
    });
  });
});
