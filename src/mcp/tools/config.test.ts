import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExistsSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync, mockStatSync } =
  vi.hoisted(() => ({
    mockExistsSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockMkdirSync: vi.fn(),
    mockStatSync: vi.fn(() => ({ size: 2048 })),
  }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: mockExistsSync,
      readFileSync: mockReadFileSync,
      writeFileSync: mockWriteFileSync,
      mkdirSync: mockMkdirSync,
      statSync: mockStatSync,
    },
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    statSync: mockStatSync,
  };
});

vi.mock('../profile.js', () => ({
  gateAction: vi.fn(() => null),
}));

vi.mock('../../lib/storage/index.js', () => ({
  closeDb: vi.fn(),
  closeStorageDispatcher: vi.fn(async () => {}),
}));

vi.mock('../../lib/config.js', () => ({
  getSuccDir: vi.fn(() => '/project/.succ'),
  getConfigDisplay: vi.fn(() => ({ tool_profile: 'full' })),
  formatConfigDisplay: vi.fn(() => 'tool_profile = full'),
}));

vi.mock('../../lib/checkpoint.js', () => ({
  createCheckpoint: vi.fn(async () => ({
    checkpoint: {
      project_name: 'demo',
      stats: {
        memories_count: 10,
        documents_count: 5,
        links_count: 2,
        centrality_count: 1,
        brain_files_count: 3,
      },
    },
    outputPath: '/tmp/demo.succ-checkpoint.json',
  })),
  listCheckpoints: vi.fn(() => []),
  formatSize: vi.fn(() => '2 KB'),
}));

vi.mock('../helpers.js', () => ({
  projectPathParam: {} as any,
  applyProjectPath: vi.fn(async () => {}),
  createToolResponse: (text: string) => ({ content: [{ type: 'text' as const, text }] }),
  createErrorResponse: (text: string) => ({
    content: [{ type: 'text' as const, text }],
    isError: true,
  }),
}));

import path from 'path';
import { registerConfigTools } from './config.js';
import { gateAction } from '../profile.js';
import { closeDb, closeStorageDispatcher } from '../../lib/storage/index.js';

type ToolHandler = (args: Record<string, any>) => Promise<any>;

function createMockServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: vi.fn((name: string, _config: any, handler: ToolHandler) => {
      handlers.set(name, handler);
    }),
  };
  return { server, handlers };
}

describe('config tool module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(gateAction).mockReturnValue(null);
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('{}');
  });

  it('registers succ_config', () => {
    const { server, handlers } = createMockServer();
    registerConfigTools(server as any);
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    expect(handlers.has('succ_config')).toBe(true);
  });

  it('returns gated response when action is blocked', async () => {
    vi.mocked(gateAction).mockReturnValue({
      content: [{ type: 'text', text: 'blocked' }],
      isError: true,
    } as any);

    const { server, handlers } = createMockServer();
    registerConfigTools(server as any);
    const handler = handlers.get('succ_config')!;

    const result = await handler({ action: 'checkpoint_create' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('blocked');
  });

  it('shows formatted config on action=show', async () => {
    const { server, handlers } = createMockServer();
    registerConfigTools(server as any);
    const handler = handlers.get('succ_config')!;

    const result = await handler({ action: 'show' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('tool_profile = full');
  });

  it('validates required key/value for action=set', async () => {
    const { server, handlers } = createMockServer();
    registerConfigTools(server as any);
    const handler = handlers.get('succ_config')!;

    const result = await handler({ action: 'set', key: 'llm.api_key' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('required');
  });

  it('writes project config with nested boolean values', async () => {
    mockExistsSync.mockImplementation((targetPath: string) => targetPath === '/project/.succ');

    const { server, handlers } = createMockServer();
    registerConfigTools(server as any);
    const handler = handlers.get('succ_config')!;

    const result = await handler({
      action: 'set',
      scope: 'project',
      key: 'idle_reflection.enabled',
      value: 'true',
    });

    expect(result.isError).toBeUndefined();
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const [writtenPath, payload] = mockWriteFileSync.mock.calls[0] as [string, string];
    expect(writtenPath).toBe(path.join('/project/.succ', 'config.json'));
    const parsed = JSON.parse(payload);
    expect(parsed.idle_reflection.enabled).toBe(true);
  });

  it('lists empty checkpoints message and closes db', async () => {
    const { server, handlers } = createMockServer();
    registerConfigTools(server as any);
    const handler = handlers.get('succ_config')!;

    const result = await handler({ action: 'checkpoint_list' });

    expect(result.content[0].text).toContain('No checkpoints found');
    expect(closeDb).toHaveBeenCalled();
    expect(closeStorageDispatcher).not.toHaveBeenCalled();
  });
});
