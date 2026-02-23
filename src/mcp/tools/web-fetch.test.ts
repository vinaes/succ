import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../profile.js', () => ({
  gateAction: vi.fn(() => null),
}));

vi.mock('../helpers.js', () => ({
  projectPathParam: {} as any,
  applyProjectPath: vi.fn(async () => {}),
  createToolResponse: vi.fn((text: string) => ({
    content: [{ type: 'text' as const, text }],
  })),
  createErrorResponse: vi.fn((text: string) => ({
    content: [{ type: 'text' as const, text }],
    isError: true,
  })),
}));

vi.mock('../../lib/md-fetch.js', () => ({
  fetchAsMarkdown: vi.fn(async () => ({
    title: 'Example Title',
    url: 'https://example.com',
    content: 'full content',
    fitContent: 'fit content',
    tokens: 1200,
    fitTokens: 600,
    quality: { grade: 'A', score: 95 },
    tier: 'gold',
    method: 'readability',
    time_ms: 250,
    byline: 'Author',
    excerpt: 'Excerpt',
  })),
  extractFromUrl: vi.fn(async () => ({
    url: 'https://example.com',
    valid: true,
    data: { items: [{ name: 'item-1' }] },
  })),
}));

vi.mock('../../lib/fault-logger.js', () => ({
  logWarn: vi.fn(),
}));

import { registerWebFetchTools } from './web-fetch.js';
import { gateAction } from '../profile.js';
import { fetchAsMarkdown, extractFromUrl } from '../../lib/md-fetch.js';
import { createErrorResponse } from '../helpers.js';
import { logWarn } from '../../lib/fault-logger.js';

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

describe('web-fetch tool module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(gateAction).mockReturnValue(null);
  });

  it('registers succ_fetch', () => {
    const { server, handlers } = createMockServer();
    registerWebFetchTools(server as any);
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    expect(handlers.has('succ_fetch')).toBe(true);
  });

  it('returns gated response for extract flow when profile blocks it', async () => {
    vi.mocked(gateAction).mockReturnValue({
      content: [{ type: 'text', text: 'requires standard profile' }],
      isError: true,
    } as any);

    const { server, handlers } = createMockServer();
    registerWebFetchTools(server as any);
    const handler = handlers.get('succ_fetch')!;

    const result = await handler({
      url: 'https://example.com',
      schema: '{"type":"object"}',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('requires standard profile');
  });

  it('returns validation error for invalid schema JSON', async () => {
    const { server, handlers } = createMockServer();
    registerWebFetchTools(server as any);
    const handler = handlers.get('succ_fetch')!;

    const result = await handler({
      url: 'https://example.com',
      schema: '{invalid-json',
    });

    expect(result.isError).toBe(true);
    expect(createErrorResponse).toHaveBeenCalledWith('Invalid JSON schema string', 'web-fetch');
    expect(logWarn).toHaveBeenCalled();
  });

  it('extracts structured data when schema is valid', async () => {
    const { server, handlers } = createMockServer();
    registerWebFetchTools(server as any);
    const handler = handlers.get('succ_fetch')!;

    const result = await handler({
      url: 'https://example.com',
      schema: '{"type":"object","properties":{"items":{"type":"array"}}}',
      format: 'json',
    });

    expect(extractFromUrl).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ type: 'object' })
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('"valid": true');
  });

  it('fetches markdown in non-schema mode', async () => {
    const { server, handlers } = createMockServer();
    registerWebFetchTools(server as any);
    const handler = handlers.get('succ_fetch')!;

    const result = await handler({
      url: 'https://example.com',
      mode: 'fit',
      format: 'markdown',
    });

    expect(fetchAsMarkdown).toHaveBeenCalled();
    expect(result.content[0].text).toContain('Title: Example Title');
    expect(result.content[0].text).toContain('fit content');
  });

  it('returns error response when fetch fails', async () => {
    vi.mocked(fetchAsMarkdown).mockRejectedValueOnce(new Error('network down'));

    const { server, handlers } = createMockServer();
    registerWebFetchTools(server as any);
    const handler = handlers.get('succ_fetch')!;

    const result = await handler({
      url: 'https://example.com',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to fetch https://example.com: network down');
  });
});
