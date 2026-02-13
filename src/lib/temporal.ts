/**
 * Temporal Awareness Module
 *
 * Implements time-aware memory scoring with configurable decay functions.
 *
 * Key concepts:
 * - Time decay: Recent memories are more relevant
 * - Access boost: Frequently accessed memories stay relevant
 * - Validity periods: Facts can have expiration dates
 * - Bi-temporal model: Track both valid time and transaction time
 */

import { getConfig } from './config.js';
import { ValidationError } from './errors.js';

// ============================================================================
// Configuration
// ============================================================================

export interface TemporalConfig {
  enabled: boolean;
  // Scoring weights (must sum to 1.0)
  semantic_weight: number; // Weight for semantic similarity (default: 0.8)
  recency_weight: number; // Weight for time decay (default: 0.2)
  // Decay parameters
  decay_half_life_hours: number; // Hours until score decays to 50% (default: 168 = 7 days)
  decay_floor: number; // Minimum decay factor (default: 0.1)
  // Access boost
  access_boost_enabled: boolean; // Enable access frequency boost
  access_boost_factor: number; // Score boost per access (default: 0.05)
  max_access_boost: number; // Maximum access boost (default: 0.3)
  // Validity filtering
  filter_expired: boolean; // Filter out expired facts (default: true)
}

export const DEFAULT_TEMPORAL_CONFIG: TemporalConfig = {
  enabled: true,
  semantic_weight: 0.8,
  recency_weight: 0.2,
  decay_half_life_hours: 168, // 7 days
  decay_floor: 0.1, // Never go below 10%
  access_boost_enabled: true,
  access_boost_factor: 0.05,
  max_access_boost: 0.3,
  filter_expired: true,
};

/**
 * Get temporal configuration with defaults
 */
export function getTemporalConfig(): TemporalConfig {
  const config = getConfig();
  interface ConfigWithTemporal {
    temporal?: Partial<TemporalConfig>;
  }
  const userConfig = (config as ConfigWithTemporal).temporal || {};

  return {
    enabled: userConfig.enabled ?? DEFAULT_TEMPORAL_CONFIG.enabled,
    semantic_weight: userConfig.semantic_weight ?? DEFAULT_TEMPORAL_CONFIG.semantic_weight,
    recency_weight: userConfig.recency_weight ?? DEFAULT_TEMPORAL_CONFIG.recency_weight,
    decay_half_life_hours: userConfig.decay_half_life_hours ?? DEFAULT_TEMPORAL_CONFIG.decay_half_life_hours,
    decay_floor: userConfig.decay_floor ?? DEFAULT_TEMPORAL_CONFIG.decay_floor,
    access_boost_enabled: userConfig.access_boost_enabled ?? DEFAULT_TEMPORAL_CONFIG.access_boost_enabled,
    access_boost_factor: userConfig.access_boost_factor ?? DEFAULT_TEMPORAL_CONFIG.access_boost_factor,
    max_access_boost: userConfig.max_access_boost ?? DEFAULT_TEMPORAL_CONFIG.max_access_boost,
    filter_expired: userConfig.filter_expired ?? DEFAULT_TEMPORAL_CONFIG.filter_expired,
  };
}

// ============================================================================
// Time Decay Functions
// ============================================================================

/**
 * Calculate exponential decay factor based on hours since last access.
 *
 * Formula: decay = max(floor, e^(-λt))
 * where λ = ln(2) / halfLife
 *
 * @param hoursSinceAccess - Hours since the memory was last accessed
 * @param halfLifeHours - Hours until decay reaches 50%
 * @param floor - Minimum decay value
 * @returns Decay factor between floor and 1.0
 */
export function exponentialDecay(
  hoursSinceAccess: number,
  halfLifeHours: number = DEFAULT_TEMPORAL_CONFIG.decay_half_life_hours,
  floor: number = DEFAULT_TEMPORAL_CONFIG.decay_floor
): number {
  if (hoursSinceAccess <= 0) return 1.0;

  const decayRate = Math.LN2 / halfLifeHours;
  const decay = Math.exp(-decayRate * hoursSinceAccess);

  return Math.max(floor, decay);
}

/**
 * Calculate linear decay factor.
 * Simpler alternative to exponential decay.
 *
 * @param hoursSinceAccess - Hours since the memory was last accessed
 * @param maxHours - Hours until decay reaches floor
 * @param floor - Minimum decay value
 * @returns Decay factor between floor and 1.0
 */
