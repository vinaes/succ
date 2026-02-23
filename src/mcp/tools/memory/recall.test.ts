import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/storage/index.js', () => ({
  hybridSearchMemories: vi.fn(async () => []),
  hybridSearchGlobalMemories: vi.fn(async () => []),
  getRecentMemories: vi.fn(async () => [
    {
      id: 1,
      content: 'recent local memory',
      tags: ['local'],
      source: 'unit',
      created_at: new Date('2026-02-20T00:00:00.000Z').toISOString(),
    },
  ]),
  getRecentGlobalMemories: vi.fn(async () => [
    {
      id: 2,
      content: 'recent global memory',
      tags: ['global'],
      source: 'unit',
      created_at: new Date('2026-02-21T00:00:00.000Z').toISOString(),
      project: 'demo',
    },
  ]),
  closeDb: vi.fn(),
  closeGlobalDb: vi.fn(),
}));

vi.mock('../../../lib/config.js', () => ({
  isGlobalOnlyMode: vi.fn(() => false),
  getReadinessGateConfig: vi.fn(() => ({ enabled: false })),
  getRetrievalConfig: vi.fn(() => ({
    default_top_k: 10,
    bm25_alpha: 0.4,
    temporal_auto_skip: true,
    quality_boost_enabled: false,
    quality_boost_weight: 0.15,
    mmr_enabled: false,
    mmr_lambda: 0.7,
    query_expansion_enabled: false,
  })),
  getConfig: vi.fn(() => ({ dead_end_boost: 0 })),
}));

vi.mock('../../../lib/embeddings.js', () => ({
  getEmbedding: vi.fn(async () => [0.1, 0.2]),
}));

vi.mock('../../../lib/temporal.js', () => ({
  applyTemporalScoring: vi.fn((items: any[]) => items),
  getTemporalConfig: vi.fn(() => ({ enabled: false })),
}));

vi.mock('../../../lib/readiness.js', () => ({
  assessReadiness: vi.fn(() => ({})),
  formatReadinessHeader: vi.fn(() => ''),
}));

vi.mock('../../../lib/fault-logger.js', () => ({
  logWarn: vi.fn(),
}));

vi.mock('../../helpers.js', () => ({
  projectPathParam: {} as any,
  applyProjectPath: vi.fn(async () => {}),
  trackTokenSavings: vi.fn(async () => {}),
  trackMemoryAccess: vi.fn(async () => {}),
  extractAnswerFromResults: vi.fn(async () => 'answer'),
}));

vi.mock('./temporal-query.js', () => ({
  extractTemporalSubqueriesAsync: vi.fn(async (q: string) => [q]),
}));

import { getRecentMemories, getRecentGlobalMemories } from '../../../lib/storage/index.js';
import { registerRecallTool } from './recall.js';

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

describe('recall tool module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers succ_recall', () => {
    const { server, handlers } = createMockServer();
    registerRecallTool(server as any);
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    expect(handlers.has('succ_recall')).toBe(true);
  });

  it('returns recent memories for wildcard query', async () => {
    const { server, handlers } = createMockServer();
    registerRecallTool(server as any);

    const handler = handlers.get('succ_recall');
    expect(handler).toBeDefined();

    const result = await handler!({
      query: '*',
      limit: 2,
      project_path: '/tmp/project',
    });

    expect(getRecentMemories).toHaveBeenCalledWith(2);
    expect(getRecentGlobalMemories).toHaveBeenCalledWith(2);
    expect(result.content[0].text).toContain('recent local memory');
  });
});
