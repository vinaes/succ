/**
 * Readiness Gate — Search Confidence Assessment
 *
 * Assesses search result quality before returning MCP responses.
 * Inspired by Empirica's epistemic framework (know >= 0.70 readiness gate).
 *
 * Non-blocking: never prevents results from being returned.
 * Adds confidence metadata so AI agents can calibrate trust.
 */

import { DEFAULT_READINESS_GATE_CONFIG } from './config.js';
import type { ReadinessGateConfig } from './config.js';

// ============================================================================
// Types
// ============================================================================

export interface ReadinessInput {
  similarity: number;
  bm25Score?: number;
  vectorScore?: number;
  quality_score?: number;
  access_count?: number;
  last_accessed?: string | null;
  created_at?: string;
}

export type SearchType = 'docs' | 'code' | 'memories';

export interface ReadinessAssessment {
  confidence: number;
  recommendation: 'proceed' | 'warn' | 'insufficient';
  factors: {
    coverage: number;
    top_similarity: number;
    coherence: number;
    quality_avg: number;
    freshness: number;
  };
  weak_factors: string[];
}

// ============================================================================
// Weights per search type
// ============================================================================

interface Weights {
  coverage: number;
  top_similarity: number;
  coherence: number;
  quality_avg: number;
  freshness: number;
}

const MEMORY_WEIGHTS: Weights = {
  coverage: 0.20,
  top_similarity: 0.30,
  coherence: 0.15,
  quality_avg: 0.20,
  freshness: 0.15,
};

const DOC_CODE_WEIGHTS: Weights = {
  coverage: 0.30,
  top_similarity: 0.40,
  coherence: 0.30,
  quality_avg: 0,
  freshness: 0,
};

// ============================================================================
// Factor calculations
// ============================================================================

function calcCoverage(count: number, expected: number): number {
  if (expected <= 0) return count > 0 ? 1 : 0;
  return Math.min(count / expected, 1.0);
}

function calcTopSimilarity(results: ReadinessInput[]): number {
  if (results.length === 0) return 0;
  return results[0].similarity;
}

function calcCoherence(results: ReadinessInput[]): number {
  if (results.length <= 1) return results.length === 1 ? 0.5 : 0;

  const sims = results.map(r => r.similarity);
  const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
  if (mean === 0) return 0;

  const variance = sims.reduce((sum, s) => sum + (s - mean) ** 2, 0) / sims.length;
  const stddev = Math.sqrt(variance);
  const cv = stddev / mean; // coefficient of variation

  // cv=0 → perfect coherence (1.0), cv>=1 → no coherence (0.0)
  return Math.max(0, Math.min(1, 1 - cv));
}

function calcQualityAvg(results: ReadinessInput[]): number {
  const withQuality = results.filter(r => r.quality_score != null);
  if (withQuality.length === 0) return 0.5; // neutral fallback
  return withQuality.reduce((sum, r) => sum + (r.quality_score ?? 0), 0) / withQuality.length;
}

function calcFreshness(results: ReadinessInput[]): number {
  const withAccess = results.filter(r => r.last_accessed != null);
  if (withAccess.length === 0) return 0.5; // neutral fallback

  const now = Date.now();
  const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const FLOOR = 0.1;

  const decays = withAccess.map(r => {
    const lastAccessed = new Date(r.last_accessed!).getTime();
    const age = Math.max(0, now - lastAccessed);
    const lambda = Math.LN2 / HALF_LIFE_MS;
    return Math.max(FLOOR, Math.exp(-lambda * age));
  });

  return decays.reduce((a, b) => a + b, 0) / decays.length;
}

// ============================================================================
// Main assessment
// ============================================================================

export function assessReadiness(
  results: ReadinessInput[],
  searchType: SearchType,
  config?: ReadinessGateConfig,
): ReadinessAssessment {
  const thresholds = config?.thresholds ?? DEFAULT_READINESS_GATE_CONFIG.thresholds;
  const expected = config?.expected_results ?? DEFAULT_READINESS_GATE_CONFIG.expected_results;

  // Empty results
  if (results.length === 0) {
    return {
      confidence: 0,
      recommendation: 'insufficient',
      factors: { coverage: 0, top_similarity: 0, coherence: 0, quality_avg: 0, freshness: 0 },
      weak_factors: ['coverage', 'top_similarity', 'coherence'],
    };
  }

  // Calculate factors
  const factors = {
    coverage: calcCoverage(results.length, expected),
    top_similarity: calcTopSimilarity(results),
    coherence: calcCoherence(results),
    quality_avg: calcQualityAvg(results),
    freshness: calcFreshness(results),
  };

  // Select weights based on search type
  const weights = searchType === 'memories' ? MEMORY_WEIGHTS : DOC_CODE_WEIGHTS;

  // Weighted sum
  const confidence =
    weights.coverage * factors.coverage +
    weights.top_similarity * factors.top_similarity +
    weights.coherence * factors.coherence +
    weights.quality_avg * factors.quality_avg +
    weights.freshness * factors.freshness;

  // Identify weak factors (below 0.5, with non-zero weight)
  const weak_factors: string[] = [];
  for (const [key, value] of Object.entries(factors)) {
    if (weights[key as keyof Weights] > 0 && value < 0.5) {
      weak_factors.push(key);
    }
  }

  // Recommendation
  const proceedThreshold = thresholds.proceed ?? 0.7;
  const warnThreshold = thresholds.warn ?? 0.4;
  let recommendation: 'proceed' | 'warn' | 'insufficient';
  if (confidence >= proceedThreshold) {
    recommendation = 'proceed';
  } else if (confidence >= warnThreshold) {
    recommendation = 'warn';
  } else {
    recommendation = 'insufficient';
  }

  return { confidence, recommendation, factors, weak_factors };
}

// ============================================================================
// Formatting
// ============================================================================

export function formatReadinessHeader(assessment: ReadinessAssessment): string {
  const pct = Math.round(assessment.confidence * 100);

  if (assessment.recommendation === 'proceed') {
    return ''; // Silent for high confidence
  }

  const weakStr = assessment.weak_factors.length > 0
    ? ` Weak: ${assessment.weak_factors.map(f => `${f} (${Math.round(assessment.factors[f as keyof typeof assessment.factors] * 100)}%)`).join(', ')}`
    : '';

  if (assessment.recommendation === 'warn') {
    return `> **Confidence: ${pct}%** — Limited context available.${weakStr}`;
  }

  // insufficient
  return `> **Low confidence: ${pct}%** — Results may be unreliable.${weakStr}`;
}
