import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../config.js', () => ({
  getSuccDir: vi.fn(() => ''),
}));

import {
  ensureDebugsDir,
  generateSessionId,
  saveSession,
  loadSession,
  deleteSession,
  listSessions,
  findActiveSession,
  appendSessionLog,
  loadSessionLog,
} from './state.js';
import type { DebugSession } from './types.js';
import { getSuccDir } from '../config.js';

const mockGetSuccDir = vi.mocked(getSuccDir);

let tmpDir: string;
const origEnv = process.env.SUCC_PROJECT_ROOT;

function makeSession(overrides: Partial<DebugSession> = {}): DebugSession {
  return {
    id: overrides.id ?? generateSessionId(),
    status: 'active',
    bug_description: 'Test bug',
    language: 'typescript',
    hypotheses: [],
    instrumented_files: [],
    iteration: 0,
    max_iterations: 5,
    files_modified: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'succ-debug-state-'));
  const succDir = path.join(tmpDir, '.succ');
  fs.mkdirSync(succDir, { recursive: true });
  process.env.SUCC_PROJECT_ROOT = tmpDir;
  mockGetSuccDir.mockReturnValue(succDir);
});

afterEach(() => {
  process.env.SUCC_PROJECT_ROOT = origEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('generateSessionId', () => {
  it('generates unique IDs with dbg_ prefix', () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();
    expect(id1).toMatch(/^dbg_/);
    expect(id2).toMatch(/^dbg_/);
    expect(id1).not.toBe(id2);
  });
});

describe('ensureDebugsDir', () => {
  it('creates .succ/debugs/ directory', () => {
    ensureDebugsDir();
    const dir = path.join(tmpDir, '.succ', 'debugs');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('is idempotent', () => {
    ensureDebugsDir();
    ensureDebugsDir();
    const dir = path.join(tmpDir, '.succ', 'debugs');
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('saveSession / loadSession', () => {
  it('round-trips a session', () => {
    const session = makeSession();
    saveSession(session);

    const loaded = loadSession(session.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(session.id);
    expect(loaded!.bug_description).toBe('Test bug');
    expect(loaded!.language).toBe('typescript');
  });

  it('updates updated_at on save', () => {
    const session = makeSession();
    session.updated_at = '2020-01-01T00:00:00Z';
    saveSession(session);

    const loaded = loadSession(session.id);
    expect(loaded!.updated_at).not.toBe('2020-01-01T00:00:00Z');
  });

  it('preserves hypotheses', () => {
    const session = makeSession();
    session.hypotheses = [
      { id: 1, description: 'Race condition', confidence: 'high', evidence: 'intermittent', test: 'add logs', result: 'pending' },
    ];
    saveSession(session);

    const loaded = loadSession(session.id);
    expect(loaded!.hypotheses).toHaveLength(1);
    expect(loaded!.hypotheses[0].description).toBe('Race condition');
  });

  it('preserves instrumented_files', () => {
    const session = makeSession();
    session.instrumented_files = [
      { path: 'src/auth.ts', lines: [10, 20, 30] },
    ];
    saveSession(session);

    const loaded = loadSession(session.id);
    expect(loaded!.instrumented_files).toHaveLength(1);
    expect(loaded!.instrumented_files[0].lines).toEqual([10, 20, 30]);
  });

  it('returns null for non-existent session', () => {
    ensureDebugsDir();
    expect(loadSession('dbg_nonexistent')).toBeNull();
  });
});

describe('deleteSession', () => {
  it('removes session directory and index entry', () => {
    const session = makeSession();
    saveSession(session);
    expect(loadSession(session.id)).not.toBeNull();

    deleteSession(session.id);
    expect(loadSession(session.id)).toBeNull();

    const dir = path.join(tmpDir, '.succ', 'debugs', session.id);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('handles deleting non-existent session', () => {
    ensureDebugsDir();
    expect(() => deleteSession('dbg_nope')).not.toThrow();
  });
});

describe('listSessions', () => {
  it('returns active sessions', () => {
    saveSession(makeSession({ id: 'dbg_a1' }));
    saveSession(makeSession({ id: 'dbg_a2' }));
    saveSession(makeSession({ id: 'dbg_r1', status: 'resolved' }));

    const active = listSessions(false);
    expect(active).toHaveLength(2);
    expect(active.map(s => s.id)).toContain('dbg_a1');
    expect(active.map(s => s.id)).toContain('dbg_a2');
  });

  it('returns all sessions when includeResolved=true', () => {
    saveSession(makeSession({ id: 'dbg_all1' }));
    saveSession(makeSession({ id: 'dbg_all2', status: 'resolved' }));
    saveSession(makeSession({ id: 'dbg_all3', status: 'abandoned' }));

    const all = listSessions(true);
    expect(all).toHaveLength(3);
  });

  it('returns empty array when no sessions', () => {
    ensureDebugsDir();
    expect(listSessions()).toEqual([]);
  });
});

describe('findActiveSession', () => {
  it('returns most recently updated active session', () => {
    const s1 = makeSession({ id: 'dbg_old' });
    s1.updated_at = '2025-01-01T00:00:00Z';
    saveSession(s1);

    const s2 = makeSession({ id: 'dbg_new' });
    s2.updated_at = '2025-06-01T00:00:00Z';
    saveSession(s2);

    const active = findActiveSession();
    expect(active).not.toBeNull();
    expect(active!.id).toBe('dbg_new');
  });

  it('returns null when no active sessions', () => {
    saveSession(makeSession({ id: 'dbg_done', status: 'resolved' }));
    expect(findActiveSession()).toBeNull();
  });

  it('returns null when no sessions at all', () => {
    ensureDebugsDir();
    expect(findActiveSession()).toBeNull();
  });
});

describe('appendSessionLog / loadSessionLog', () => {
  it('appends timestamped entries', () => {
    const session = makeSession();
    saveSession(session);

    appendSessionLog(session.id, 'First entry');
    appendSessionLog(session.id, 'Second entry');

    const log = loadSessionLog(session.id);
    expect(log).toContain('First entry');
    expect(log).toContain('Second entry');
    // Check timestamp format [YYYY-MM-DD HH:MM:SS]
    expect(log).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/);
  });

  it('returns empty string for session without log', () => {
    const session = makeSession();
    saveSession(session);
    expect(loadSessionLog(session.id)).toBe('');
  });
});
