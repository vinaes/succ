import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/storage/index.js', () => ({
  hybridSearchCode: vi.fn(async () => []),
  hybridSearchDocs: vi.fn(async () => []),
  getRecentDocuments: vi.fn(async () => []),
  closeDb: vi.fn(),
}));

vi.mock('../../lib/config.js', () => ({
  isGlobalOnlyMode: vi.fn(() => false),
  getReadinessGateConfig: vi.fn(() => ({ enabled: false })),
}));

vi.mock('../../lib/embeddings.js', () => ({
  getEmbedding: vi.fn(async () => [0.1, 0.2]),
}));

vi.mock('../../lib/readiness.js', () => ({
  assessReadiness: vi.fn(() => ({})),
  formatReadinessHeader: vi.fn(() => ''),
}));

vi.mock('../helpers.js', () => ({
  trackTokenSavings: vi.fn(async () => {}),
  projectPathParam: {} as any,
  applyProjectPath: vi.fn(async () => {}),
  extractAnswerFromResults: vi.fn(async () => 'extracted answer'),
}));

import { registerSearchTools } from './search.js';
import {
  hybridSearchCode,
  hybridSearchDocs,
  getRecentDocuments,
  closeDb,
} from '../../lib/storage/index.js';
import { isGlobalOnlyMode } from '../../lib/config.js';
import { extractAnswerFromResults } from '../helpers.js';

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

describe('search tool module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isGlobalOnlyMode).mockReturnValue(false);
    vi.mocked(hybridSearchDocs).mockResolvedValue([]);
    vi.mocked(hybridSearchCode).mockResolvedValue([]);
    vi.mocked(getRecentDocuments).mockResolvedValue([]);
  });

  it('registers succ_search and succ_search_code', () => {
    const { server, handlers } = createMockServer();
    registerSearchTools(server as any);
    expect(server.registerTool).toHaveBeenCalledTimes(2);
    expect(handlers.has('succ_search')).toBe(true);
    expect(handlers.has('succ_search_code')).toBe(true);
  });

  it('returns recent documents for wildcard query', async () => {
    vi.mocked(getRecentDocuments).mockResolvedValueOnce([
      {
        file_path: 'docs/api.md',
        start_line: 1,
        end_line: 12,
        content: 'Authentication details',
      },
    ] as any);

    const { server, handlers } = createMockServer();
    registerSearchTools(server as any);
    const handler = handlers.get('succ_search')!;

    const result = await handler({ query: '*', limit: 5 });
    expect(getRecentDocuments).toHaveBeenCalledWith(5);
    expect(result.content[0].text).toContain('Found 1 recent documents');
    expect(closeDb).toHaveBeenCalled();
  });

  it('returns init hint in global-only mode', async () => {
    vi.mocked(isGlobalOnlyMode).mockReturnValue(true);

    const { server, handlers } = createMockServer();
    registerSearchTools(server as any);
    const handler = handlers.get('succ_search')!;

    const result = await handler({ query: 'auth' });
    expect(result.content[0].text).toContain('Project not initialized');
  });

  it('uses extraction flow when extract is provided', async () => {
    vi.mocked(hybridSearchDocs).mockResolvedValueOnce([
      {
        file_path: 'docs/auth.md',
        start_line: 10,
        end_line: 40,
        similarity: 0.9,
        content: 'JWT setup details',
      },
    ] as any);

    const { server, handlers } = createMockServer();
    registerSearchTools(server as any);
    const handler = handlers.get('succ_search')!;

    const result = await handler({ query: 'jwt', extract: 'How to configure JWT?' });
    expect(extractAnswerFromResults).toHaveBeenCalled();
    expect(result.content[0].text).toContain('(extracted)');
    expect(result.content[0].text).toContain('extracted answer');
  });

  it('formats code search in signatures mode', async () => {
    vi.mocked(hybridSearchCode).mockResolvedValueOnce([
      {
        file_path: 'code:src/auth.ts',
        start_line: 20,
        end_line: 40,
        similarity: 0.87,
        content: 'export function login(user) { ... }',
        symbol_name: 'login',
        symbol_type: 'function',
      },
    ] as any);

    const { server, handlers } = createMockServer();
    registerSearchTools(server as any);
    const handler = handlers.get('succ_search_code')!;

    const result = await handler({ query: 'login', output: 'signatures' });
    expect(result.content[0].text).toContain('Found 1 code matches');
    expect(result.content[0].text).toContain('function login');
  });

  it('returns no-results guidance for code search', async () => {
    vi.mocked(hybridSearchCode).mockResolvedValueOnce([]);

    const { server, handlers } = createMockServer();
    registerSearchTools(server as any);
    const handler = handlers.get('succ_search_code')!;

    const result = await handler({ query: 'missing-symbol' });
    expect(result.content[0].text).toContain('No code found matching');
  });
});
