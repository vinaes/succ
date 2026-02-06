/**
 * Skills Discovery and Suggestion
 *
 * Provides LLM-powered skill suggestions based on user prompts.
 * Supports three LLM backends: Claude CLI, Local LLM, OpenRouter.
 *
 * Flow:
 * 1. Fast heuristics (length, cooldown)
 * 2. LLM keyword extraction (multilingual)
 * 3. BM25 search for skill candidates
 * 4. LLM ranking with reasoning
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDb } from './db/index.js';
import { getSuccDir, getConfig, getProjectRoot } from './config.js';
import * as bm25 from './bm25.js';
import { searchSkyll } from './skyll-client.js';
import { callLLM as sharedCallLLM, getLLMConfig, type LLMBackend } from './llm.js';
import {
  KEYWORD_EXTRACTION_PROMPT as KEYWORD_PROMPT,
  SKILL_RANKING_PROMPT as RANKING_PROMPT,
} from '../prompts/index.js';

// ============================================================================
// Types
// ============================================================================

export type { LLMBackend } from './llm.js';

export interface Skill {
  id?: number;
  name: string;
  description: string;
  source: 'local' | 'skyll';
  path?: string;
  content?: string;
  skyll_id?: string;
  usage_count?: number;
  last_used?: string;
}

export interface SkillSuggestion extends Skill {
  reason: string;
  confidence: number;
}

import type { SkillsConfig } from './config.js';
export type { SkillsConfig } from './config.js';

interface LLMConfig {
  backend: LLMBackend;
  model: string;
  localEndpoint?: string;
  openrouterModel?: string;
}

// ============================================================================
// Default Config
// ============================================================================

// Auto-suggest settings (LLM config comes from unified llm.* config)
const DEFAULT_AUTO_SUGGEST = {
  enabled: false, // Disabled by default - enable in config if needed
  on_user_prompt: true,
  min_confidence: 0.7,
  max_suggestions: 2,
  cooldown_prompts: 3,
  min_prompt_length: 20,
};

const DEFAULT_SKILLS_CONFIG = {
  enabled: false, // Disabled by default - enable in config if needed
  local_paths: ['.claude/commands'],
  auto_suggest: DEFAULT_AUTO_SUGGEST,
  track_usage: true,
};

// ============================================================================
// Suggestion Cache (TTL 5 minutes)
// ============================================================================

interface CachedSuggestion {
  suggestions: SkillSuggestion[];
  timestamp: number;
}

const suggestionCache = new Map<string, CachedSuggestion>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function hashPrompt(prompt: string): string {
  // Simple hash for cache key (first 100 chars lowercase)
  return prompt.toLowerCase().trim().slice(0, 100);
}

function getCachedSuggestions(prompt: string): SkillSuggestion[] | null {
  const key = hashPrompt(prompt);
  const cached = suggestionCache.get(key);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.suggestions;
  }

  // Cleanup expired entries
  if (cached) {
    suggestionCache.delete(key);
  }

  return null;
}

function cacheSuggestions(prompt: string, suggestions: SkillSuggestion[]): void {
  const key = hashPrompt(prompt);
  suggestionCache.set(key, {
    suggestions,
    timestamp: Date.now(),
  });

  // Limit cache size to 50 entries (LRU-like cleanup)
  if (suggestionCache.size > 50) {
    const oldestKey = suggestionCache.keys().next().value;
    if (oldestKey) {
      suggestionCache.delete(oldestKey);
    }
  }
}

// ============================================================================
// BM25 Index
// ============================================================================

let skillsBm25Index: bm25.BM25Index | null = null;
const BM25_FAST_PATH_THRESHOLD = 0.8; // Skip LLM ranking if top BM25 score > 0.8

function getSkillsBm25Index(): bm25.BM25Index {
  if (skillsBm25Index) {
    return skillsBm25Index;
  }

  const db = getDb();
  const projectId = getProjectRoot().replace(/\\/g, '/');
  // Include both project-specific local skills AND global Skyll cached skills (project_id IS NULL)
  const rows = db.prepare(
    `SELECT id, name, description, content FROM skills
     WHERE project_id = ? OR project_id IS NULL`
  ).all(projectId) as Array<{
    id: number;
    name: string;
    description: string;
    content: string | null;
  }>;

  // Build searchable content from name + description + content
  const docs = rows.map((r) => ({
    id: r.id,
    content: `${r.name} ${r.description} ${r.content || ''}`,
  }));

  skillsBm25Index = bm25.buildIndex(docs, 'docs');
  return skillsBm25Index;
}

export function invalidateSkillsIndex(): void {
  skillsBm25Index = null;
}

// ============================================================================
// LLM Integration (uses shared llm.ts module)
// ============================================================================

/**
 * Call LLM with skills-specific config
 * Wraps the shared LLM module with local config mapping
 */
