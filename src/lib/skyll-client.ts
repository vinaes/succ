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

import {
  upsertSkill,
  getCachedSkyllSkill as getCachedSkyllSkillDb,
  clearExpiredSkyllCache as clearExpiredSkyllCacheDb,
  getSkyllCacheStats as getSkyllCacheStatsDb,
  searchSkillsDb,
} from './storage/index.js';
import { getConfig } from './config.js';
import { logError, logWarn, logInfo } from './fault-logger.js';
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

async function getCachedSkills(query: string): Promise<Skill[] | null> {
  try {
    // Search via dispatcher (handles both PG and SQLite)
    const rows = await searchSkillsDb(query, 20);
    // Filter to only Skyll cached results
    const skyllRows = rows
      .filter((r) => r.source === 'skyll')
      .map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        source: 'skyll' as const,
      }));
    return skyllRows.length > 0 ? skyllRows : null;
  } catch (err) {
    logWarn('skyll', err instanceof Error ? err.message : 'Failed to get cached skills');
    return null;
  }
}

async function cacheSkills(skills: SkyllSkill[], ttlSeconds: number): Promise<void> {
  const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  for (const skill of skills) {
    try {
      await upsertSkill({
        name: skill.title || skill.id,
        description: skill.description,
        source: 'skyll',
        skyllId: skill.id,
        content: skill.content,
        cacheExpires: expires,
      });
    } catch (err) {
      logWarn('skyll', err instanceof Error ? err.message : 'Failed to cache skill');
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

  logInfo(
    'skyll',
    `searchSkyll called with keywords: ${JSON.stringify(keywords)}, enabled=${config.enabled}`
  );

  if (!config.enabled) {
    logInfo('skyll', 'Skyll disabled, returning empty');
    return [];
  }

  const query = keywords.join(' ');

  // Check cache first
  if (!skipCache) {
    const cached = await getCachedSkills(query);
    if (cached && cached.length > 0) {
      return cached.slice(0, limit);
    }
  }

  // Check rate limit
  if (!checkRateLimit(config.rateLimit)) {
    logWarn('skyll', 'Rate limit reached, using cache only');
    return (await getCachedSkills(query)) || [];
  }

  try {
    // Skyll API uses GET with query params: /search?q=...&limit=...
    const searchUrl = `${config.endpoint}/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    logInfo('skyll', `Calling API: ${searchUrl}`);

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
        logWarn('skyll', 'Rate limited by API');
      }
      return (await getCachedSkills(query)) || [];
    }

    const data = (await response.json()) as SkyllSearchResult;
    logInfo('skyll', `API returned ${data.skills?.length || 0} skills`);

    // Cache results
    if (data.skills && data.skills.length > 0) {
      await cacheSkills(data.skills, config.cacheTtl);
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
    logError('skyll', 'Search failed', err instanceof Error ? err : new Error(String(err)));
    return (await getCachedSkills(query)) || [];
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

  // Check cache first (via dispatcher)
  try {
    const cached = await getCachedSkyllSkillDb(skillId);
    if (cached) {
      return {
        name: cached.name,
        description: cached.description,
        source: 'skyll' as const,
        skyll_id: skillId,
        content: cached.content,
      };
    }
  } catch (err) {
    logWarn('skyll', err instanceof Error ? err.message : 'Failed to get cached skill');
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
    await cacheSkills([skill], config.cacheTtl);

    return {
      name: skill.title || skill.id,
      description: skill.description,
      source: 'skyll' as const,
      skyll_id: skill.id,
      content: skill.content,
    };
  } catch (err) {
    logError('skyll', 'Get skill failed', err instanceof Error ? err : new Error(String(err)));
    return null;
  }
}

/**
 * Clear expired cache entries
 */
export async function clearExpiredCache(): Promise<number> {
  try {
    return await clearExpiredSkyllCacheDb();
  } catch (err) {
    logWarn('skyll', err instanceof Error ? err.message : 'Failed to clear expired cache');
    return 0;
  }
}

/**
 * Get Skyll API status
 */
export async function getSkyllStatus(): Promise<{
  enabled: boolean;
  hasApiKey: boolean;
  requestsThisHour: number;
  rateLimit: number;
  cachedSkills: number;
}> {
  const config = getSkyllConfig();

  let cachedSkills = 0;
  try {
    const stats = await getSkyllCacheStatsDb();
    cachedSkills = stats.cachedSkills;
  } catch (err) {
    logWarn('skyll', err instanceof Error ? err.message : 'Failed to count cached skills');
  }

  return {
    enabled: config.enabled,
    hasApiKey: !!config.apiKey,
    requestsThisHour: rateLimitState.requests.length,
    rateLimit: config.rateLimit,
    cachedSkills,
  };
}
