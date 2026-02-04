/**
 * Skyll API Client
 *
 * Integrates with Skyll (https://github.com/assafelovic/skyll) for external skill discovery.
 * Uses aggressive caching to minimize API calls (rate limit: 60 req/hour without API key).
 *
 * Features:
 * - Search skills by keywords
 * - Get skill details
 * - Local DB caching with TTL
 * - Rate limiting
 */

import { getDb } from './db.js';
import { getConfig } from './config.js';
import type { Skill } from './skills.js';

// ============================================================================
// Types
// ============================================================================

export interface SkyllSkill {
  id: string;
  title: string; // Skyll API uses 'title' not 'name'
  description: string;
  source?: string;
  version?: string;
  refs?: {
    skills_sh?: string;
    github?: string;
    raw?: string;
  };
  content?: string;
  install_count?: number;
  relevance_score?: number;
}

export interface SkyllSearchResult {
  query: string;
  count: number;
  skills: SkyllSkill[];
}

interface SkyllConfig {
  enabled: boolean;
  endpoint: string;
  apiKey?: string;
  cacheTtl: number; // seconds
  onlyWhenNoLocal: boolean;
  rateLimit: number; // requests per hour
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_SKYLL_CONFIG: SkyllConfig = {
  enabled: true,
  endpoint: 'https://api.skyll.app',
  cacheTtl: 604800, // 7 days
  onlyWhenNoLocal: true,
  rateLimit: 30, // Conservative: 30 req/hour (actual limit is 60)
};

// ============================================================================
// Rate Limiting
// ============================================================================

interface RateLimitState {
  requests: number[];
  hourStart: number;
}

let rateLimitState: RateLimitState = {
  requests: [],
  hourStart: Date.now(),
};

function checkRateLimit(limit: number): boolean {
  const now = Date.now();
  const hourAgo = now - 3600000;

  // Reset if hour passed
  if (rateLimitState.hourStart < hourAgo) {
    rateLimitState = { requests: [], hourStart: now };
  }

  // Filter old requests
  rateLimitState.requests = rateLimitState.requests.filter((t) => t > hourAgo);

  return rateLimitState.requests.length < limit;
}

function recordRequest(): void {
  rateLimitState.requests.push(Date.now());
}

// ============================================================================
// Cache
// ============================================================================

function getCachedSkills(query: string): Skill[] | null {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    const rows = db
      .prepare(
        `SELECT id, name, description, source, skyll_id, content, usage_count, last_used
         FROM skills
         WHERE source = 'skyll'
           AND cache_expires > ?
           AND (name LIKE ? OR description LIKE ?)`
      )
      .all(now, `%${query}%`, `%${query}%`) as Skill[];

    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

function cacheSkills(skills: SkyllSkill[], ttlSeconds: number): void {
  const db = getDb();
  const now = new Date();
  const expires = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

  for (const skill of skills) {
    try {
      db.prepare(
        `INSERT INTO skills (name, description, source, skyll_id, content, cached_at, cache_expires, created_at, updated_at)
         VALUES (?, ?, 'skyll', ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(name) DO UPDATE SET
           description = excluded.description,
           skyll_id = excluded.skyll_id,
           content = excluded.content,
           cached_at = excluded.cached_at,
           cache_expires = excluded.cache_expires,
           updated_at = datetime('now')`
      ).run(
        skill.title || skill.id, // Skyll uses 'title' not 'name'
        skill.description,
        skill.id,
        skill.content || null,
        now.toISOString(),
        expires
      );
    } catch {
      // Ignore cache errors
    }
  }
}

// ============================================================================
// API Client
// ============================================================================

function getSkyllConfig(): SkyllConfig {
  const config = getConfig();
  const skyllConfig = config.skills?.skyll || {};

  return {
    enabled: skyllConfig.enabled !== false,
    endpoint: skyllConfig.endpoint || DEFAULT_SKYLL_CONFIG.endpoint,
    apiKey: skyllConfig.api_key || process.env.SKYLL_API_KEY,
    cacheTtl: skyllConfig.cache_ttl || DEFAULT_SKYLL_CONFIG.cacheTtl,
    onlyWhenNoLocal: skyllConfig.only_when_no_local !== false,
    rateLimit: skyllConfig.rate_limit || DEFAULT_SKYLL_CONFIG.rateLimit,
  };
}

/**
 * Search Skyll API for skills matching keywords
 */
export async function searchSkyll(
  keywords: string[],
  options: { limit?: number; skipCache?: boolean } = {}
): Promise<Skill[]> {
  const { limit = 10, skipCache = false } = options;
  const config = getSkyllConfig();

  console.log(`[skyll] searchSkyll called with keywords: ${JSON.stringify(keywords)}, enabled=${config.enabled}`);

  if (!config.enabled) {
    console.log(`[skyll] Skyll disabled, returning empty`);
    return [];
  }

  const query = keywords.join(' ');

  // Check cache first
  if (!skipCache) {
    const cached = getCachedSkills(query);
    if (cached && cached.length > 0) {
      return cached.slice(0, limit);
    }
  }

  // Check rate limit
  if (!checkRateLimit(config.rateLimit)) {
    console.warn('[skyll] Rate limit reached, using cache only');
    return getCachedSkills(query) || [];
  }

  try {
    // Skyll API uses GET with query params: /search?q=...&limit=...
    const searchUrl = `${config.endpoint}/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    console.log(`[skyll] Calling API: ${searchUrl}`);

    const headers: Record<string, string> = {};

    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(searchUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10000),
    });

    recordRequest();

    if (!response.ok) {
      if (response.status === 429) {
        console.warn('[skyll] Rate limited by API');
      }
      return getCachedSkills(query) || [];
    }

    const data = (await response.json()) as SkyllSearchResult;
    console.log(`[skyll] API returned ${data.skills?.length || 0} skills`);

    // Cache results
    if (data.skills && data.skills.length > 0) {
      cacheSkills(data.skills, config.cacheTtl);
    }

    // Convert to Skill format (Skyll uses 'title' not 'name')
    return data.skills.slice(0, limit).map((s) => ({
      name: s.title || s.id,
      description: s.description,
      source: 'skyll' as const,
      skyll_id: s.id,
      content: s.content,
    }));
  } catch (err) {
    console.error('[skyll] Search failed:', err);
    return getCachedSkills(query) || [];
  }
}

/**
 * Get skill details from Skyll API
 */
export async function getSkyllSkill(skillId: string): Promise<Skill | null> {
  const config = getSkyllConfig();

  if (!config.enabled) {
    return null;
  }

  // Check cache first
  const db = getDb();
  try {
    const cached = db
      .prepare(
        `SELECT id, name, description, source, skyll_id, content, usage_count, last_used
         FROM skills WHERE skyll_id = ? AND cache_expires > datetime('now')`
      )
      .get(skillId) as Skill | undefined;

    if (cached) {
      return cached;
    }
  } catch {
    // Ignore cache errors
  }

  // Check rate limit
  if (!checkRateLimit(config.rateLimit)) {
    return null;
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(`${config.endpoint}/v1/skills/${skillId}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10000),
    });