async function callLLM(prompt: string, config: LLMConfig, timeout: number = 15000): Promise<string> {
  return sharedCallLLM(prompt, { timeout, maxTokens: 500 }, {
    backend: config.backend,
    model: config.model,
    localEndpoint: config.localEndpoint,
    openrouterModel: config.openrouterModel,
  });
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Extract technical keywords from user prompt using LLM
 */
export async function extractKeywords(
  prompt: string,
  config: LLMConfig
): Promise<string[]> {
  const llmPrompt = KEYWORD_PROMPT.replace('{prompt}', prompt.slice(0, 500));

  try {
    console.log(`[skills] Calling LLM for keyword extraction (backend=${config.backend})`);
    const result = await callLLM(llmPrompt, config, 30000); // 30s timeout for slow models
    console.log(`[skills] LLM result: ${result.slice(0, 200)}`);

    // Parse JSON response
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]) as { keywords?: string[] };
    const keywords = Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 5) : [];
    console.log(`[skills] Extracted keywords: ${JSON.stringify(keywords)}`);
    return keywords;
  } catch (err) {
    console.error(`[skills] extractKeywords failed:`, err);
    return [];
  }
}

/**
 * Search for skill candidates using BM25
 * Returns skills and top BM25 score for fast-path optimization
 */
export function searchSkillCandidates(
  keywords: string[],
  limit: number = 15
): { skills: Skill[]; topScore: number } {
  if (keywords.length === 0) {
    return { skills: [], topScore: 0 };
  }

  const db = getDb();
  const index = getSkillsBm25Index();

  // Search with combined keywords
  const query = keywords.join(' ');
  const results = bm25.search(query, index, 'docs', limit);

  if (results.length === 0) {
    return { skills: [], topScore: 0 };
  }

  const ids = results.map((r) => r.docId);
  const placeholders = ids.map(() => '?').join(',');

  const rows = db
    .prepare(
      `SELECT id, name, description, source, path, usage_count, last_used
       FROM skills WHERE id IN (${placeholders})`
    )
    .all(...ids) as Skill[];

  // Sort by BM25 score order
  const idToScore = new Map(results.map((r) => [r.docId, r.score]));
  const sortedSkills = rows.sort((a, b) => (idToScore.get(b.id!) || 0) - (idToScore.get(a.id!) || 0));

  return {
    skills: sortedSkills,
    topScore: results[0]?.score || 0,
  };
}

/**
 * Rank skill candidates using LLM
 */
export async function rankSkillsWithLLM(
  userPrompt: string,
  candidates: Skill[],
  config: LLMConfig,
  options: { limit?: number; minConfidence?: number } = {}
): Promise<SkillSuggestion[]> {
  const { limit = 2, minConfidence = 0.7 } = options;

  if (candidates.length === 0) {
    return [];
  }

  // Format skills list with usage indicator
  const skillsList = candidates
    .map((s, i) => {
      const usedMarker = s.usage_count && s.usage_count > 0 ? ' *' : '';
      return `${i + 1}. ${s.name}${usedMarker}: ${s.description}`;
    })
    .join('\n');

  const llmPrompt = RANKING_PROMPT.replace('{user_prompt}', userPrompt.slice(0, 500)).replace(
    '{skills_list}',
    skillsList
  );

  // Use lightweight models for ranking (simple task)
  const rankingConfig = { ...config };
  if (config.backend === 'local') {
    // Prefer smaller, faster model for ranking
    rankingConfig.model = config.model?.includes('qwen') ? 'qwen2.5:0.5b' : config.model;
  } else if (config.backend === 'openrouter') {
    // Prefer Haiku for ranking (5x cheaper than Sonnet)
    rankingConfig.openrouterModel = 'anthropic/claude-3-haiku';
  }

  try {
    console.log(`[skills] Ranking ${candidates.length} candidates with LLM (model=${rankingConfig.model || rankingConfig.openrouterModel})`);
    const result = await callLLM(llmPrompt, rankingConfig, 30000);
    console.log(`[skills] Ranking result: ${result.slice(0, 300)}`);

    // Parse JSON response
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log(`[skills] No JSON found in ranking result`);
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      suggestions?: Array<{ name: string; reason: string; confidence: number }>;
    };
    console.log(`[skills] Parsed suggestions: ${JSON.stringify(parsed.suggestions)}`);

    if (!Array.isArray(parsed.suggestions)) {
      return [];
    }

    // Map suggestions to full skill data
    const mapped = parsed.suggestions
      .filter((s) => s.confidence >= minConfidence)
      .slice(0, limit)
      .map((s) => {
        const skill = candidates.find((c) => c.name === s.name);
        if (!skill) {
          console.log(`[skills] Skill not found: ${s.name}`);
          return null;
        }
        return {
          ...skill,
          reason: s.reason,
          confidence: s.confidence,
        };
      })
      .filter((s): s is SkillSuggestion => s !== null);

    console.log(`[skills] Final suggestions: ${mapped.length}`);
    return mapped;
  } catch (err) {
    console.error(`[skills] rankSkillsWithLLM failed:`, err);
    return [];
  }
}

