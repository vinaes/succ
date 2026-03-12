import { describe, it, expect } from 'vitest';
import { sanitizeQuery } from './query-sanitizer.js';

describe('sanitizeQuery', () => {
  it('passes plain text through unchanged', () => {
    const result = sanitizeQuery('what did I learn about authentication patterns');
    expect(result.redacted).toBe('what did I learn about authentication patterns');
    expect(result.preview256).toBe('what did I learn about authentication patterns');
  });

  it('masks email addresses', () => {
    const result = sanitizeQuery('find memories about user@example.com onboarding');
    expect(result.redacted).toBe('find memories about [EMAIL] onboarding');
    expect(result.preview256).toBe('find memories about [EMAIL] onboarding');
  });

  it('masks multiple emails in one string', () => {
    const result = sanitizeQuery('alice@domain.com and bob@other.org contacted us');
    expect(result.redacted).not.toContain('alice@domain.com');
    expect(result.redacted).not.toContain('bob@other.org');
    expect(result.redacted).toBe('[EMAIL] and [EMAIL] contacted us');
  });

  it('masks URLs', () => {
    const result = sanitizeQuery('search for https://example.com/api/token notes');
    expect(result.redacted).toBe('search for [URL] notes');
  });

  it('masks multiple URLs', () => {
    const result = sanitizeQuery('compare https://foo.com and http://bar.org responses');
    expect(result.redacted).toBe('compare [URL] and [URL] responses');
  });

  it('masks JWT tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = sanitizeQuery(`token is ${jwt} for session`);
    expect(result.redacted).toBe('token is [JWT] for session');
  });

  it('masks API keys with sk- prefix', () => {
    const result = sanitizeQuery('key is sk-abcdefgh1234567890 for openai');
    expect(result.redacted).toBe('key is [API_KEY] for openai');
  });

  it('masks API keys with pk- prefix', () => {
    const result = sanitizeQuery('public key pk-xyzABC987654321 was rotated');
    expect(result.redacted).toBe('public key [API_KEY] was rotated');
  });

  it('masks API keys with token- prefix', () => {
    const result = sanitizeQuery('use token-secretvalue12345 for auth');
    expect(result.redacted).toBe('use [API_KEY] for auth');
  });

  it('masks API keys with secret- prefix', () => {
    const result = sanitizeQuery('secret-mySecretKey99999 was leaked');
    expect(result.redacted).toBe('[API_KEY] was leaked');
  });

  it('masks long hex strings (32+ chars)', () => {
    const hex = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'; // 32 hex chars
    const result = sanitizeQuery(`hash is ${hex} in the log`);
    expect(result.redacted).toBe('hash is [HEX] in the log');
  });

  it('does not mask short hex strings under 32 chars', () => {
    const shortHex = 'deadbeef1234abcd'; // 16 chars
    const result = sanitizeQuery(`id is ${shortHex} ok`);
    expect(result.redacted).toBe(`id is ${shortHex} ok`);
  });

  it('masks long base64-like strings (32+ chars)', () => {
    // 52-char base64 string with non-hex chars (g-z) so it won't be matched by HEX_RE
    const b64 = 'dGhpcyBpcyBhIGRlZmluaXRlbHkgc2VjcmV0IHZhbHVlIDEyMw==';
    const result = sanitizeQuery(`encoded ${b64} data`);
    expect(result.redacted).not.toContain(b64);
    expect(result.redacted).toMatch(/\[BASE64\]|\[HEX\]/);
  });

  it('truncates to 256 characters', () => {
    const long = 'a '.repeat(200); // 400 chars
    const result = sanitizeQuery(long);
    expect(result.preview256.length).toBeLessThanOrEqual(256);
    expect(result.redacted.length).toBe(400); // redacted is not truncated
  });

  it('handles mixed content with multiple patterns', () => {
    const mixed =
      'user user@test.com visited https://api.example.com with key sk-abc12345678 and hash a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
    const result = sanitizeQuery(mixed);
    expect(result.redacted).not.toContain('user@test.com');
    expect(result.redacted).not.toContain('https://api.example.com');
    expect(result.redacted).not.toContain('sk-abc12345678');
    expect(result.redacted).not.toContain('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4');
    expect(result.redacted).toContain('[EMAIL]');
    expect(result.redacted).toContain('[URL]');
    expect(result.redacted).toContain('[API_KEY]');
  });

  it('masks long numeric sequences (6+ digits)', () => {
    const result = sanitizeQuery('order 1234567890 was placed');
    expect(result.redacted).toBe('order [REDACTED_NUMBER] was placed');
  });

  it('masks credit card-length numbers', () => {
    const result = sanitizeQuery('card 4111111111111111 on file');
    expect(result.redacted).toBe('card [REDACTED_NUMBER] on file');
  });

  it('does not mask short numbers (under 6 digits)', () => {
    const result = sanitizeQuery('top 12345 results found');
    expect(result.redacted).toBe('top 12345 results found');
  });

  it('handles empty string', () => {
    const result = sanitizeQuery('');
    expect(result.redacted).toBe('');
    expect(result.preview256).toBe('');
  });

  it('preview256 is truncated to 256 chars', () => {
    // Use a string with no secret patterns so redacted === original
    const query = 'normal query about authentication ' + 'a b c d '.repeat(40);
    const result = sanitizeQuery(query);
    expect(result.preview256.length).toBe(256);
    expect(result.redacted.length).toBeGreaterThan(256);
    expect(result.preview256).toBe(result.redacted.slice(0, 256));
  });
});
