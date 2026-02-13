import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./llm.js', () => ({
  callLLM: vi.fn(),
  getLLMConfig: vi.fn(() => ({
    backend: 'api',
    model: 'qwen2.5:7b',
    endpoint: 'http://localhost:11434/v1/chat/completions',
  })),
}));

import { expandQuery } from './query-expansion.js';
import { callLLM } from './llm.js';

const mockedCallLLM = vi.mocked(callLLM);

describe('expandQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns expanded queries from LLM response', async () => {
    mockedCallLLM.mockResolvedValue(
      'authentication flow security\nlogin session management\nJWT token validation\nuser credential verification'
    );

    const result = await expandQuery('how does the auth system handle user login');
    expect(result).toHaveLength(4);
    expect(result[0]).toBe('authentication flow security');
    expect(result[1]).toBe('login session management');
  });

  it('strips numbering from LLM response', async () => {
    mockedCallLLM.mockResolvedValue(
      '1. authentication flow\n2. login management\n3. session handling'
    );

    const result = await expandQuery('how does auth work');
    expect(result).toEqual(['authentication flow', 'login management', 'session handling']);
  });

  it('strips bullet points from LLM response', async () => {
    mockedCallLLM.mockResolvedValue(
      '- auth flow security\n* login management\n- session tokens'
    );

    const result = await expandQuery('how does auth work');
    expect(result).toEqual(['auth flow security', 'login management', 'session tokens']);
  });

  it('filters out empty lines and very short strings', async () => {
    mockedCallLLM.mockResolvedValue(
      'valid query here\n\nab\n\nanother valid query'
    );

    const result = await expandQuery('test query');
    expect(result).toEqual(['valid query here', 'another valid query']);
  });

  it('limits to 5 queries max', async () => {
    mockedCallLLM.mockResolvedValue(
      'query one\nquery two\nquery three\nquery four\nquery five\nquery six\nquery seven'
    );

    const result = await expandQuery('test');
    expect(result).toHaveLength(5);
  });

  it('returns empty array on LLM failure', async () => {
    mockedCallLLM.mockRejectedValue(new Error('LLM timeout'));

    const result = await expandQuery('test query');
    expect(result).toEqual([]);
  });

  it('returns empty array on empty response', async () => {
    mockedCallLLM.mockResolvedValue('');

    const result = await expandQuery('test query');
    expect(result).toEqual([]);
  });

  it('calls LLM with correct prompt containing the query', async () => {
    mockedCallLLM.mockResolvedValue('expanded query');

    await expandQuery('my specific search term');

    expect(mockedCallLLM).toHaveBeenCalledOnce();
    const prompt = mockedCallLLM.mock.calls[0][0];
    expect(prompt).toContain('my specific search term');
  });

  it('passes temperature 0.7 and maxTokens 200', async () => {
    mockedCallLLM.mockResolvedValue('expanded query');

    await expandQuery('test');

    const options = mockedCallLLM.mock.calls[0][1];
    expect(options).toEqual({ maxTokens: 200, temperature: 0.7 });
  });

  it('passes config override when mode differs from default', async () => {
    mockedCallLLM.mockResolvedValue('expanded query');

    await expandQuery('test', 'claude');

    const configOverride = mockedCallLLM.mock.calls[0][2];
    expect(configOverride).toEqual({ backend: 'claude' });
  });

  it('passes no config override when mode matches default', async () => {
    mockedCallLLM.mockResolvedValue('expanded query');

    await expandQuery('test', 'api');

    const configOverride = mockedCallLLM.mock.calls[0][2];
    expect(configOverride).toBeUndefined();
  });
});
