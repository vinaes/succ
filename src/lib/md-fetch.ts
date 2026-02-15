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
  /** LLM-optimized content (only when mode=fit) */
  fitContent?: string;
  /** Token count of fit content */
  fitTokens?: number;
}

export interface MdFetchOptions {
  /** Base URL of md.succ.ai instance (default: config md_api_url or https://md.succ.ai) */
  baseUrl?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Prune boilerplate for LLM context (30-50% fewer tokens) */
  mode?: 'fit';
  /** Convert inline links to numbered references with footer */
  links?: 'citations';
  /** Truncate output to N tokens (used with mode=fit) */
  maxTokens?: number;
}

/**
 * Fetch a URL and convert to clean Markdown via md.succ.ai.
 *
 * @param url - Target URL to fetch and convert
 * @param options - Optional base URL and timeout overrides
 * @returns Parsed conversion result with markdown content and metadata
 */
export async function fetchAsMarkdown(
  url: string,
  options?: MdFetchOptions
): Promise<MdFetchResult> {
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

  // Encode the target URL as path segment, append API query params
  const params = new URLSearchParams();
  if (options?.mode) params.set('mode', options.mode);
  if (options?.links) params.set('links', options.links);
  if (options?.maxTokens) params.set('max_tokens', String(options.maxTokens));
  const qs = params.toString();
  const apiUrl = `${base}/${encodeURIComponent(url)}${qs ? '?' + qs : ''}`;

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
    fitContent: data.fit_markdown ?? undefined,
    fitTokens: data.fit_tokens ?? undefined,
  };
}

export interface ExtractResult {
  valid: boolean;
  data: Record<string, unknown>;
  url: string;
  error?: string;
}

/**
 * Extract structured data from a URL using a JSON schema via md.succ.ai /extract.
 *
 * The LLM reads the page content and returns JSON matching the provided schema.
 * Automatically retries with headless browser for SPA/JS-heavy sites.
 */
export async function extractFromUrl(
  url: string,
  schema: Record<string, unknown>,
  options?: Pick<MdFetchOptions, 'baseUrl' | 'timeout'>
): Promise<ExtractResult> {
  let baseUrl = options?.baseUrl;
  if (!baseUrl) {
    try {
      const config = getConfig();
      baseUrl = config.md_api_url || DEFAULT_MD_API_URL;
    } catch {
      baseUrl = DEFAULT_MD_API_URL;
    }
  }

  const timeout = options?.timeout ?? 60_000; // extraction can be slow

  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Only http:// and https:// URLs are supported');
  }

  const base = baseUrl.replace(/\/+$/, '');
  const apiUrl = `${base}/extract`;

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ url, schema }),
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`md.succ.ai /extract error: HTTP ${response.status} — ${body.slice(0, 200)}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`md.succ.ai extraction failed: ${data.error}`);
  }

  return {
    valid: data.valid ?? true,
    data: data.data || {},
    url: data.url || url,
  };
}
