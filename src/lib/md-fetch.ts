/**
 * md.succ.ai client — fetches URLs and converts to clean Markdown.
 *
 * Uses the md.succ.ai HTML→Markdown API with Readability content extraction
 * and optional Playwright fallback for JS-heavy pages.
 */

import { getConfig } from './config.js';

const DEFAULT_MD_API_URL = 'https://md.succ.ai';
const DEFAULT_TIMEOUT = 30_000;

export interface MdFetchResult {
  title: string;
  url: string;
  content: string; // markdown
  excerpt: string;
  byline: string;
  siteName: string;
  tokens: number;
  tier: string; // 'fetch' | 'browser'
  readability: boolean;
  method: string;
  quality: { score: number; grade: string };
  time_ms: number;
}

export interface MdFetchOptions {
  /** Base URL of md.succ.ai instance (default: config md_api_url or https://md.succ.ai) */
  baseUrl?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
}

/**
 * Fetch a URL and convert to clean Markdown via md.succ.ai.
 *
 * @param url - Target URL to fetch and convert
 * @param options - Optional base URL and timeout overrides
 * @returns Parsed conversion result with markdown content and metadata
 */
export async function fetchAsMarkdown(url: string, options?: MdFetchOptions): Promise<MdFetchResult> {
  let baseUrl = options?.baseUrl;
  if (!baseUrl) {
    try {
      const config = getConfig();
      baseUrl = config.md_api_url || DEFAULT_MD_API_URL;
    } catch {
      baseUrl = DEFAULT_MD_API_URL;
    }
  }

  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;

  // Only allow http(s) URLs to prevent SSRF via md.succ.ai
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Only http:// and https:// URLs are supported');
  }

  // Ensure base URL has no trailing slash
  const base = baseUrl.replace(/\/+$/, '');

  // Encode the target URL as path segment
  const apiUrl = `${base}/${encodeURIComponent(url)}`;

  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`md.succ.ai error: HTTP ${response.status} — ${body.slice(0, 200)}`);
  }

  const data = await response.json();

  // Validate minimum required fields
  if (!data.content && !data.error) {
    throw new Error('md.succ.ai returned empty content');
  }

  if (data.error) {
    throw new Error(`md.succ.ai conversion failed: ${data.error}`);
  }

  return {
    title: data.title || '',
    url: data.url || url,
    content: data.content || '',
    excerpt: data.excerpt || '',
    byline: data.byline || '',
    siteName: data.siteName || '',
    tokens: data.tokens || 0,
    tier: data.tier || 'unknown',
    readability: data.readability ?? false,
    method: data.method || 'unknown',
    quality: data.quality || { score: 0, grade: 'F' },
    time_ms: data.time_ms || 0,
  };
}