export function linearDecay(
  hoursSinceAccess: number,
  maxHours: number = DEFAULT_TEMPORAL_CONFIG.decay_half_life_hours * 2,
  floor: number = DEFAULT_TEMPORAL_CONFIG.decay_floor
): number {
  if (hoursSinceAccess <= 0) return 1.0;
  if (hoursSinceAccess >= maxHours) return floor;

  const decay = 1.0 - (hoursSinceAccess / maxHours) * (1.0 - floor);
  return Math.max(floor, decay);
}

// ============================================================================
// Access Boost Functions
// ============================================================================

/**
 * Calculate access boost based on access count.
 *
 * Formula: boost = min(maxBoost, accessCount * factor)
 *
 * @param accessCount - Number of times the memory was accessed
 * @param factor - Boost per access
 * @param maxBoost - Maximum boost value
 * @returns Boost factor between 0 and maxBoost
 */
export function calculateAccessBoost(
  accessCount: number,
  factor: number = DEFAULT_TEMPORAL_CONFIG.access_boost_factor,
  maxBoost: number = DEFAULT_TEMPORAL_CONFIG.max_access_boost
): number {
  if (accessCount <= 0) return 0;
  return Math.min(accessCount * factor, maxBoost);
}

// ============================================================================
// Temporal Scoring
// ============================================================================

export interface TemporalMemoryData {
  created_at: string | Date;
  last_accessed: string | Date | null;
  access_count: number;
  valid_from?: string | Date | null;
  valid_until?: string | Date | null;
}

export interface TemporalScoreResult {
  finalScore: number;
  semanticScore: number;
  temporalScore: number;
  decayFactor: number;
  accessBoost: number;
  isExpired: boolean;
  hoursSinceAccess: number;
}

/**
 * Calculate temporal-aware score for a memory.
 *
 * Formula:
 *   temporalScore = decayFactor + accessBoost
 *   finalScore = semanticWeight * semanticScore + recencyWeight * temporalScore
 *
 * @param semanticScore - Base semantic similarity score (0-1)
 * @param memory - Memory data with temporal fields
 * @param config - Temporal configuration
 * @returns Detailed score breakdown
 */
export function calculateTemporalScore(
  semanticScore: number,
  memory: TemporalMemoryData,
  config: TemporalConfig = getTemporalConfig()
): TemporalScoreResult {
  const now = Date.now();

  // Calculate hours since last access (or creation if never accessed)
  const accessTime = memory.last_accessed
    ? new Date(memory.last_accessed).getTime()
    : new Date(memory.created_at).getTime();
  const hoursSinceAccess = (now - accessTime) / (1000 * 60 * 60);

  // Calculate decay
  const decayFactor = exponentialDecay(
    hoursSinceAccess,
    config.decay_half_life_hours,
    config.decay_floor
  );

  // Calculate access boost
  const accessBoost = config.access_boost_enabled
    ? calculateAccessBoost(memory.access_count, config.access_boost_factor, config.max_access_boost)
    : 0;

  // Check validity period
  let isExpired = false;
  if (config.filter_expired && memory.valid_until) {
    const validUntil = new Date(memory.valid_until).getTime();
    isExpired = now > validUntil;
  }

  // Check not-yet-valid
  if (config.filter_expired && memory.valid_from) {
    const validFrom = new Date(memory.valid_from).getTime();
    if (now < validFrom) {
      isExpired = true; // Treat "not yet valid" as expired for now
    }
  }

  // Calculate temporal score (decay + boost, capped at 1.0)
  const temporalScore = Math.min(1.0, decayFactor + accessBoost);

  // Calculate final score
  const finalScore = config.enabled
    ? config.semantic_weight * semanticScore + config.recency_weight * temporalScore
    : semanticScore;

  return {
    finalScore,
    semanticScore,
    temporalScore,
    decayFactor,
    accessBoost,
    isExpired,
    hoursSinceAccess,
  };
}

/**
 * Apply temporal scoring to search results.
 * Filters expired memories and re-ranks by temporal score.
 *
 * @param results - Search results with semantic scores
 * @param config - Temporal configuration
 * @returns Re-ranked results with temporal scores
 */
export function applyTemporalScoring<
  T extends {
    similarity: number;
    created_at: string;
    last_accessed?: string | null;
    access_count?: number;
    valid_from?: string | null;
    valid_until?: string | null;
  }
