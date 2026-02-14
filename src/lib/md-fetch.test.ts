import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchAsMarkdown } from './md-fetch.js';

// Mock config
vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({ md_api_url: 'https://md.test.local' })),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockJsonResponse(data: Record<string, unknown>, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

describe('fetchAsMarkdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches URL via md.succ.ai and returns parsed result', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        title: 'Example Page',
        url: 'https://example.com',
        content: '# Example\n\nHello world',
        excerpt: 'A page',
        byline: 'Author',
        siteName: 'Example',
        tokens: 42,
        tier: 'fetch',
        readability: true,
        method: 'readability',
        quality: { score: 0.85, grade: 'A' },
        time_ms: 234,
      }),
    );

    const result = await fetchAsMarkdown('https://example.com');

    expect(result.title).toBe('Example Page');
    expect(result.content).toBe('# Example\n\nHello world');
    expect(result.tokens).toBe(42);
    expect(result.quality.grade).toBe('A');
    expect(result.tier).toBe('fetch');
    expect(result.readability).toBe(true);
  });

  it('uses config md_api_url as base URL', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ content: 'test', title: '', url: '' }),
    );

    await fetchAsMarkdown('https://example.com');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://md.test.local/'),
      expect.objectContaining({
        headers: { Accept: 'application/json' },
      }),
    );
  });

  it('allows baseUrl override via options', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ content: 'test', title: '', url: '' }),
    );

    await fetchAsMarkdown('https://example.com', { baseUrl: 'https://custom.api' });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://custom.api/'),
      expect.any(Object),
    );
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ error: 'not found' }, 404),
    );

    await expect(fetchAsMarkdown('https://bad.url')).rejects.toThrow('md.succ.ai error: HTTP 404');
  });

  it('throws on conversion error in response', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ error: 'All conversion methods failed' }),
    );

    await expect(fetchAsMarkdown('https://spa.site')).rejects.toThrow(
      'md.succ.ai conversion failed',
    );
  });

  it('throws on empty content', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ content: '' }));

    await expect(fetchAsMarkdown('https://empty.page')).rejects.toThrow('empty content');
  });

  it('handles missing optional fields gracefully', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        content: '# Minimal',
        title: 'Min',
        url: 'https://min.com',
      }),
    );

    const result = await fetchAsMarkdown('https://min.com');

    expect(result.content).toBe('# Minimal');
    expect(result.byline).toBe('');
    expect(result.excerpt).toBe('');
    expect(result.tokens).toBe(0);
    expect(result.quality).toEqual({ score: 0, grade: 'F' });
    expect(result.tier).toBe('unknown');
  });

  it('encodes URL in path', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ content: 'ok', title: '', url: '' }),
    );

    await fetchAsMarkdown('https://example.com/path?q=hello world');

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent('https://example.com/path?q=hello world'));
  });

  it('rejects non-http URLs (SSRF protection)', async () => {
    await expect(fetchAsMarkdown('file:///etc/passwd')).rejects.toThrow('Only http://');
    await expect(fetchAsMarkdown('ftp://server/file')).rejects.toThrow('Only http://');
    await expect(fetchAsMarkdown('javascript:alert(1)')).rejects.toThrow('Only http://');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('applies timeout from options', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ content: 'ok', title: '', url: '' }),
    );

    await fetchAsMarkdown('https://example.com', { timeout: 5000 });

    const calledOptions = mockFetch.mock.calls[0][1];
    expect(calledOptions.signal).toBeDefined();
  });
});
