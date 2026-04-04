import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/storage/index.js', () => ({
  saveMemory: vi.fn(async () => ({ id: 101, isDuplicate: false })),
  searchMemories: vi.fn(async () => []),
  closeDb: vi.fn(),
  getStorageDispatcher: vi.fn(async () => ({ flushSessionCounters: vi.fn() })),
}));

vi.mock('../../lib/config.js', () => ({
  getConfig: vi.fn(() => ({
    sensitive_filter_enabled: true,
    sensitive_auto_redact: false,
    quality_scoring_enabled: true,
  })),
  getIdleReflectionConfig: vi.fn(() => ({
    thresholds: { dead_end_dedup: 0.85 },
  })),
  isGlobalOnlyMode: vi.fn(() => false),
  getErrorReportingConfig: vi.fn().mockReturnValue({ enabled: false }),
}));

vi.mock('../../lib/embeddings.js', () => ({
  getEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
}));

vi.mock('../../lib/quality.js', () => ({
  scoreMemory: vi.fn(async () => ({ score: 0.91, factors: { relevance: 0.9 } })),
  passesQualityThreshold: vi.fn(() => true),
  formatQualityScore: vi.fn(() => '0.91'),
}));

vi.mock('../../lib/sensitive-filter.js', () => ({
  scanSensitive: vi.fn(() => ({ hasSensitive: false, redactedText: '', matches: [] })),
  formatMatches: vi.fn(() => 'token=***'),
}));

vi.mock('../helpers.js', () => ({
  projectPathParam: {} as any,
  applyProjectPath: vi.fn(async () => {}),
}));

import { registerDeadEndTools } from './dead-end.js';
import { saveMemory, searchMemories, closeDb } from '../../lib/storage/index.js';
import { isGlobalOnlyMode } from '../../lib/config.js';
import { passesQualityThreshold } from '../../lib/quality.js';

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

describe('dead-end tool module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isGlobalOnlyMode).mockReturnValue(false);
    vi.mocked(searchMemories).mockResolvedValue([]);
    vi.mocked(passesQualityThreshold).mockReturnValue(true);
    vi.mocked(saveMemory).mockResolvedValue({ id: 101, isDuplicate: false });
  });

  it('registers succ_dead_end', () => {
    const { server, handlers } = createMockServer();
    registerDeadEndTools(server as any);
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    expect(handlers.has('succ_dead_end')).toBe(true);
  });

  it('records a dead-end on happy path and appends dead-end tag', async () => {
    const { server, handlers } = createMockServer();
    registerDeadEndTools(server as any);
    const handler = handlers.get('succ_dead_end');
    expect(handler).toBeDefined();

    const result = await handler!({
      approach: 'Use Redis sessions',
      why_failed: 'Too much memory on small VPS',
      tags: ['infra'],
    });

    expect(saveMemory).toHaveBeenCalledWith(
      expect.stringContaining('DEAD END: Tried "Use Redis sessions"'),
      expect.any(Array),
      expect.arrayContaining(['infra', 'dead-end']),
      'dead-end-tracking',
      expect.objectContaining({ type: 'dead_end' })
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Dead-end recorded');
    expect(closeDb).toHaveBeenCalled();
  });

  it('returns duplicate warning when similar dead-end already exists', async () => {
    vi.mocked(searchMemories).mockResolvedValue([
      {
        id: 42,
        content: 'DEAD END: Tried "Use Redis sessions" — Failed because: Too much memory',
        similarity: 0.96,
      },
    ] as any);

    const { server, handlers } = createMockServer();
    registerDeadEndTools(server as any);
    const handler = handlers.get('succ_dead_end')!;

    const result = await handler({
      approach: 'Use Redis sessions',
      why_failed: 'Too much memory',
      tags: [],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Similar dead-end already recorded');
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('returns quality warning when threshold is not met', async () => {
    vi.mocked(passesQualityThreshold).mockReturnValue(false);

    const { server, handlers } = createMockServer();
    registerDeadEndTools(server as any);
    const handler = handlers.get('succ_dead_end')!;

    const result = await handler({
      approach: 'Disable retries',
      why_failed: 'Caused data loss',
      tags: [],
    });

    expect(result.content[0].text).toContain('Dead-end quality too low');
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('returns project initialization hint in global-only mode', async () => {
    vi.mocked(isGlobalOnlyMode).mockReturnValue(true);

    const { server, handlers } = createMockServer();
    registerDeadEndTools(server as any);
    const handler = handlers.get('succ_dead_end')!;

    const result = await handler({
      approach: 'Anything',
      why_failed: 'Anything',
      tags: [],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('requires a project');
  });
});
