import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock helpers and config BEFORE imports
vi.mock('../helpers.js', () => ({
  projectPathParam: {} as any,
  applyProjectPath: vi.fn(async () => {}),
}));

vi.mock('../../lib/config.js', () => ({
  isGlobalOnlyMode: vi.fn(() => false),
  getSuccDir: vi.fn(() => ''),
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDebugTools } from './debug.js';
import { loadSession, listSessions, generateSessionId } from '../../lib/debug/state.js';
import type { DebugSession } from '../../lib/debug/types.js';
import { getSuccDir } from '../../lib/config.js';

const mockGetSuccDir = vi.mocked(getSuccDir);

let tmpDir: string;
const origEnv = process.env.SUCC_PROJECT_ROOT;

// Capture registered tools
type ToolHandler = (params: Record<string, any>) => Promise<any>;
const tools = new Map<string, { handler: ToolHandler; description: string }>();

function createMockServer(): McpServer {
  const mockServer = {
    tool: vi.fn((name: string, description: string, schema: any, handler: ToolHandler) => {
      tools.set(name, { handler, description });
    }),
  } as unknown as McpServer;
  return mockServer;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

async function callTool(name: string, params: Record<string, any>) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.handler({ ...params, project_path: tmpDir });
}

beforeEach(() => {
  tools.clear();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'succ-debug-mcp-'));
  const succDir = path.join(tmpDir, '.succ');
  fs.mkdirSync(succDir, { recursive: true });
  process.env.SUCC_PROJECT_ROOT = tmpDir;
  mockGetSuccDir.mockReturnValue(succDir);

  const server = createMockServer();
  registerDebugTools(server);
});

