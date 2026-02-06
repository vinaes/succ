/**
 * Memory Retention Policy with Decay
 *
 * Implements automatic memory cleanup based on:
 * - Quality score (from quality scoring system)
 * - Time-based decay (older memories decay in value)
 * - Access frequency (frequently accessed memories are preserved)
 *
 * Formula:
 *   effective_score = quality_score * recency_factor * access_boost
 *
 *   recency_factor = 1 / (1 + decay_rate * days_since_creation)
 *   access_boost = min(1 + (access_weight * access_count), max_boost)
 *
 * Tiers:
 *   - keep: effective_score >= keep_threshold (default 0.3)
 *   - warn: effective_score >= delete_threshold && < keep_threshold
 *   - delete: effective_score < delete_threshold (default 0.15)
 */

import { MemoryForRetention } from './db/index.js';

// Default configuration
export const DEFAULT_RETENTION_CONFIG = {
  // Decay rate: higher = faster decay
  // 0.01 means at 100 days, recency_factor ≈ 0.5
  decay_rate: 0.01,

  // Access boost per access (weighted: exact=1, similarity=0.5)
  access_weight: 0.1,

  // Maximum access boost multiplier
  max_access_boost: 2.0,

  // Threshold for keeping memories
  keep_threshold: 0.3,

  // Threshold below which memories are deleted
  delete_threshold: 0.15,

  // Default quality score for memories without one
  default_quality_score: 0.5,
};

export interface RetentionConfig {
  decay_rate?: number;
  access_weight?: number;
  max_access_boost?: number;
  keep_threshold?: number;
  delete_threshold?: number;
  default_quality_score?: number;
}

export interface EffectiveScoreResult {
  memoryId: number;
  content: string;
  qualityScore: number;
  accessCount: number;
  ageDays: number;
  recencyFactor: number;
  accessBoost: number;
  effectiveScore: number;
  tier: 'keep' | 'warn' | 'delete';
}

/**
 * Calculate the recency factor based on age.
 * Returns a value between 0 and 1, where 1 is brand new.
 */
export function calculateRecencyFactor(ageDays: number, decayRate: number): number {
  return 1 / (1 + decayRate * ageDays);
}

/**
 * Calculate the access boost based on access count.
 * Returns a multiplier >= 1.
 */
export function calculateAccessBoost(
  accessCount: number,
  accessWeight: number,
  maxBoost: number
): number {
  return Math.min(1 + accessWeight * accessCount, maxBoost);
}

/**
 * Calculate the effective score for a memory.
 */
export function calculateEffectiveScore(
  memory: MemoryForRetention,
  config: RetentionConfig = {}
): EffectiveScoreResult {
  const cfg = { ...DEFAULT_RETENTION_CONFIG, ...config };

  // Calculate age in days
  const createdAt = new Date(memory.created_at);
  const now = new Date();
  const ageDays = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);

  // Get quality score (use default if not set)
  const qualityScore = memory.quality_score ?? cfg.default_quality_score;

  // Calculate factors
  const recencyFactor = calculateRecencyFactor(ageDays, cfg.decay_rate);
  const accessBoost = calculateAccessBoost(memory.access_count, cfg.access_weight, cfg.max_access_boost);

  // Calculate effective score
  const effectiveScore = qualityScore * recencyFactor * accessBoost;

  // Determine tier
  let tier: 'keep' | 'warn' | 'delete';
  if (effectiveScore >= cfg.keep_threshold) {
    tier = 'keep';
  } else if (effectiveScore >= cfg.delete_threshold) {
    tier = 'warn';
  } else {
    tier = 'delete';
  }

  return {
    memoryId: memory.id,
    content: memory.content,
    qualityScore,
    accessCount: memory.access_count,
    ageDays: Math.round(ageDays),
    recencyFactor: Math.round(recencyFactor * 1000) / 1000,
    accessBoost: Math.round(accessBoost * 100) / 100,
    effectiveScore: Math.round(effectiveScore * 1000) / 1000,
    tier,
  };
}

/**
 * Analyze all memories and categorize by retention tier.
 */
export function analyzeRetention(
  memories: MemoryForRetention[],
  config: RetentionConfig = {}
): {
  keep: EffectiveScoreResult[];
  warn: EffectiveScoreResult[];
  delete: EffectiveScoreResult[];
  stats: RetentionStats;
} {
  const results = memories.map((m) => calculateEffectiveScore(m, config));

  const keep = results.filter((r) => r.tier === 'keep');
  const warn = results.filter((r) => r.tier === 'warn');
  const toDelete = results.filter((r) => r.tier === 'delete');

  // Sort by effective score (lowest first for delete candidates)
  toDelete.sort((a, b) => a.effectiveScore - b.effectiveScore);
  warn.sort((a, b) => a.effectiveScore - b.effectiveScore);
  keep.sort((a, b) => b.effectiveScore - a.effectiveScore);

  const stats = calculateRetentionStats(results);

  return { keep, warn, delete: toDelete, stats };
}

export interface RetentionStats {
  totalMemories: number;
  keepCount: number;
  warnCount: number;
  deleteCount: number;
  avgEffectiveScore: number;
  avgQualityScore: number;
  avgAgeDays: number;
  avgAccessCount: number;
  // Score distribution
  scoreDistribution: {
    high: number;    // >= 0.6
    medium: number;  // >= 0.3 && < 0.6
    low: number;     // >= 0.15 && < 0.3
    critical: number; // < 0.15
  };
}

/**
 * Calculate retention statistics.
 */