/**
 * Main suggestion function with fallback chain
 */
export async function suggestSkills(
  userPrompt: string,
  config?: Partial<SkillsConfig>
): Promise<SkillSuggestion[]> {
  const autoSuggest = { ...DEFAULT_AUTO_SUGGEST, ...config?.auto_suggest };

  // Check cache first
  const cached = getCachedSuggestions(userPrompt);
  if (cached) {
    console.log('[skills] Returning cached suggestions');
    return cached;
  }

  // Get unified LLM config
  const llmConfig = getLLMConfig();

  // Build LLM config from unified llm.* settings
  const baseLlmConfig: LLMConfig = {
    backend: llmConfig.backend,
    model: llmConfig.model,
    localEndpoint: llmConfig.localEndpoint,
    openrouterModel: llmConfig.openrouterModel,
  };

  // Fallback chain - local first to avoid ToS issues
  const backends: LLMBackend[] = ['local', 'openrouter', 'claude'];
  const orderedBackends = [
    llmConfig.backend,
    ...backends.filter((b) => b !== llmConfig.backend),
  ];

  for (const backend of orderedBackends) {
    try {
      const backendConfig = { ...baseLlmConfig, backend };

      // Step 1: Extract keywords
      const keywords = await extractKeywords(userPrompt, backendConfig);
      if (keywords.length === 0) {
        return [];
      }

      // Step 2: Search candidates (local first, then Skyll if enabled)
      console.log(`[skills] Searching candidates for keywords: ${JSON.stringify(keywords)}`);
      const { skills: candidateSkills, topScore } = searchSkillCandidates(keywords, 15);
      console.log(`[skills] Found ${candidateSkills.length} local candidates (topScore: ${topScore.toFixed(2)})`);

      // Skyll fallback: if no local candidates or onlyWhenNoLocal is false
      const skyllConfig = config?.skyll || {};
      const skyllEnabled = skyllConfig.enabled !== false;
      const onlyWhenNoLocal = skyllConfig.only_when_no_local !== false;

      let candidates = candidateSkills;

      if (skyllEnabled && (candidates.length === 0 || !onlyWhenNoLocal)) {
        try {
          const skyllResults = await searchSkyll(keywords, { limit: 10 });
          if (skyllResults.length > 0) {
            // Merge: local first, then Skyll (avoiding duplicates by name)
            const existingNames = new Set(candidates.map((c) => c.name.toLowerCase()));
            const newSkills = skyllResults.filter(
              (s) => !existingNames.has(s.name.toLowerCase())
            );
            candidates = [...candidates, ...newSkills].slice(0, 15);
          }
        } catch (err) {
          console.error('[skills] Skyll search failed:', err);
        }
      }

      if (candidates.length === 0) {
        return [];
      }

      // Fast path: if top BM25 score is very high, skip LLM ranking
      if (topScore >= BM25_FAST_PATH_THRESHOLD) {
        console.log(`[skills] Fast path: topScore ${topScore.toFixed(2)} >= ${BM25_FAST_PATH_THRESHOLD}, skipping LLM ranking`);
        const fastPathResults: SkillSuggestion[] = candidates
          .slice(0, autoSuggest.max_suggestions)
          .map((skill) => ({
            ...skill,
            reason: `High relevance match (score: ${topScore.toFixed(2)})`,
            confidence: Math.min(topScore, 0.95), // Cap at 0.95 since no LLM validation
          }));

        // Cache before returning
        cacheSuggestions(userPrompt, fastPathResults);
        return fastPathResults;
      }

      // Step 3: Rank with LLM
      const ranked = await rankSkillsWithLLM(userPrompt, candidates, backendConfig, {
        limit: autoSuggest.max_suggestions,
        minConfidence: autoSuggest.min_confidence,
      });

      // Cache before returning
      cacheSuggestions(userPrompt, ranked);
      return ranked;
    } catch (err) {
      console.error(`[skills] ${backend} failed:`, err);
      // Try next backend
    }
  }

  return [];
}

