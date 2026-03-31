import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/storage/index.js', () => ({
  createMemoryLink: vi.fn(async () => ({ id: 7, created: true })),
  deleteMemoryLink: vi.fn(async () => true),
  getMemoryWithLinks: vi.fn(async () => null),
  findConnectedMemories: vi.fn(async () => []),
  autoLinkSimilarMemories: vi.fn(async () => 3),
  getGraphStats: vi.fn(async () => ({
    total_memories: 4,
    total_links: 2,
    avg_links_per_memory: 0.5,
    isolated_memories: 1,
    relations: { related: 2 },
  })),
  getMemoryById: vi.fn(async () => ({
    id: 1,
    content: 'Fallback memory content',
    tags: [],
    created_at: new Date('2026-02-20T00:00:00.000Z').toISOString(),
  })),
  LINK_RELATIONS: ['related', 'caused_by', 'references'],
  closeDb: vi.fn(),
  getStorageDispatcher: vi.fn(async () => ({ flushSessionCounters: vi.fn() })),
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

import { registerGraphTools } from './graph.js';
import {
  createMemoryLink,
  getMemoryWithLinks,
  getGraphStats,
  findConnectedMemories,
  closeDb,
} from '../../lib/storage/index.js';

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

describe('graph tool module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createMemoryLink).mockResolvedValue({ id: 7, created: true });
    vi.mocked(getMemoryWithLinks).mockResolvedValue(null);
    vi.mocked(findConnectedMemories).mockResolvedValue([]);
  });

  it('registers succ_link', () => {
    const { server, handlers } = createMockServer();
    registerGraphTools(server as any);
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    expect(handlers.has('succ_link')).toBe(true);
  });

  it('returns validation message when create is missing ids', async () => {
    const { server, handlers } = createMockServer();
    registerGraphTools(server as any);
    const handler = handlers.get('succ_link')!;

    const result = await handler({ action: 'create', source_id: 1 });
    expect(result.content[0].text).toContain('source_id and target_id are required');
  });

  it('creates a link on happy path', async () => {
    const { server, handlers } = createMockServer();
    registerGraphTools(server as any);
    const handler = handlers.get('succ_link')!;

    const result = await handler({
      action: 'create',
      source_id: 1,
      target_id: 2,
      relation: 'related',
    });

    expect(createMemoryLink).toHaveBeenCalledWith(1, 2, 'related');
    expect(result.content[0].text).toContain('Created link');
    expect(closeDb).toHaveBeenCalled();
  });

  it('returns not-found for show when memory does not exist', async () => {
    const { server, handlers } = createMockServer();
    registerGraphTools(server as any);
    const handler = handlers.get('succ_link')!;

    const result = await handler({ action: 'show', source_id: 99 });
    expect(result.content[0].text).toContain('not found');
  });

  it('formats graph stats for action=graph', async () => {
    const { server, handlers } = createMockServer();
    registerGraphTools(server as any);
    const handler = handlers.get('succ_link')!;

    const result = await handler({ action: 'graph' });

    expect(getGraphStats).toHaveBeenCalled();
    expect(result.content[0].text).toContain('Knowledge Graph Statistics');
    expect(result.content[0].text).toContain('Memories: 4');
  });

  it('handles unexpected storage errors', async () => {
    vi.mocked(createMemoryLink).mockRejectedValueOnce(new Error('db offline'));

    const { server, handlers } = createMockServer();
    registerGraphTools(server as any);
    const handler = handlers.get('succ_link')!;

    const result = await handler({ action: 'create', source_id: 1, target_id: 2 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('db offline');
  });
});