export function calculateRetentionStats(results: EffectiveScoreResult[]): RetentionStats {
  if (results.length === 0) {
    return {
      totalMemories: 0,
      keepCount: 0,
      warnCount: 0,
      deleteCount: 0,
      avgEffectiveScore: 0,
      avgQualityScore: 0,
      avgAgeDays: 0,
      avgAccessCount: 0,
      scoreDistribution: { high: 0, medium: 0, low: 0, critical: 0 },
    };
  }

  const keepCount = results.filter((r) => r.tier === 'keep').length;
  const warnCount = results.filter((r) => r.tier === 'warn').length;
  const deleteCount = results.filter((r) => r.tier === 'delete').length;

  const sumEffective = results.reduce((sum, r) => sum + r.effectiveScore, 0);
  const sumQuality = results.reduce((sum, r) => sum + r.qualityScore, 0);
  const sumAge = results.reduce((sum, r) => sum + r.ageDays, 0);
  const sumAccess = results.reduce((sum, r) => sum + r.accessCount, 0);

  const scoreDistribution = {
    high: results.filter((r) => r.effectiveScore >= 0.6).length,
    medium: results.filter((r) => r.effectiveScore >= 0.3 && r.effectiveScore < 0.6).length,
    low: results.filter((r) => r.effectiveScore >= 0.15 && r.effectiveScore < 0.3).length,
    critical: results.filter((r) => r.effectiveScore < 0.15).length,
  };

  return {
    totalMemories: results.length,
    keepCount,
    warnCount,
    deleteCount,
    avgEffectiveScore: Math.round((sumEffective / results.length) * 1000) / 1000,
    avgQualityScore: Math.round((sumQuality / results.length) * 1000) / 1000,
    avgAgeDays: Math.round(sumAge / results.length),
    avgAccessCount: Math.round((sumAccess / results.length) * 10) / 10,
    scoreDistribution,
  };
}

/**
 * Format retention analysis for CLI output.
 */
export function formatRetentionAnalysis(
  analysis: {
    keep: EffectiveScoreResult[];
    warn: EffectiveScoreResult[];
    delete: EffectiveScoreResult[];
    stats: RetentionStats;
  },
  verbose: boolean = false
): string {
  const lines: string[] = [];
  const { stats } = analysis;

  lines.push('=== Memory Retention Analysis ===\n');

  // Summary
  lines.push('## Summary');
  lines.push(`Total memories: ${stats.totalMemories}`);
  lines.push(`  Keep:   ${stats.keepCount} (${percent(stats.keepCount, stats.totalMemories)})`);
  lines.push(`  Warn:   ${stats.warnCount} (${percent(stats.warnCount, stats.totalMemories)})`);
  lines.push(`  Delete: ${stats.deleteCount} (${percent(stats.deleteCount, stats.totalMemories)})`);
  lines.push('');

  // Score distribution
  lines.push('## Score Distribution');
  lines.push(`  High (≥0.6):     ${stats.scoreDistribution.high}`);
  lines.push(`  Medium (0.3-0.6): ${stats.scoreDistribution.medium}`);
  lines.push(`  Low (0.15-0.3):   ${stats.scoreDistribution.low}`);
  lines.push(`  Critical (<0.15): ${stats.scoreDistribution.critical}`);
  lines.push('');

  // Averages
  lines.push('## Averages');
  lines.push(`  Effective score: ${stats.avgEffectiveScore}`);
  lines.push(`  Quality score:   ${stats.avgQualityScore}`);
  lines.push(`  Age (days):      ${stats.avgAgeDays}`);
  lines.push(`  Access count:    ${stats.avgAccessCount}`);
  lines.push('');

  // Delete candidates
  if (analysis.delete.length > 0) {
    lines.push('## Delete Candidates');
    const showCount = verbose ? analysis.delete.length : Math.min(10, analysis.delete.length);
    for (let i = 0; i < showCount; i++) {
      const m = analysis.delete[i];
      const preview = m.content.slice(0, 60).replace(/\n/g, ' ');
      lines.push(`  [${m.memoryId}] score=${m.effectiveScore} age=${m.ageDays}d access=${m.accessCount}`);
      lines.push(`      "${preview}${m.content.length > 60 ? '...' : ''}"`);
    }
    if (!verbose && analysis.delete.length > 10) {
      lines.push(`  ... and ${analysis.delete.length - 10} more`);
    }
    lines.push('');
  }

  // Warn candidates (if verbose)
  if (verbose && analysis.warn.length > 0) {
    lines.push('## Warning (approaching delete threshold)');
    for (const m of analysis.warn.slice(0, 10)) {
      const preview = m.content.slice(0, 60).replace(/\n/g, ' ');
      lines.push(`  [${m.memoryId}] score=${m.effectiveScore} age=${m.ageDays}d access=${m.accessCount}`);
      lines.push(`      "${preview}${m.content.length > 60 ? '...' : ''}"`);
    }
    if (analysis.warn.length > 10) {
      lines.push(`  ... and ${analysis.warn.length - 10} more`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function percent(part: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

/**
 * Format retention stats for MCP tool output (JSON-friendly).
 */
export function formatRetentionStatsForMcp(stats: RetentionStats): string {
  return JSON.stringify({
    total: stats.totalMemories,
    tiers: {
      keep: stats.keepCount,
      warn: stats.warnCount,
      delete: stats.deleteCount,
    },
    averages: {
      effective_score: stats.avgEffectiveScore,
      quality_score: stats.avgQualityScore,
      age_days: stats.avgAgeDays,
      access_count: stats.avgAccessCount,
    },
    distribution: stats.scoreDistribution,
  }, null, 2);
}