afterEach(() => {
  process.env.SUCC_PROJECT_ROOT = origEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('registerDebugTools', () => {
  it('registers succ_debug tool', () => {
    expect(tools.has('succ_debug')).toBe(true);
  });
});

describe('succ_debug: create', () => {
  it('creates a debug session', async () => {
    const result = await callTool('succ_debug', {
      action: 'create',
      bug_description: 'Tests fail with ECONNREFUSED',
      reproduction_command: 'npm test',
      language: 'typescript',
    });

    expect(result.content[0].text).toContain('Debug session created');
    expect(result.content[0].text).toContain('ECONNREFUSED');
    expect(result.isError).toBeUndefined();
  });

  it('requires bug_description', async () => {
    const result = await callTool('succ_debug', { action: 'create' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('bug_description is required');
  });

  it('persists session to disk', async () => {
    await callTool('succ_debug', {
      action: 'create',
      bug_description: 'Disk test',
      language: 'python',
    });

    const sessions = listSessions(true);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].language).toBe('python');
  });
});

describe('succ_debug: hypothesis', () => {
  it('adds hypothesis to active session', async () => {
    await callTool('succ_debug', { action: 'create', bug_description: 'Bug' });

    const result = await callTool('succ_debug', {
      action: 'hypothesis',
      description: 'Race condition in handler',
      confidence: 'high',
      evidence: 'Intermittent failures',
      test: 'Add timestamp logs',
    });

    expect(result.content[0].text).toContain('Hypothesis #1');
    expect(result.content[0].text).toContain('high');
  });

  it('requires description', async () => {
    await callTool('succ_debug', { action: 'create', bug_description: 'Bug' });
    const result = await callTool('succ_debug', { action: 'hypothesis' });
    expect(result.isError).toBe(true);
  });

  it('returns error when no active session', async () => {
    const result = await callTool('succ_debug', {
      action: 'hypothesis',
      description: 'Orphan hypothesis',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No active debug session');
  });
});

describe('succ_debug: instrument', () => {
  it('records instrumented file', async () => {
    await callTool('succ_debug', { action: 'create', bug_description: 'Bug' });

    const result = await callTool('succ_debug', {
      action: 'instrument',
      file_path: 'src/auth.ts',
      lines: [10, 20, 30],
    });

    expect(result.content[0].text).toContain('src/auth.ts');
    expect(result.content[0].text).toContain('10, 20, 30');
  });

  it('merges lines for same file', async () => {
    await callTool('succ_debug', { action: 'create', bug_description: 'Bug' });
    await callTool('succ_debug', { action: 'instrument', file_path: 'src/x.ts', lines: [1, 2] });
    await callTool('succ_debug', { action: 'instrument', file_path: 'src/x.ts', lines: [3, 4] });

    const sessions = listSessions(true);
    const session = loadSession(sessions[0].id)!;
    expect(session.instrumented_files).toHaveLength(1);
    expect(session.instrumented_files[0].lines).toEqual(expect.arrayContaining([1, 2, 3, 4]));
  });
});

describe('succ_debug: result', () => {
  it('marks hypothesis as confirmed', async () => {
    await callTool('succ_debug', { action: 'create', bug_description: 'Bug' });
    await callTool('succ_debug', { action: 'hypothesis', description: 'H1' });

    const result = await callTool('succ_debug', {
      action: 'result',
      hypothesis_id: 1,
      confirmed: true,
      logs: 'output confirms race condition',
    });

    expect(result.content[0].text).toContain('CONFIRMED');
  });

  it('marks hypothesis as refuted and suggests dead_end', async () => {
    await callTool('succ_debug', { action: 'create', bug_description: 'Bug' });
    await callTool('succ_debug', { action: 'hypothesis', description: 'Wrong theory' });

    const result = await callTool('succ_debug', {
      action: 'result',
      hypothesis_id: 1,
      confirmed: false,
    });

    expect(result.content[0].text).toContain('REFUTED');
    expect(result.content[0].text).toContain('succ_dead_end');
  });

  it('increments iteration count', async () => {
    await callTool('succ_debug', { action: 'create', bug_description: 'Bug' });
    await callTool('succ_debug', { action: 'hypothesis', description: 'H1' });
    await callTool('succ_debug', { action: 'result', hypothesis_id: 1, confirmed: false });

    const sessions = listSessions(true);
    const session = loadSession(sessions[0].id)!;
    expect(session.iteration).toBe(1);
  });
});

describe('succ_debug: resolve', () => {
  it('resolves session with root cause and fix', async () => {
    await callTool('succ_debug', { action: 'create', bug_description: 'Bug' });

    const result = await callTool('succ_debug', {
      action: 'resolve',
      root_cause: 'Missing null check on config.token',
      fix_description: 'Added guard clause at line 42',
      files_modified: ['src/auth.ts'],
    });

    expect(result.content[0].text).toContain('resolved');
    expect(result.content[0].text).toContain('Missing null check');
    expect(result.content[0].text).toContain('src/auth.ts');
  });

  it('sets status to resolved', async () => {
    await callTool('succ_debug', { action: 'create', bug_description: 'Bug' });
    await callTool('succ_debug', { action: 'resolve', root_cause: 'Found it' });

    const sessions = listSessions(true);
    expect(sessions[0].status).toBe('resolved');
  });
});

describe('succ_debug: abandon', () => {
  it('abandons session', async () => {
    await callTool('succ_debug', { action: 'create', bug_description: 'Bug' });

    const result = await callTool('succ_debug', { action: 'abandon' });
    expect(result.content[0].text).toContain('abandoned');

    const sessions = listSessions(true);
    expect(sessions[0].status).toBe('abandoned');
  });
});

describe('succ_debug: status', () => {
  it('shows active session status', async () => {
    await callTool('succ_debug', { action: 'create', bug_description: 'Memory leak in worker' });
    await callTool('succ_debug', {
      action: 'hypothesis',
      description: 'Unbounded cache',
      confidence: 'high',
    });

    const result = await callTool('succ_debug', { action: 'status' });

    expect(result.content[0].text).toContain('Memory leak in worker');
    expect(result.content[0].text).toContain('Unbounded cache');
    expect(result.content[0].text).toContain('high');
  });

  it('returns error when no active session', async () => {
    const result = await callTool('succ_debug', { action: 'status' });
    expect(result.isError).toBe(true);
  });
});

describe('succ_debug: list', () => {
  it('lists active sessions', async () => {
    await callTool('succ_debug', { action: 'create', bug_description: 'Bug A' });
    await callTool('succ_debug', { action: 'resolve', root_cause: 'done' });
    await callTool('succ_debug', { action: 'create', bug_description: 'Bug B' });

    const result = await callTool('succ_debug', { action: 'list' });
    expect(result.content[0].text).toContain('Bug B');
    expect(result.content[0].text).not.toContain('Bug A');
  });

  it('lists all sessions with include_resolved', async () => {
    await callTool('succ_debug', { action: 'create', bug_description: 'Bug A' });
    await callTool('succ_debug', { action: 'resolve', root_cause: 'done' });
    await callTool('succ_debug', { action: 'create', bug_description: 'Bug B' });

    const result = await callTool('succ_debug', { action: 'list', include_resolved: true });
    expect(result.content[0].text).toContain('Bug A');
    expect(result.content[0].text).toContain('Bug B');
  });
});

describe('succ_debug: log / show_log', () => {
  it('appends and retrieves log entries', async () => {
    await callTool('succ_debug', { action: 'create', bug_description: 'Bug' });
    await callTool('succ_debug', { action: 'log', entry: 'Tried adding timeout' });
    await callTool('succ_debug', { action: 'log', entry: 'Increased to 5000ms' });

    const result = await callTool('succ_debug', { action: 'show_log' });
    expect(result.content[0].text).toContain('Tried adding timeout');
    expect(result.content[0].text).toContain('Increased to 5000ms');
  });
});

describe('succ_debug: detect_lang', () => {
  it('detects language from file path', async () => {
    const result = await callTool('succ_debug', {
      action: 'detect_lang',
      file_path: 'src/main.rs',
    });
    expect(result.content[0].text).toContain('rust');
  });

  it('requires file_path', async () => {
    const result = await callTool('succ_debug', { action: 'detect_lang' });
    expect(result.isError).toBe(true);
  });
});

describe('succ_debug: gen_log', () => {
  it('generates log statement for language', async () => {
    const result = await callTool('succ_debug', {
      action: 'gen_log',
      language: 'python',
      tag: 'h1-check',
      value: 'user_id',
    });
    expect(result.content[0].text).toContain('[SUCC_DEBUG]');
    expect(result.content[0].text).toContain('h1-check');
    expect(result.content[0].text).toContain('user_id');
  });
});
