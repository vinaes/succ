import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/storage/index.js', () => ({
  getMemoryById: vi.fn(async (id: number) => ({
    id,
    content: 'remember this fact',
  })),
  deleteMemory: vi.fn(async () => true),
  deleteMemoriesOlderThan: vi.fn(async () => 3),
  deleteMemoriesByTag: vi.fn(async () => 2),
  closeDb: vi.fn(),
}));

vi.mock('../../helpers.js', () => ({
  projectPathParam: {} as any,
  applyProjectPath: vi.fn(async () => {}),
  parseRelativeDate: vi.fn(() => new Date('2026-01-01T00:00:00.000Z')),
}));

import { deleteMemory, getMemoryById } from '../../../lib/storage/index.js';
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
});
