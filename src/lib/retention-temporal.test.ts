/**
 * Retention + Temporal Decay Integration Tests (Phase 7.2)
 *
 * Tests for unified temporal decay in retention scoring,
 * auto-cleanup behavior, and tier categorization.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateEffectiveScore,
  calculateRecencyFactor,
  calculateAccessBoost,
  analyzeRetention,
  calculateRetentionStats,
  DEFAULT_RETENTION_CONFIG,
} from './retention.js';
import { exponentialDecay, calculateAccessBoost as temporalAccessBoost } from './temporal.js';
import type { MemoryForRetention } from './storage/index.js';

// Helper to create test memory
function makeMemory(overrides: Partial<MemoryForRetention> = {}): MemoryForRetention {
  return {
    id: 1,
    content: 'Test memory content for retention analysis',
    quality_score: 0.7,
    access_count: 0,
    created_at: new Date().toISOString(),
    last_accessed: null,
    ...overrides,
  };
}

describe('Retention + Temporal Decay', () => {
  describe('Legacy hyperbolic decay (use_temporal_decay=false)', () => {
    it('calculateRecencyFactor returns 1.0 for age=0', () => {
      expect(calculateRecencyFactor(0, 0.01)).toBe(1.0);
    });

    it('calculateRecencyFactor decays with age', () => {
      const factor100d = calculateRecencyFactor(100, 0.01);
      expect(factor100d).toBeCloseTo(0.5, 1); // 1/(1+0.01*100) = 0.5
    });

    it('calculateAccessBoost returns 1 for 0 accesses', () => {
      expect(calculateAccessBoost(0, 0.1, 2.0)).toBe(1.0);
    });

    it('calculateAccessBoost grows with access count', () => {
      expect(calculateAccessBoost(5, 0.1, 2.0)).toBe(1.5);
    });

    it('calculateAccessBoost caps at max', () => {
      expect(calculateAccessBoost(100, 0.1, 2.0)).toBe(2.0);
    });

    it('effective score for fresh memory equals quality_score', () => {
      const memory = makeMemory({ quality_score: 0.8 });
      const result = calculateEffectiveScore(memory, { use_temporal_decay: false });

      // Fresh: recency=1.0, access_boost=1.0 → effective = 0.8 * 1.0 * 1.0 = 0.8
      expect(result.effectiveScore).toBeCloseTo(0.8, 1);
      expect(result.tier).toBe('keep');
    });
  });

  describe('Temporal exponential decay (use_temporal_decay=true)', () => {
    it('fresh memory has high effective score', () => {
      const memory = makeMemory({
        quality_score: 0.8,
        created_at: new Date().toISOString(),
      });
      const result = calculateEffectiveScore(memory, { use_temporal_decay: true });

      // Fresh: exponentialDecay(~0h) ≈ 1.0, access_boost = 1+0 = 1
      // effective = 0.8 * 1.0 * 1.0 ≈ 0.8
      expect(result.effectiveScore).toBeGreaterThan(0.6);
      expect(result.tier).toBe('keep');
    });

    it('old unfaccessed memory has low effective score', () => {
      const twoMonthsAgo = new Date();
      twoMonthsAgo.setDate(twoMonthsAgo.getDate() - 60);

      const memory = makeMemory({
        quality_score: 0.5,
        access_count: 0,
        created_at: twoMonthsAgo.toISOString(),
        last_accessed: null,
      });
      const result = calculateEffectiveScore(memory, { use_temporal_decay: true });

      // 60 days = 1440 hours, half-life 168h → decayed heavily
      expect(result.effectiveScore).toBeLessThan(0.15);
      expect(result.tier).toBe('delete');
    });

    it('frequently accessed old memory stays above threshold', () => {
      const oneMonthAgo = new Date();
      oneMonthAgo.setDate(oneMonthAgo.getDate() - 30);
      const recentAccess = new Date();
      recentAccess.setHours(recentAccess.getHours() - 2); // Accessed 2h ago

      const memory = makeMemory({
        quality_score: 0.6,
        access_count: 10,
        created_at: oneMonthAgo.toISOString(),
        last_accessed: recentAccess.toISOString(),
      });
      const result = calculateEffectiveScore(memory, { use_temporal_decay: true });

      // Last accessed 2h ago → decay ≈ 1.0
      // access_boost = 1 + min(10*0.05, 0.3) = 1.3
      // effective ≈ 0.6 * 1.0 * 1.3 = 0.78
      expect(result.effectiveScore).toBeGreaterThan(0.3);
      expect(result.tier).toBe('keep');
    });

    it('uses last_accessed instead of created_at for decay when available', () => {
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const memory = makeMemory({
        quality_score: 0.7,
        access_count: 3,
        created_at: oneYearAgo.toISOString(),
        last_accessed: yesterday.toISOString(), // Accessed yesterday despite being old
      });
      const result = calculateEffectiveScore(memory, { use_temporal_decay: true });

      // Last accessed 24h ago → decay still high (~0.9)
      expect(result.recencyFactor).toBeGreaterThan(0.8);
    });

    it('memory at exact half-life has ~0.5 decay', () => {
      // Default half-life = 168 hours (7 days)
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setHours(sevenDaysAgo.getHours() - 168);

      const memory = makeMemory({
        quality_score: 1.0,
        access_count: 0,
        created_at: sevenDaysAgo.toISOString(),
        last_accessed: null,
      });
      const result = calculateEffectiveScore(memory, { use_temporal_decay: true });

      // At half-life, decay factor should be ~0.5
      expect(result.recencyFactor).toBeCloseTo(0.5, 1);
    });
  });

  describe('Tier categorization', () => {
    it('categorizes high-quality fresh memory as keep', () => {
      const memory = makeMemory({ quality_score: 0.9 });
      const result = calculateEffectiveScore(memory);
      expect(result.tier).toBe('keep');
    });

    it('categorizes low-quality old memory as delete', () => {
      const old = new Date();
      old.setDate(old.getDate() - 365);
      const memory = makeMemory({
        quality_score: 0.2,
        created_at: old.toISOString(),
        access_count: 0,
      });
      const result = calculateEffectiveScore(memory, { use_temporal_decay: true });
      expect(result.tier).toBe('delete');
    });

    it('uses default quality score when null', () => {
      const memory = makeMemory({ quality_score: null });
      const result = calculateEffectiveScore(memory);
      expect(result.qualityScore).toBe(DEFAULT_RETENTION_CONFIG.default_quality_score);
    });
  });

  describe('analyzeRetention', () => {
    it('categorizes mixed memories correctly', () => {
      const now = new Date();
      const old = new Date();
      old.setDate(old.getDate() - 365);

      const memories: MemoryForRetention[] = [
        makeMemory({ id: 1, quality_score: 0.9, created_at: now.toISOString() }), // keep
        makeMemory({ id: 2, quality_score: 0.1, created_at: old.toISOString(), access_count: 0 }), // delete
      ];

      const analysis = analyzeRetention(memories, { use_temporal_decay: true });

      expect(analysis.keep.length).toBeGreaterThanOrEqual(1);
      expect(analysis.stats.totalMemories).toBe(2);
    });

    it('returns empty analysis for no memories', () => {
      const analysis = analyzeRetention([]);
      expect(analysis.keep).toHaveLength(0);
      expect(analysis.warn).toHaveLength(0);
      expect(analysis.delete).toHaveLength(0);
      expect(analysis.stats.totalMemories).toBe(0);
    });
  });

  describe('calculateRetentionStats', () => {
    it('calculates correct averages', () => {
      const results = [
        {
          memoryId: 1,
          content: 'a',
          qualityScore: 0.8,
          accessCount: 5,
          ageDays: 10,
          recencyFactor: 0.9,
          accessBoost: 1.5,
          effectiveScore: 0.6,
          tier: 'keep' as const,
        },
        {
          memoryId: 2,
          content: 'b',
          qualityScore: 0.4,
          accessCount: 1,
          ageDays: 30,
          recencyFactor: 0.7,
          accessBoost: 1.1,
          effectiveScore: 0.2,
          tier: 'warn' as const,
        },
      ];

      const stats = calculateRetentionStats(results);
      expect(stats.totalMemories).toBe(2);
      expect(stats.keepCount).toBe(1);
      expect(stats.warnCount).toBe(1);
      expect(stats.avgEffectiveScore).toBeCloseTo(0.4, 1);
    });
  });

  describe('Temporal decay alignment', () => {
    it('exponentialDecay and retention use same algorithm', () => {
      // Verify that the temporal.ts functions are reused correctly
      const decay168h = exponentialDecay(168, 168, 0.1);
      expect(decay168h).toBeCloseTo(0.5, 1);

      const decay0h = exponentialDecay(0, 168, 0.1);
      expect(decay0h).toBe(1.0);

      const decayVeryOld = exponentialDecay(5000, 168, 0.1);
      expect(decayVeryOld).toBe(0.1); // Floor
    });

    it('temporalAccessBoost matches retention expectations', () => {
      const boost = temporalAccessBoost(6, 0.05, 0.3);
      expect(boost).toBe(0.3); // 6 * 0.05 = 0.3, capped at 0.3
    });
  });
});
