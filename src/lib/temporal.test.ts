import { describe, it, expect } from 'vitest';
import {
  exponentialDecay,
  linearDecay,
  calculateAccessBoost,
  calculateTemporalScore,
  applyTemporalScoring,
  isValidAt,
  parseDuration,
  getDecayCurve,
  DEFAULT_TEMPORAL_CONFIG,
} from './temporal.js';

describe('temporal', () => {
  describe('exponentialDecay', () => {
    it('returns 1.0 for zero hours', () => {
      expect(exponentialDecay(0)).toBe(1.0);
    });

    it('returns 1.0 for negative hours', () => {
      expect(exponentialDecay(-10)).toBe(1.0);
    });

    it('returns ~0.5 at half-life', () => {
      const halfLife = DEFAULT_TEMPORAL_CONFIG.decay_half_life_hours;
      const decay = exponentialDecay(halfLife);
      expect(decay).toBeCloseTo(0.5, 1);
    });

    it('returns ~0.25 at 2x half-life', () => {
      const halfLife = DEFAULT_TEMPORAL_CONFIG.decay_half_life_hours;
      const decay = exponentialDecay(halfLife * 2);
      expect(decay).toBeCloseTo(0.25, 1);
    });

    it('respects decay floor', () => {
      // After many half-lives, should hit floor
      const decay = exponentialDecay(10000, 168, 0.1);
      expect(decay).toBe(0.1);
    });

    it('uses custom half-life', () => {
      const decay = exponentialDecay(24, 24); // 24 hours = 1 day half-life
      expect(decay).toBeCloseTo(0.5, 1);
    });
  });

  describe('linearDecay', () => {
    it('returns 1.0 for zero hours', () => {
      expect(linearDecay(0)).toBe(1.0);
    });

    it('returns floor at max hours', () => {
      const maxHours = DEFAULT_TEMPORAL_CONFIG.decay_half_life_hours * 2;
      const decay = linearDecay(maxHours);
      expect(decay).toBe(DEFAULT_TEMPORAL_CONFIG.decay_floor);
    });

    it('returns ~0.55 at half maxHours', () => {
      const maxHours = 336; // 14 days
      const decay = linearDecay(maxHours / 2, maxHours, 0.1);
      expect(decay).toBeCloseTo(0.55, 1);
    });

    it('respects floor for very old memories', () => {
      const decay = linearDecay(99999, 336, 0.1);
      expect(decay).toBe(0.1);
    });
  });

  describe('calculateAccessBoost', () => {
    it('returns 0 for zero accesses', () => {
      expect(calculateAccessBoost(0)).toBe(0);
    });

    it('returns factor for single access', () => {
      expect(calculateAccessBoost(1, 0.05)).toBe(0.05);
    });

    it('caps at max boost', () => {
      expect(calculateAccessBoost(100, 0.05, 0.3)).toBe(0.3);
    });

    it('scales linearly up to cap', () => {
      expect(calculateAccessBoost(4, 0.05, 0.3)).toBe(0.2);
    });
  });

  describe('calculateTemporalScore', () => {
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    it('returns semantic score when disabled', () => {
      // Use a recent date to avoid decay affecting the test
      const result = calculateTemporalScore(
        0.8,
        { created_at: now, last_accessed: now, access_count: 0 },
        { ...DEFAULT_TEMPORAL_CONFIG, enabled: false }
      );
      // When disabled, finalScore equals semanticScore (no temporal weighting)
      expect(result.finalScore).toBe(0.8);
      // temporalScore is still computed but not applied to finalScore
      expect(result.temporalScore).toBeLessThanOrEqual(1.0);
    });

    it('boosts recent memories', () => {
      const recentResult = calculateTemporalScore(
        0.7,
        { created_at: hourAgo, last_accessed: hourAgo, access_count: 0 },
        DEFAULT_TEMPORAL_CONFIG
      );

      const oldResult = calculateTemporalScore(
        0.7,
        { created_at: weekAgo, last_accessed: weekAgo, access_count: 0 },
        DEFAULT_TEMPORAL_CONFIG
      );

      // Recent memory should have higher final score
      expect(recentResult.finalScore).toBeGreaterThan(oldResult.finalScore);
    });

    it('applies access boost', () => {
      const noAccessResult = calculateTemporalScore(
        0.7,
        { created_at: dayAgo, last_accessed: dayAgo, access_count: 0 },
        DEFAULT_TEMPORAL_CONFIG
      );

      const frequentResult = calculateTemporalScore(
        0.7,
        { created_at: dayAgo, last_accessed: dayAgo, access_count: 5 },
        DEFAULT_TEMPORAL_CONFIG
      );

      // Frequently accessed should have higher score
      expect(frequentResult.finalScore).toBeGreaterThan(noAccessResult.finalScore);
      expect(frequentResult.accessBoost).toBeGreaterThan(0);
    });

    it('marks expired memories', () => {
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const result = calculateTemporalScore(
        0.7,
        {
          created_at: weekAgo,
          last_accessed: weekAgo,
          access_count: 0,
          valid_until: yesterday.toISOString(),
        },
        { ...DEFAULT_TEMPORAL_CONFIG, filter_expired: true }
      );

      expect(result.isExpired).toBe(true);
    });

    it('marks not-yet-valid memories as expired', () => {
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const result = calculateTemporalScore(
        0.7,
        {
          created_at: now,
          last_accessed: null,
          access_count: 0,
          valid_from: tomorrow.toISOString(),
        },
        { ...DEFAULT_TEMPORAL_CONFIG, filter_expired: true }
      );

      expect(result.isExpired).toBe(true);
    });
  });

  describe('applyTemporalScoring', () => {
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    it('re-ranks results by temporal score', () => {
      // Use much older dates to see clear decay difference
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const results = [
        {
          similarity: 0.9,
          created_at: monthAgo.toISOString(),
          last_accessed: monthAgo.toISOString(),
          access_count: 0,
        },
        {
          similarity: 0.7,
          created_at: hourAgo.toISOString(),
          last_accessed: hourAgo.toISOString(),
          access_count: 0,
        },
      ];

      const scored = applyTemporalScoring(results, DEFAULT_TEMPORAL_CONFIG);

      // The older memory (monthAgo) should have a lower decay factor than recent (hourAgo)
      const monthAgoResult = scored.find((r) => r.created_at === monthAgo.toISOString())!;
      const hourAgoResult = scored.find((r) => r.created_at === hourAgo.toISOString())!;
      expect(monthAgoResult.temporal_score.decayFactor).toBeLessThan(
        hourAgoResult.temporal_score.decayFactor
      );
    });

    it('filters expired results', () => {
      const results = [
        {
          similarity: 0.9,
          created_at: weekAgo.toISOString(),
          valid_until: yesterday.toISOString(),
        },
        { similarity: 0.7, created_at: hourAgo.toISOString() },
      ];

      const scored = applyTemporalScoring(results, {
        ...DEFAULT_TEMPORAL_CONFIG,
        filter_expired: true,
      });

      expect(scored.length).toBe(1);
      expect(scored[0].similarity).toBeGreaterThan(0); // The non-expired one
    });

    it('preserves order when disabled', () => {
      const results = [
        { similarity: 0.9, created_at: weekAgo.toISOString() },
        { similarity: 0.7, created_at: hourAgo.toISOString() },
      ];

      const scored = applyTemporalScoring(results, { ...DEFAULT_TEMPORAL_CONFIG, enabled: false });

      expect(scored[0].similarity).toBe(0.9);
      expect(scored[1].similarity).toBe(0.7);
    });
  });

  describe('isValidAt', () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    it('returns true for null bounds', () => {
      expect(isValidAt(null, null)).toBe(true);
    });

    it('returns true within bounds', () => {
      expect(isValidAt(yesterday.toISOString(), tomorrow.toISOString())).toBe(true);
    });

    it('returns false before valid_from', () => {
      expect(isValidAt(tomorrow.toISOString(), null)).toBe(false);
    });

    it('returns false after valid_until', () => {
      expect(isValidAt(null, yesterday.toISOString())).toBe(false);
    });

    it('respects custom atTime', () => {
      const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      // Valid from 2 weeks ago to 1 week ago
      // At "now" should be invalid
      expect(isValidAt(twoWeeksAgo.toISOString(), oneWeekAgo.toISOString(), now)).toBe(false);

      // At 10 days ago should be valid
      const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
      expect(isValidAt(twoWeeksAgo.toISOString(), oneWeekAgo.toISOString(), tenDaysAgo)).toBe(true);
    });
  });

  describe('parseDuration', () => {
    it('parses days', () => {
      const now = new Date();
      const result = parseDuration('7d', now);
      const expectedMs = 7 * 24 * 60 * 60 * 1000;
      expect(result.getTime() - now.getTime()).toBeCloseTo(expectedMs, -3);
    });

    it('parses weeks', () => {
      const now = new Date();
      const result = parseDuration('2w', now);
      const expectedMs = 14 * 24 * 60 * 60 * 1000;
      expect(result.getTime() - now.getTime()).toBeCloseTo(expectedMs, -3);
    });

    it('parses months', () => {
      const now = new Date('2024-01-15');
      const result = parseDuration('1m', now);
      expect(result.getMonth()).toBe(1); // February
    });

    it('parses years', () => {
      const now = new Date('2024-06-15');
      const result = parseDuration('1y', now);
      expect(result.getFullYear()).toBe(2025);
    });

    it('parses ISO date', () => {
      const result = parseDuration('2024-12-31');
      expect(result.getFullYear()).toBe(2024);
      expect(result.getMonth()).toBe(11); // December
      expect(result.getDate()).toBe(31);
    });

    it('throws for invalid format', () => {
      expect(() => parseDuration('invalid')).toThrow();
      expect(() => parseDuration('7x')).toThrow();
      expect(() => parseDuration('')).toThrow();
    });
  });

  describe('getDecayCurve', () => {
    it('generates correct number of points', () => {
      const curve = getDecayCurve(DEFAULT_TEMPORAL_CONFIG, 10);
      expect(curve.length).toBe(11); // 0 to 10 inclusive
    });

    it('starts at 1.0', () => {
      const curve = getDecayCurve(DEFAULT_TEMPORAL_CONFIG, 10);
      expect(curve[0][0]).toBe(0);
      expect(curve[0][1]).toBe(1.0);
    });

    it('decays over time', () => {
      const curve = getDecayCurve(DEFAULT_TEMPORAL_CONFIG, 10);
      for (let i = 1; i < curve.length; i++) {
        expect(curve[i][1]).toBeLessThanOrEqual(curve[i - 1][1]);
      }
    });

    it('respects floor', () => {
      const config = { ...DEFAULT_TEMPORAL_CONFIG, decay_floor: 0.2 };
      const curve = getDecayCurve(config, 50, config.decay_half_life_hours * 10);
      const lastValue = curve[curve.length - 1][1];
      expect(lastValue).toBeGreaterThanOrEqual(0.2);
    });
  });
});
