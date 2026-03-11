import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/storage/index.js', () => ({
  getMemoryById: vi.fn(async (id: number) => ({
    id,
    content: 'remember this fact',
  })),
  deleteMemory: vi.fn(async () => true),
  forceDeleteMemory: vi.fn(async () => true),
  deleteMemoriesOlderThan: vi.fn(async () => 3),
  deleteMemoriesByTag: vi.fn(async () => 2),
  closeDb: vi.fn(),
}));

vi.mock('../../helpers.js', () => ({
  projectPathParam: {} as any,
  applyProjectPath: vi.fn(async () => {}),
  parseRelativeDate: vi.fn(() => new Date('2026-01-01T00:00:00.000Z')),
}));

import { deleteMemory, forceDeleteMemory, getMemoryById } from '../../../lib/storage/index.js';
import { registerForgetTool } from './forget.js';

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

describe('forget tool module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers succ_forget', () => {
    const { server, handlers } = createMockServer();
    registerForgetTool(server as any);
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    expect(handlers.has('succ_forget')).toBe(true);
  });

  it('deletes memory by id', async () => {
    const { server, handlers } = createMockServer();
    registerForgetTool(server as any);

    const handler = handlers.get('succ_forget');
    expect(handler).toBeDefined();

    const result = await handler!({
      id: 42,
      project_path: '/tmp/project',
    });

    expect(getMemoryById).toHaveBeenCalledWith(42);
    expect(deleteMemory).toHaveBeenCalledWith(42);
    expect(result.content[0].text).toContain('Forgot memory 42');
  });

  it('returns error when deleting pinned memory without force', async () => {
    const pinnedError = new Error('Memory is pinned');
    pinnedError.name = 'PinnedMemoryError';
    vi.mocked(deleteMemory).mockRejectedValueOnce(pinnedError);

    const { server, handlers } = createMockServer();
    registerForgetTool(server as any);
    const handler = handlers.get('succ_forget')!;

    const result = await handler({ id: 42, project_path: '/tmp/project' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('pinned');
    expect(result.content[0].text).toContain('force=true');
    expect(forceDeleteMemory).not.toHaveBeenCalled();
  });

  it('force-deletes pinned memory via forceDeleteMemory', async () => {
    const pinnedError = new Error('Memory is pinned');
    pinnedError.name = 'PinnedMemoryError';
    vi.mocked(deleteMemory).mockRejectedValueOnce(pinnedError);
    vi.mocked(forceDeleteMemory).mockResolvedValueOnce(true);

    const { server, handlers } = createMockServer();
    registerForgetTool(server as any);
    const handler = handlers.get('succ_forget')!;

    const result = await handler({ id: 42, force: true, project_path: '/tmp/project' });

    expect(forceDeleteMemory).toHaveBeenCalledWith(42);
    expect(deleteMemory).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('Force-deleted pinned memory 42');
    expect(result.isError).toBeUndefined();
  });
});