// ============================================================================
// Local Skills Scanning
// ============================================================================

/**
 * Parse SKILL.md frontmatter
 */
function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  // Normalize line endings for cross-platform support
  const normalized = content.replace(/\r\n/g, '\n');
  const frontmatterMatch = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return {};
  }

  const frontmatter = frontmatterMatch[1];
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

  return {
    name: nameMatch?.[1]?.trim(),
    description: descMatch?.[1]?.trim(),
  };
}

/**
 * Scan local skills from .claude/commands/ directory
 */
export function scanLocalSkills(projectDir: string): Skill[] {
  const config = getConfig();
  const localPaths = config.skills?.local_paths || DEFAULT_SKILLS_CONFIG.local_paths;
  const skills: Skill[] = [];

  for (const localPath of localPaths) {
    const skillsDir = path.join(projectDir, localPath);

    if (!fs.existsSync(skillsDir)) {
      continue;
    }

    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        // Single file skill (name.md)
        const filePath = path.join(skillsDir, entry.name);
        const content = fs.readFileSync(filePath, 'utf8');
        const { name, description } = parseSkillFrontmatter(content);

        skills.push({
          name: name || entry.name.replace('.md', ''),
          description: description || `Skill from ${entry.name}`,
          source: 'local',
          path: filePath,
          content,
        });
      } else if (entry.isDirectory()) {
        // Directory skill (name/SKILL.md)
        const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
        if (fs.existsSync(skillMdPath)) {
          const content = fs.readFileSync(skillMdPath, 'utf8');
          const { name, description } = parseSkillFrontmatter(content);

          skills.push({
            name: name || entry.name,
            description: description || `Skill from ${entry.name}`,
            source: 'local',
            path: skillMdPath,
            content,
          });
        }
      }
    }
  }

  return skills;
}

/**
 * Index local skills into database
 */
export function indexLocalSkills(projectDir: string): number {
  const skills = scanLocalSkills(projectDir);
  const db = getDb();
  const projectId = getProjectRoot().replace(/\\/g, '/');

  let indexed = 0;

  for (const skill of skills) {
    try {
      // Local skills are project-scoped
      // Use INSERT OR REPLACE for SQLite compatibility (works with UNIQUE(name) constraint)
      db.prepare(
        `INSERT OR REPLACE INTO skills (project_id, name, description, source, path, content, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      ).run(projectId, skill.name, skill.description, skill.source, skill.path, skill.content);
      indexed++;
    } catch (err) {
      console.warn('[skyll]', err instanceof Error ? err.message : 'Failed to index skill');
    }
  }

  // Invalidate BM25 index
  invalidateSkillsIndex();

  return indexed;
}

/**
 * Track skill usage
 */
export function trackSkillUsage(skillName: string): void {
  const db = getDb();
  const projectId = getProjectRoot().replace(/\\/g, '/');
  try {
    // Update both project-specific and global (Skyll) skills matching the name
    db.prepare(
      `UPDATE skills SET usage_count = usage_count + 1, last_used = datetime('now')
       WHERE name = ? AND (project_id = ? OR project_id IS NULL)`
    ).run(skillName, projectId);
  } catch (err) {
    console.warn('[skyll]', err instanceof Error ? err.message : 'Failed to track skill usage');
  }
}

/**
 * Get skills config from main config
 */
export function getSkillsConfig(): SkillsConfig {
  const config = getConfig();
  return {
    ...DEFAULT_SKILLS_CONFIG,
    ...config.skills,
    auto_suggest: {
      ...DEFAULT_SKILLS_CONFIG.auto_suggest,
      ...config.skills?.auto_suggest,
    },
  };
}
