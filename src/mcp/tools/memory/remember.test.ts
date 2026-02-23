import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/storage/index.js', () => ({
  saveMemory: vi.fn(async () => ({ id: 1, isDuplicate: false })),
  saveGlobalMemory: vi.fn(async () => ({ id: 10, isDuplicate: false })),
  closeDb: vi.fn(),
  closeGlobalDb: vi.fn(),
}));

vi.mock('../../../lib/config.js', () => ({
  getConfig: vi.fn(() => ({
    remember_extract_default: true,
    sensitive_filter_enabled: false,
    quality_scoring_enabled: false,
  })),
  getProjectRoot: vi.fn(() => '/tmp/project'),
  isGlobalOnlyMode: vi.fn(() => false),
}));

vi.mock('../../../lib/embeddings.js', () => ({
  getEmbedding: vi.fn(async () => [0.1, 0.2]),
}));

vi.mock('../../../lib/quality.js', () => ({
  scoreMemory: vi.fn(async () => ({ score: 0.9, factors: {} })),
  passesQualityThreshold: vi.fn(() => true),
  formatQualityScore: vi.fn(() => 'Quality: 0.90'),
}));

vi.mock('../../../lib/sensitive-filter.js', () => ({
  scanSensitive: vi.fn(() => ({ hasSensitive: false, matches: [], redactedText: '' })),
  formatMatches: vi.fn(() => ''),
}));

vi.mock('../../../lib/temporal.js', () => ({
  parseDuration: vi.fn(() => new Date()),
}));

vi.mock('../../helpers.js', () => ({
  projectPathParam: {} as any,
  applyProjectPath: vi.fn(async () => {}),
}));

vi.mock('./memory-helpers.js', () => ({
  rememberWithLLMExtraction: vi.fn(async () => ({
    content: [{ type: 'text' as const, text: 'remember helper called' }],
  })),
}));

import { rememberWithLLMExtraction } from './memory-helpers.js';
import { registerRememberTool } from './remember.js';

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

describe('remember tool module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers succ_remember', () => {
    const { server, handlers } = createMockServer();
    registerRememberTool(server as any);
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    expect(handlers.has('succ_remember')).toBe(true);
  });

  it('delegates to rememberWithLLMExtraction when extract mode is enabled', async () => {
    const { server, handlers } = createMockServer();
    registerRememberTool(server as any);

    const handler = handlers.get('succ_remember');
    expect(handler).toBeDefined();

    const result = await handler!({
      content: 'Use blue-green deployment',
      tags: ['decision'],
      source: 'test',
      type: 'decision',
      global: false,
      extract: true,
      project_path: '/tmp/project',
    });

    expect(rememberWithLLMExtraction).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('remember helper called');
  });
});
