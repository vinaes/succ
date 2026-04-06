import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../profile.js', () => ({
  gateAction: vi.fn(() => null),
}));

vi.mock('../../lib/storage/index.js', () => ({
  getStats: vi.fn(async () => ({
    total_documents: 12,
    total_files: 3,
    last_indexed: '2026-02-20T00:00:00.000Z',
  })),
  getRecentGlobalMemories: vi.fn(async () => []),
  getMemoryStats: vi.fn(async () => ({
    total_memories: 5,
    by_type: { observation: 5 },
    oldest_memory: null,
    newest_memory: null,
    stale_count: 0,
  })),
  getAllMemoriesForRetention: vi.fn(async () => []),
  getStaleFileCount: vi.fn(async () => ({ stale: 0, deleted: 0, total: 0 })),
  getTokenStatsAggregated: vi.fn(async () => []),
  getWebSearchSummary: vi.fn(async () => ({
    total_searches: 0,
    total_cost_usd: 0,
    today_searches: 0,
    today_cost_usd: 0,
    by_tool: {},
  })),
  getStorageDispatcher: vi.fn(async () => ({
    getSessionCounters: () => ({
      startedAt: new Date('2026-02-20T10:00:00.000Z').toISOString(),
      memoriesCreated: 0,
      globalMemoriesCreated: 0,
      memoriesDuplicated: 0,
      recallQueries: 0,
      searchQueries: 0,
      codeSearchQueries: 0,
      webSearchQueries: 0,
      webSearchCostUsd: 0,
      typesCreated: {},
    }),
  })),
  closeDb: vi.fn(),
}));

vi.mock('../../lib/config.js', () => ({
  getErrorReportingConfig: vi.fn().mockReturnValue({ enabled: false }),
  getDaemonStatuses: vi.fn(async () => [{ name: 'daemon', running: false }]),
  isGlobalOnlyMode: vi.fn(() => false),
  getIdleReflectionConfig: vi.fn(() => ({ operations: { session_summary: true } })),
  getRetentionConfig: vi.fn(() => ({
    use_temporal_decay: true,
    keep_threshold: 0.4,
    delete_threshold: 0.2,
  })),
  getProjectRoot: vi.fn(() => '/project'),
  getConfig: vi.fn(() => ({ md_api_url: 'https://md.succ.ai' })),
}));

vi.mock('../../lib/token-counter.js', () => ({
  formatTokens: vi.fn((n: number) => `${n} tokens`),
  compressionPercent: vi.fn(() => '80%'),
}));

vi.mock('../../lib/retention.js', () => ({
  analyzeRetention: vi.fn(() => ({
    stats: {
      keepCount: 0,
      warnCount: 0,
      deleteCount: 0,
      avgEffectiveScore: 0,
    },
  })),
}));

vi.mock('../../lib/fault-logger.js', () => ({
  logWarn: vi.fn(),
}));

vi.mock('../../lib/ai-readiness.js', () => ({
  calculateAIReadinessScore: vi.fn(async () => ({ score: 88 })),
  formatAIReadinessScore: vi.fn(() => 'AI Readiness: 88/100'),
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

import { registerStatusTools } from './status.js';
import { gateAction } from '../profile.js';
import { isGlobalOnlyMode } from '../../lib/config.js';
import { getTokenStatsAggregated, closeDb } from '../../lib/storage/index.js';

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

describe('status tool module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(gateAction).mockReturnValue(null);
    vi.mocked(isGlobalOnlyMode).mockReturnValue(false);
    vi.mocked(getTokenStatsAggregated).mockResolvedValue([]);
  });

  it('registers succ_status', () => {
    const { server, handlers } = createMockServer();
    registerStatusTools(server as any);
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    expect(handlers.has('succ_status')).toBe(true);
  });

  it('returns gated response when action is blocked', async () => {
    vi.mocked(gateAction).mockReturnValue({
      content: [{ type: 'text', text: 'forbidden by profile' }],
      isError: true,
    } as any);

    const { server, handlers } = createMockServer();
    registerStatusTools(server as any);
    const handler = handlers.get('succ_status')!;

    const result = await handler({ action: 'stats' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('forbidden by profile');
  });

  it('shows global-only overview when project is not initialized', async () => {
    vi.mocked(isGlobalOnlyMode).mockReturnValue(true);

    const { server, handlers } = createMockServer();
    registerStatusTools(server as any);
    const handler = handlers.get('succ_status')!;

    const result = await handler({ action: 'overview' });
    expect(result.content[0].text).toContain('Global-only');
    expect(result.content[0].text).toContain('Run `succ init`');
  });

  it('formats token stats in stats mode', async () => {
    vi.mocked(getTokenStatsAggregated).mockResolvedValueOnce([
      {
        event_type: 'session_summary',
        query_count: 2,
        total_full_source_tokens: 1000,
        total_returned_tokens: 200,
        total_savings_tokens: 800,
      },
      {
        event_type: 'search',
        query_count: 3,
        total_returned_tokens: 150,
        total_savings_tokens: 50,
      },
    ] as any);

    const { server, handlers } = createMockServer();
    registerStatusTools(server as any);
    const handler = handlers.get('succ_status')!;

    const result = await handler({ action: 'stats' });
    expect(result.content[0].text).toContain('Token Savings');
    expect(result.content[0].text).toContain('Session Summaries');
    expect(result.content[0].text).toContain('Total saved');
    expect(closeDb).toHaveBeenCalled();
  });

  it('returns AI readiness score output for score action', async () => {
    const { server, handlers } = createMockServer();
    registerStatusTools(server as any);
    const handler = handlers.get('succ_status')!;

    const result = await handler({ action: 'score' });
    expect(result.content[0].text).toContain('AI Readiness: 88/100');
  });

  it('handles stats failures gracefully', async () => {
    vi.mocked(getTokenStatsAggregated).mockRejectedValueOnce(new Error('stats unavailable'));

    const { server, handlers } = createMockServer();
    registerStatusTools(server as any);
    const handler = handlers.get('succ_status')!;

    const result = await handler({ action: 'stats' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('stats unavailable');
  });
});
