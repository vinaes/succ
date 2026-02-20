import { describe, it, expect } from 'vitest';
import { detectLanguage, generateLogStatement, sessionToIndexEntry } from './types.js';
import type { DebugSession } from './types.js';

describe('detectLanguage', () => {
  it('detects TypeScript', () => {
    expect(detectLanguage('src/index.ts')).toBe('typescript');
    expect(detectLanguage('App.tsx')).toBe('typescript');
  });

  it('detects JavaScript', () => {
    expect(detectLanguage('main.js')).toBe('javascript');
    expect(detectLanguage('config.mjs')).toBe('javascript');
  });

  it('detects Python', () => {
    expect(detectLanguage('app.py')).toBe('python');
  });

  it('detects Go', () => {
    expect(detectLanguage('main.go')).toBe('go');
  });

  it('detects Rust', () => {
    expect(detectLanguage('lib.rs')).toBe('rust');
  });

  it('handles case-insensitive extensions', () => {
    expect(detectLanguage('FILE.TS')).toBe('typescript');
    expect(detectLanguage('main.PY')).toBe('python');
  });

  it('returns unknown for unrecognized extensions', () => {
    expect(detectLanguage('data.csv')).toBe('unknown');
    expect(detectLanguage('image.png')).toBe('unknown');
    expect(detectLanguage('Makefile')).toBe('unknown');
  });

  it('handles full paths', () => {
    expect(detectLanguage('/home/user/project/src/auth.ts')).toBe('typescript');
    expect(detectLanguage('C:\\dev\\project\\main.go')).toBe('go');
  });
});

describe('generateLogStatement', () => {
  it('replaces {tag} and {value} in template', () => {
    const result = generateLogStatement('typescript', 'h1-check', 'config.token');
    expect(result).toBe("console.error('[SUCC_DEBUG] h1-check:', config.token);");
  });

  it('works for Python', () => {
    const result = generateLogStatement('python', 'h2-null', 'user_id');
    expect(result).toContain('[SUCC_DEBUG] h2-null');
    expect(result).toContain('user_id');
  });

  it('works for Go', () => {
    const result = generateLogStatement('go', 'test', 'err');
    expect(result).toContain('[SUCC_DEBUG] test');
    expect(result).toContain('err');
  });

  it('works for unknown language (comment)', () => {
    const result = generateLogStatement('unknown', 'debug', 'x');
    expect(result).toContain('//');
    expect(result).toContain('[SUCC_DEBUG]');
  });

  it('handles multiple {tag} occurrences', () => {
    // Some templates might have {tag} once or twice
    const result = generateLogStatement('c', 'my-tag', 'my_var');
    expect(result).toContain('my-tag');
    expect(result).toContain('my_var');
    expect(result).not.toContain('{tag}');
    expect(result).not.toContain('{value}');
  });
});

describe('sessionToIndexEntry', () => {
  it('converts session to index entry', () => {
    const session: DebugSession = {
      id: 'dbg_test_123',
      status: 'active',
      bug_description: 'Tests fail with ECONNREFUSED on CI',
      language: 'typescript',
      hypotheses: [
        {
          id: 1,
          description: 'Port conflict',
          confidence: 'high',
          evidence: '',
          test: '',
          result: 'pending',
        },
        {
          id: 2,
          description: 'Missing env var',
          confidence: 'medium',
          evidence: '',
          test: '',
          result: 'refuted',
        },
      ],
      instrumented_files: [],
      iteration: 1,
      max_iterations: 5,
      files_modified: [],
      created_at: '2025-06-01T12:00:00Z',
      updated_at: '2025-06-01T12:05:00Z',
    };

    const entry = sessionToIndexEntry(session);

    expect(entry.id).toBe('dbg_test_123');
    expect(entry.status).toBe('active');
    expect(entry.language).toBe('typescript');
    expect(entry.hypothesis_count).toBe(2);
    expect(entry.iteration).toBe(1);
    expect(entry.created_at).toBe('2025-06-01T12:00:00Z');
    expect(entry.updated_at).toBe('2025-06-01T12:05:00Z');
  });

  it('truncates long bug descriptions to 200 chars', () => {
    const session: DebugSession = {
      id: 'dbg_long',
      status: 'active',
      bug_description: 'A'.repeat(300),
      language: 'python',
      hypotheses: [],
      instrumented_files: [],
      iteration: 0,
      max_iterations: 5,
      files_modified: [],
      created_at: '2025-06-01T12:00:00Z',
      updated_at: '2025-06-01T12:00:00Z',
    };

    const entry = sessionToIndexEntry(session);
    expect(entry.bug_description.length).toBe(200);
  });
});
