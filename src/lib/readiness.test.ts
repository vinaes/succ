import { describe, it, expect } from 'vitest';
import { assessReadiness, formatReadinessHeader } from './readiness.js';
import type { ReadinessInput } from './readiness.js';

// Helper to create result sets
function makeResults(count: number, similarity: number, extra: Partial<ReadinessInput> = {}): ReadinessInput[] {
  return Array.from({ length: count }, () => ({ similarity, ...extra }));
}

describe('assessReadiness', () => {
  describe('empty results', () => {
    it('should return insufficient for 0 results', () => {
      const result = assessReadiness([], 'docs');
      expect(result.confidence).toBe(0);
      expect(result.recommendation).toBe('insufficient');
      expect(result.weak_factors).toContain('coverage');
    });
  });

  describe('high confidence scenarios', () => {
    it('should return proceed for 5 high-similarity doc results', () => {
      const results = makeResults(5, 0.85);
      const assessment = assessReadiness(results, 'docs');
      expect(assessment.recommendation).toBe('proceed');
      expect(assessment.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it('should return proceed for 5 high-similarity memory results with quality', () => {
      const results = makeResults(5, 0.85, { quality_score: 0.8, last_accessed: new Date().toISOString() });
      const assessment = assessReadiness(results, 'memories');
      expect(assessment.recommendation).toBe('proceed');
      expect(assessment.confidence).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe('low confidence scenarios', () => {
    it('should return insufficient for 1 low-similarity result', () => {
      const results = makeResults(1, 0.25);
      const assessment = assessReadiness(results, 'docs');
      expect(assessment.recommendation).toBe('insufficient');
      expect(assessment.confidence).toBeLessThan(0.4);
    });

    it('should return warn or insufficient for few moderate results', () => {
      const results = makeResults(2, 0.5);
      const assessment = assessReadiness(results, 'docs');
      expect(assessment.confidence).toBeLessThan(0.7);
    });
  });

  describe('factor calculations', () => {
    it('coverage scales with result count', () => {
      const few = assessReadiness(makeResults(1, 0.8), 'docs');
      const many = assessReadiness(makeResults(5, 0.8), 'docs');
      expect(many.factors.coverage).toBeGreaterThan(few.factors.coverage);
    });

    it('top_similarity uses best result', () => {
      const results: ReadinessInput[] = [
        { similarity: 0.9 },
        { similarity: 0.5 },
        { similarity: 0.3 },
      ];
      const assessment = assessReadiness(results, 'docs');
      expect(assessment.factors.top_similarity).toBe(0.9);
    });

    it('coherence is high for consistent similarities', () => {
      const consistent = makeResults(5, 0.7);
      const assessment = assessReadiness(consistent, 'docs');
      expect(assessment.factors.coherence).toBeGreaterThan(0.8);
    });

    it('coherence is lower for scattered similarities', () => {
      const scattered: ReadinessInput[] = [
        { similarity: 0.95 },
        { similarity: 0.7 },
        { similarity: 0.3 },
        { similarity: 0.1 },
      ];
      const assessment = assessReadiness(scattered, 'docs');
      expect(assessment.factors.coherence).toBeLessThan(0.5);
    });

    it('coherence returns 0.5 for single result', () => {
      const assessment = assessReadiness(makeResults(1, 0.8), 'docs');
      expect(assessment.factors.coherence).toBe(0.5);
    });
  });

  describe('memory-specific factors', () => {
    it('quality_avg uses quality_score when available', () => {
      const results = makeResults(3, 0.7, { quality_score: 0.9 });
      const assessment = assessReadiness(results, 'memories');
      expect(assessment.factors.quality_avg).toBeCloseTo(0.9);
    });

    it('quality_avg falls back to 0.5 without scores', () => {
      const results = makeResults(3, 0.7);
      const assessment = assessReadiness(results, 'memories');
      expect(assessment.factors.quality_avg).toBe(0.5);
    });

    it('freshness is high for recently accessed memories', () => {
      const results = makeResults(3, 0.7, { last_accessed: new Date().toISOString() });
      const assessment = assessReadiness(results, 'memories');
      expect(assessment.factors.freshness).toBeGreaterThan(0.8);
    });

    it('freshness is lower for old memories', () => {
      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
      const results = makeResults(3, 0.7, { last_accessed: oldDate });
      const assessment = assessReadiness(results, 'memories');
      expect(assessment.factors.freshness).toBeLessThan(0.5);
    });

    it('freshness falls back to 0.5 without last_accessed', () => {
      const results = makeResults(3, 0.7);
      const assessment = assessReadiness(results, 'memories');
      expect(assessment.factors.freshness).toBe(0.5);
    });
  });

  describe('search type differentiation', () => {
    it('docs/code should not use quality or freshness weights', () => {
      // Same results, but docs type should ignore quality_score
      const results = makeResults(3, 0.6, { quality_score: 0.1, last_accessed: null });
      const docsAssessment = assessReadiness(results, 'docs');
      const memAssessment = assessReadiness(results, 'memories');
      // Docs should not be penalized by low quality since weight is 0
      expect(docsAssessment.confidence).toBeGreaterThan(memAssessment.confidence);
    });

    it('code type uses same weights as docs', () => {
      const results = makeResults(3, 0.7);
      const docs = assessReadiness(results, 'docs');
      const code = assessReadiness(results, 'code');
      expect(docs.confidence).toBeCloseTo(code.confidence);
    });
  });

  describe('weak factors', () => {
    it('identifies factors below 0.5', () => {
      const results = makeResults(1, 0.3); // low coverage and top_similarity
      const assessment = assessReadiness(results, 'docs');
      expect(assessment.weak_factors).toContain('coverage');
      expect(assessment.weak_factors).toContain('top_similarity');
    });

    it('empty for high-quality results', () => {
      const results = makeResults(5, 0.9);
      const assessment = assessReadiness(results, 'docs');
      expect(assessment.weak_factors).toHaveLength(0);
    });
  });

  describe('custom config', () => {
    it('respects custom thresholds', () => {
      const results = makeResults(3, 0.6);
      const strict = assessReadiness(results, 'docs', { thresholds: { proceed: 0.9, warn: 0.7 } });
      const lenient = assessReadiness(results, 'docs', { thresholds: { proceed: 0.3, warn: 0.1 } });
      // Same confidence, different recommendations
      expect(strict.confidence).toBeCloseTo(lenient.confidence);
      expect(lenient.recommendation).toBe('proceed');
    });

    it('respects custom expected_results', () => {
      const results = makeResults(2, 0.7);
      const expectFew = assessReadiness(results, 'docs', { expected_results: 2 });
      const expectMany = assessReadiness(results, 'docs', { expected_results: 10 });
      expect(expectFew.factors.coverage).toBe(1.0);
      expect(expectMany.factors.coverage).toBe(0.2);
    });
  });
});

describe('formatReadinessHeader', () => {
  it('returns empty string for proceed', () => {
    const assessment = assessReadiness(makeResults(5, 0.9), 'docs');
    expect(assessment.recommendation).toBe('proceed');
    expect(formatReadinessHeader(assessment)).toBe('');
  });

  it('returns confidence header for warn', () => {
    const assessment: ReturnType<typeof assessReadiness> = {
      confidence: 0.55,
      recommendation: 'warn',
      factors: { coverage: 0.4, top_similarity: 0.7, coherence: 0.6, quality_avg: 0.5, freshness: 0.5 },
      weak_factors: ['coverage'],
    };
    const header = formatReadinessHeader(assessment);
    expect(header).toContain('Confidence: 55%');
    expect(header).toContain('coverage (40%)');
  });

  it('returns low confidence header for insufficient', () => {
    const assessment: ReturnType<typeof assessReadiness> = {
      confidence: 0.2,
      recommendation: 'insufficient',
      factors: { coverage: 0.1, top_similarity: 0.25, coherence: 0.3, quality_avg: 0.5, freshness: 0.5 },
      weak_factors: ['coverage', 'top_similarity', 'coherence'],
    };
    const header = formatReadinessHeader(assessment);
    expect(header).toContain('Low confidence: 20%');
    expect(header).toContain('unreliable');
  });

  it('shows no weak factors when list is empty', () => {
    const assessment: ReturnType<typeof assessReadiness> = {
      confidence: 0.5,
      recommendation: 'warn',
      factors: { coverage: 0.6, top_similarity: 0.6, coherence: 0.6, quality_avg: 0.5, freshness: 0.5 },
      weak_factors: [],
    };
    const header = formatReadinessHeader(assessment);
    expect(header).toContain('Confidence: 50%');
    expect(header).not.toContain('Weak:');
  });
});