    recordRequest();

    if (!response.ok) {
      return null;
    }

    const skill = (await response.json()) as SkyllSkill;

    // Cache result
    cacheSkills([skill], config.cacheTtl);

    return {
      name: skill.title || skill.id,
      description: skill.description,
      source: 'skyll' as const,
      skyll_id: skill.id,
      content: skill.content,
    };
  } catch (err) {
    console.error('[skyll] Get skill failed:', err);
    return null;
  }
}

/**
 * Clear expired cache entries
 */
export function clearExpiredCache(): number {
  const db = getDb();
  try {
    const result = db
      .prepare(`DELETE FROM skills WHERE source = 'skyll' AND cache_expires < datetime('now')`)
      .run();
    return result.changes;
  } catch {
    return 0;
  }
}

/**
 * Get Skyll API status
 */
export function getSkyllStatus(): {
  enabled: boolean;
  hasApiKey: boolean;
  requestsThisHour: number;
  rateLimit: number;
  cachedSkills: number;
} {
  const config = getSkyllConfig();
  const db = getDb();

  let cachedSkills = 0;
  try {
    const row = db.prepare(`SELECT COUNT(*) as count FROM skills WHERE source = 'skyll'`).get() as {
      count: number;
    };
    cachedSkills = row.count;
  } catch {
    // Ignore
  }

  return {
    enabled: config.enabled,
    hasApiKey: !!config.apiKey,
    requestsThisHour: rateLimitState.requests.length,
    rateLimit: config.rateLimit,
    cachedSkills,
  };
}
