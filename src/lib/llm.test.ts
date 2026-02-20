import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config before importing llm
vi.mock('./config.js', () => ({
  getConfig: () => ({
    llm: { type: 'api', model: 'test-model', temperature: 0.3, max_tokens: 2000 },
  }),
  getLLMTaskConfig: () => ({
    model: 'test-model',
    api_url: 'http://localhost:11434/v1',
    api_key: 'test-key',
    max_tokens: 2000,
    temperature: 0.3,
    mode: 'api',
  }),
  getApiKey: () => 'test-key',
  getApiUrl: () => 'http://localhost:11434/v1',
  getOpenRouterApiKey: () => null,
}));

// Mock fault-logger
vi.mock('./fault-logger.js', () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

// Mock claude-ws-transport
vi.mock('./claude-ws-transport.js', () => ({
  ClaudeWSTransport: { getInstance: vi.fn() },
}));

// Mock cross-spawn
vi.mock('cross-spawn', () => ({ default: vi.fn() }));

// Mock errors
vi.mock('./errors.js', async () => {
  class NetworkError extends Error {
    statusCode?: number;
    constructor(message: string, statusCode?: number) {
      super(message);
      this.name = 'NetworkError';
      this.statusCode = statusCode;
    }
  }
  class ConfigError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ConfigError';
    }
  }
  return { NetworkError, ConfigError };
});

// Mock process-registry
vi.mock('./process-registry.js', () => ({
  processRegistry: { register: vi.fn(), unregister: vi.fn() },
}));

import { callLLM, callLLMWithFallback } from './llm.js';
import type { LLMOptions } from './llm.js';

// Helper to create a mock fetch response
function mockFetchResponse(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  };
}

describe('callLLM systemPrompt', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockFetchResponse('response') as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends only user message when no systemPrompt', async () => {
    await callLLM('hello');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('sends system + user messages when systemPrompt is provided', async () => {
    await callLLM('hello', { systemPrompt: 'You are a helpful assistant.' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('does not send system message when systemPrompt is empty string', async () => {
    await callLLM('hello', { systemPrompt: '' });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('keeps user prompt unchanged (not merged with systemPrompt)', async () => {
    await callLLM('extract facts from this', {
      systemPrompt: 'You are a fact extraction engine. Output JSON.',
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.messages[0].content).toBe('You are a fact extraction engine. Output JSON.');
    expect(body.messages[1].content).toBe('extract facts from this');
  });

  it('passes systemPrompt through callLLMWithFallback', async () => {
    await callLLMWithFallback('hello', { systemPrompt: 'Be concise.' });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('preserves other options alongside systemPrompt', async () => {
    const options: LLMOptions = {
      systemPrompt: 'System instructions here.',
      maxTokens: 500,
      temperature: 0.1,
      timeout: 5000,
    };

    await callLLM('test prompt', options);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.messages).toHaveLength(2);
    expect(body.max_tokens).toBe(500);
    expect(body.temperature).toBe(0.1);
  });
});
