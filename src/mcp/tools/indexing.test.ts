import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../commands/analyze.js', () => ({
  analyzeFile: vi.fn(async () => ({ success: true, outputPath: '/tmp/analysis.md' })),
}));

vi.mock('../../commands/index.js', () => ({
  indexDocFile: vi.fn(async () => ({ success: true, chunks: 5 })),
}));

vi.mock('../../commands/index-code.js', () => ({
  indexCodeFile: vi.fn(async () => ({ success: true, chunks: 3 })),
}));

vi.mock('../../commands/reindex.js', () => ({
  reindexFiles: vi.fn(async () => ({
    total: 12,
    reindexed: 0,
    cleaned: 0,
    errors: 0,
    details: [],
  })),
}));

vi.mock('../../lib/config.js', () => ({
  getProjectRoot: vi.fn(() => '/project'),
}));

vi.mock('../helpers.js', () => ({
  projectPathParam: {} as any,
  applyProjectPath: vi.fn(async () => {}),
}));

import { registerIndexingTools } from './indexing.js';
import { analyzeFile } from '../../commands/analyze.js';
import { indexDocFile } from '../../commands/index.js';
import { indexCodeFile } from '../../commands/index-code.js';
import { reindexFiles } from '../../commands/reindex.js';

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

describe('indexing tool module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(indexDocFile).mockResolvedValue({ success: true, chunks: 5 } as any);
    vi.mocked(indexCodeFile).mockResolvedValue({ success: true, chunks: 3 } as any);
    vi.mocked(analyzeFile).mockResolvedValue({
      success: true,
      outputPath: '/tmp/analysis.md',
    } as any);
    vi.mocked(reindexFiles).mockResolvedValue({
      total: 12,
      reindexed: 0,
      cleaned: 0,
      errors: 0,
      details: [],
    } as any);
  });

  it('registers succ_index', () => {
    const { server, handlers } = createMockServer();
    registerIndexingTools(server as any);
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    expect(handlers.has('succ_index')).toBe(true);
  });

  it('returns validation error when file is missing for file-based actions', async () => {
    const { server, handlers } = createMockServer();
    registerIndexingTools(server as any);
    const handler = handlers.get('succ_index')!;

    const result = await handler({ action: 'doc' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"file" is required');
  });

  it('indexes docs on happy path', async () => {
    const { server, handlers } = createMockServer();
    registerIndexingTools(server as any);
    const handler = handlers.get('succ_index')!;

    const result = await handler({ action: 'doc', file: 'docs/api.md', force: false });

    expect(indexDocFile).toHaveBeenCalledWith('docs/api.md', { force: false });
    expect(result.content[0].text).toContain('Indexed: docs/api.md (5 chunks)');
  });

  it('returns skipped message when code indexing is skipped', async () => {
    vi.mocked(indexCodeFile).mockResolvedValueOnce({
      success: true,
      skipped: true,
      reason: 'unchanged',
    } as any);

    const { server, handlers } = createMockServer();
    registerIndexingTools(server as any);
    const handler = handlers.get('succ_index')!;

    const result = await handler({ action: 'code', file: 'src/app.ts', force: false });

    expect(result.content[0].text).toContain('Skipped: unchanged');
  });

  it('returns analyze failure as error response', async () => {
    vi.mocked(analyzeFile).mockResolvedValueOnce({
      success: false,
      error: 'analyzer failed',
    } as any);

    const { server, handlers } = createMockServer();
    registerIndexingTools(server as any);
    const handler = handlers.get('succ_index')!;

    const result = await handler({ action: 'analyze', file: 'src/server.ts', mode: 'api' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('analyzer failed');
  });

  it('reports up-to-date state for refresh action', async () => {
    const { server, handlers } = createMockServer();
    registerIndexingTools(server as any);
    const handler = handlers.get('succ_index')!;

    const result = await handler({ action: 'refresh' });

    expect(reindexFiles).toHaveBeenCalledWith('/project');
    expect(result.content[0].text).toContain('up to date');
  });
});