>(results: T[], config: TemporalConfig = getTemporalConfig()): (T & { temporal_score: TemporalScoreResult })[] {
  if (!config.enabled) {
    // Return results unchanged with default temporal data
    return results.map((r) => ({
      ...r,
      temporal_score: {
        finalScore: r.similarity,
        semanticScore: r.similarity,
        temporalScore: 1.0,
        decayFactor: 1.0,
        accessBoost: 0,
        isExpired: false,
        hoursSinceAccess: 0,
      },
    }));
  }

  // Calculate temporal scores
  const scored = results.map((result) => {
    const temporalData: TemporalMemoryData = {
      created_at: result.created_at,
      last_accessed: result.last_accessed || null,
      access_count: result.access_count || 0,
      valid_from: result.valid_from || null,
      valid_until: result.valid_until || null,
    };

    const temporal_score = calculateTemporalScore(result.similarity, temporalData, config);

    return {
      ...result,
      temporal_score,
      // Update similarity to be the final temporal score
      similarity: temporal_score.finalScore,
    };
  });

  // Filter expired if enabled
  const filtered = config.filter_expired ? scored.filter((r) => !r.temporal_score.isExpired) : scored;

  // Re-sort by final score
  filtered.sort((a, b) => b.similarity - a.similarity);

  return filtered;
}

// ============================================================================
// Validity Period Helpers
// ============================================================================

/**
 * Check if a memory is currently valid.
 *
 * @param validFrom - Start of validity period (null = always valid from past)
 * @param validUntil - End of validity period (null = never expires)
 * @param atTime - Time to check (default: now)
 * @returns true if memory is valid at the given time
 */
export function isValidAt(
  validFrom: string | Date | null,
  validUntil: string | Date | null,
  atTime: Date = new Date()
): boolean {
  const time = atTime.getTime();

  if (validFrom) {
    const from = new Date(validFrom).getTime();
    if (time < from) return false;
  }

  if (validUntil) {
    const until = new Date(validUntil).getTime();
    if (time > until) return false;
  }

  return true;
}

/**
 * Parse duration string to Date.
 * Supports: "1d" (days), "2w" (weeks), "3m" (months), "1y" (years)
 * Also accepts ISO date strings.
 *
 * @param duration - Duration string or ISO date
 * @param fromDate - Base date (default: now)
 * @returns Parsed date
 */
export function parseDuration(duration: string, fromDate: Date = new Date()): Date {
  // Try ISO date first
  const isoDate = new Date(duration);
  if (!isNaN(isoDate.getTime())) {
    return isoDate;
  }

  // Parse duration format
  const match = duration.match(/^(\d+)([dwmy])$/i);
  if (!match) {
    throw new ValidationError(`Invalid duration format: ${duration}. Use "7d", "2w", "1m", "1y" or ISO date.`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const result = new Date(fromDate);

  switch (unit) {
    case 'd':
      result.setDate(result.getDate() + value);
      break;
    case 'w':
      result.setDate(result.getDate() + value * 7);
      break;
    case 'm':
      result.setMonth(result.getMonth() + value);
      break;
    case 'y':
      result.setFullYear(result.getFullYear() + value);
      break;
  }

  return result;
}

// ============================================================================
// Debug/Stats Functions
// ============================================================================

/**
 * Format temporal score for display.
 */
export function formatTemporalScore(score: TemporalScoreResult): string {
  const lines = [
    `Final Score: ${(score.finalScore * 100).toFixed(1)}%`,
    `  Semantic: ${(score.semanticScore * 100).toFixed(1)}%`,
    `  Temporal: ${(score.temporalScore * 100).toFixed(1)}%`,
    `    Decay: ${(score.decayFactor * 100).toFixed(1)}% (${score.hoursSinceAccess.toFixed(0)}h ago)`,
    `    Access Boost: +${(score.accessBoost * 100).toFixed(1)}%`,
  ];

  if (score.isExpired) {
    lines.push(`  ⚠️ EXPIRED`);
  }

  return lines.join('\n');
}

/**
 * Calculate decay curve for visualization.
 *
 * @param config - Temporal configuration
 * @param points - Number of points to generate
 * @param maxHours - Maximum hours to plot
 * @returns Array of [hours, decay] tuples
 */
export function getDecayCurve(
  config: TemporalConfig = getTemporalConfig(),
  points: number = 20,
  maxHours: number = config.decay_half_life_hours * 4
): Array<[number, number]> {
  const curve: Array<[number, number]> = [];
  const step = maxHours / points;

  for (let i = 0; i <= points; i++) {
    const hours = i * step;
    const decay = exponentialDecay(hours, config.decay_half_life_hours, config.decay_floor);
    curve.push([hours, decay]);
  }

  return curve;
}
