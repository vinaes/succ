import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock LLM
const mockCallLLM = vi.fn();
vi.mock('../llm.js', () => ({
  callLLM: (...args: unknown[]) => mockCallLLM(...args),
}));

vi.mock('../fault-logger.js', () => ({
  logWarn: vi.fn(),
}));

import { shouldDecompose, decomposeQuery } from './query-decomposition.js';

describe('shouldDecompose', () => {
  it('returns false for short simple queries', () => {
    expect(shouldDecompose('auth flow')).toBe(false);
    expect(shouldDecompose('how does login work')).toBe(false);
  });

  it('returns false for single-signal queries (only long)', () => {
    // >15 words but no conjunctions/identifiers/questions — only 1 signal
    expect(
      shouldDecompose(
        'the quick brown fox jumped over the lazy dog then went home to sleep quietly in bed'
      )
    ).toBe(false);
  });

  it('returns true for conjunction + long query (2 signals)', () => {
    expect(
      shouldDecompose(
        'how does the authentication system work and what happens when the session expires after timeout'
      )
    ).toBe(true);
  });

  it('returns true for multiple identifiers + conjunction', () => {
    expect(shouldDecompose('compare FooBarService and bazQux handler')).toBe(true);
  });

  it('returns true for multiple quoted phrases + conjunction', () => {
    expect(shouldDecompose('compare "retry budget" versus "rate limit" in the API layer')).toBe(
      true
    );
  });

  it('returns true for multi-question pattern + conjunction', () => {
    expect(shouldDecompose('how does the cache work and also what happens on invalidation')).toBe(
      true
    );
  });

  it('returns true for snake_case identifiers + conjunction', () => {
    expect(shouldDecompose('compare user_session and auth_token handling')).toBe(true);
  });

  it('does not count single-word quoted strings as phrases', () => {
    // Single-word quotes don't have spaces, so shouldn't match multi-word phrase pattern
    expect(shouldDecompose('find "auth" and "login"')).toBe(false);
  });
});

describe('decomposeQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips decomposition for simple queries', async () => {
    const result = await decomposeQuery('auth flow');
    expect(result.wasDecomposed).toBe(false);
    expect(result.subQueries).toEqual([]);
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('decomposes complex queries via LLM', async () => {
    mockCallLLM.mockResolvedValueOnce(
      'authentication system architecture\nsession expiry and timeout handling'
    );

    const result = await decomposeQuery(
      'how does the authentication system work and what happens when the session expires after timeout'
    );

    expect(result.wasDecomposed).toBe(true);
    expect(result.subQueries).toHaveLength(2);
    expect(result.subQueries[0]).toBe('authentication system architecture');
    expect(result.subQueries[1]).toBe('session expiry and timeout handling');
  });

  it('strips LLM numbering prefixes', async () => {
    mockCallLLM.mockResolvedValueOnce('1. auth system\n2. session handling\n3. token refresh');

    const result = await decomposeQuery(
      'how does the authentication system work and what happens when the session expires after timeout'
    );

    expect(result.wasDecomposed).toBe(true);
    expect(result.subQueries).toEqual(['auth system', 'session handling', 'token refresh']);
  });

  it('strips "Sub-query N:" prefixes', async () => {
    mockCallLLM.mockResolvedValueOnce('Sub-query 1: auth system\nSub-query 2: session handling');

    const result = await decomposeQuery(
      'how does the authentication system work and what happens when the session expires after timeout'
    );

    expect(result.wasDecomposed).toBe(true);
    expect(result.subQueries).toEqual(['auth system', 'session handling']);
  });

  it('falls back when LLM returns empty response', async () => {
    mockCallLLM.mockResolvedValueOnce('');

    const result = await decomposeQuery(
      'how does the authentication system work and what happens when the session expires after timeout'
    );

    expect(result.wasDecomposed).toBe(false);
    expect(result.subQueries).toEqual([]);
  });

  it('falls back when LLM returns fewer than 2 sub-queries', async () => {
    mockCallLLM.mockResolvedValueOnce('just one query');

    const result = await decomposeQuery(
      'how does the authentication system work and what happens when the session expires after timeout'
    );

    expect(result.wasDecomposed).toBe(false);
    expect(result.subQueries).toEqual([]);
  });

  it('falls back on LLM error', async () => {
    mockCallLLM.mockRejectedValueOnce(new Error('LLM timeout'));

    const result = await decomposeQuery(
      'how does the authentication system work and what happens when the session expires after timeout'
    );

    expect(result.wasDecomposed).toBe(false);
    expect(result.subQueries).toEqual([]);
  });

  it('filters preamble lines from LLM output', async () => {
    mockCallLLM.mockResolvedValueOnce(
      'Here are the sub-queries:\nauth system design\nsession management'
    );

    const result = await decomposeQuery(
      'how does the authentication system work and what happens when the session expires after timeout'
    );

    expect(result.wasDecomposed).toBe(true);
    expect(result.subQueries).toEqual(['auth system design', 'session management']);
  });

  it('deduplicates identical sub-queries', async () => {
    mockCallLLM.mockResolvedValueOnce('auth system\nauth system\nsession handling');

    const result = await decomposeQuery(
      'how does the authentication system work and what happens when the session expires after timeout'
    );

    expect(result.wasDecomposed).toBe(true);
    expect(result.subQueries).toEqual(['auth system', 'session handling']);
  });

  it('caps at 3 sub-queries', async () => {
    mockCallLLM.mockResolvedValueOnce('one\ntwo\nthree\nfour\nfive');

    const result = await decomposeQuery(
      'how does the authentication system work and what happens when the session expires after timeout'
    );

    expect(result.wasDecomposed).toBe(true);
    expect(result.subQueries).toHaveLength(3);
  });

  it('keeps short valid terms like SSO and JWT (min 3 chars)', async () => {
    mockCallLLM.mockResolvedValueOnce('SSO configuration\nJWT token validation');

    const result = await decomposeQuery(
      'how does the authentication system work and what happens when the session expires after timeout'
    );

    expect(result.wasDecomposed).toBe(true);
    expect(result.subQueries[0]).toBe('SSO configuration');
  });
});
