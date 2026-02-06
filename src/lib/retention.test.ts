import { describe, it, expect } from 'vitest';
import {
  calculateRecencyFactor,
  calculateAccessBoost,
  calculateEffectiveScore,
  analyzeRetention,
  calculateRetentionStats,
  formatRetentionAnalysis,
  DEFAULT_RETENTION_CONFIG,
} from './retention.js';
import type { MemoryForRetention } from './db/index.js';

// Helper to create test memories
function createMemory(overrides: Partial<MemoryForRetention> = {}): MemoryForRetention {
  return {
    id: 1,
    content: 'Test memory content',
    quality_score: 0.5,
    access_count: 0,
    created_at: new Date().toISOString(),
    last_accessed: null,
    ...overrides,
  };
}

describe('Retention Policy', () => {
  describe('calculateRecencyFactor', () => {
    it('should return 1 for brand new memories (0 days)', () => {
      const factor = calculateRecencyFactor(0, 0.01);
      expect(factor).toBe(1);
    });

    it('should return ~0.5 at 100 days with default decay rate', () => {
      const factor = calculateRecencyFactor(100, 0.01);
      // 1 / (1 + 0.01 * 100) = 1 / 2 = 0.5
      expect(factor).toBeCloseTo(0.5, 2);
    });

    it('should return ~0.33 at 200 days with default decay rate', () => {
      const factor = calculateRecencyFactor(200, 0.01);
      // 1 / (1 + 0.01 * 200) = 1 / 3 ≈ 0.333
      expect(factor).toBeCloseTo(0.333, 2);
    });

    it('should decay faster with higher decay rate', () => {
      const slowDecay = calculateRecencyFactor(50, 0.01);
      const fastDecay = calculateRecencyFactor(50, 0.05);

      expect(fastDecay).toBeLessThan(slowDecay);
    });

    it('should always return positive values', () => {
      const factors = [0, 1, 10, 100, 1000, 10000].map(days =>
        calculateRecencyFactor(days, 0.01)
      );

      for (const factor of factors) {
        expect(factor).toBeGreaterThan(0);
        expect(factor).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('calculateAccessBoost', () => {
    it('should return 1 for zero accesses', () => {
      const boost = calculateAccessBoost(0, 0.1, 2.0);
      expect(boost).toBe(1);
    });

    it('should increase with more accesses', () => {
      const boost0 = calculateAccessBoost(0, 0.1, 2.0);
      const boost5 = calculateAccessBoost(5, 0.1, 2.0);
      const boost10 = calculateAccessBoost(10, 0.1, 2.0);

      expect(boost5).toBeGreaterThan(boost0);
      expect(boost10).toBeGreaterThan(boost5);
    });

    it('should cap at max boost', () => {
      const maxBoost = 2.0;
      const boost = calculateAccessBoost(100, 0.1, maxBoost);

      expect(boost).toBe(maxBoost);
    });

    it('should calculate correctly: 1 + weight * count', () => {
      const boost = calculateAccessBoost(5, 0.1, 2.0);
      // 1 + 0.1 * 5 = 1.5
      expect(boost).toBe(1.5);
    });
  });

  describe('calculateEffectiveScore', () => {
    it('should return proper structure', () => {
      const memory = createMemory();
      const result = calculateEffectiveScore(memory);

      expect(result).toHaveProperty('memoryId');
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('qualityScore');
      expect(result).toHaveProperty('accessCount');
      expect(result).toHaveProperty('ageDays');
      expect(result).toHaveProperty('recencyFactor');
      expect(result).toHaveProperty('accessBoost');
      expect(result).toHaveProperty('effectiveScore');
      expect(result).toHaveProperty('tier');
    });

    it('should use default quality score when missing', () => {
      const memory = createMemory({ quality_score: null });
      const result = calculateEffectiveScore(memory);

      expect(result.qualityScore).toBe(DEFAULT_RETENTION_CONFIG.default_quality_score);
    });

    it('should calculate effective score as quality * recency * access', () => {
      // Brand new memory with no accesses
      const memory = createMemory({
        quality_score: 0.8,
        access_count: 0,
        created_at: new Date().toISOString(), // now
      });
      const result = calculateEffectiveScore(memory);

      // For a brand new memory: quality * 1 * 1 = quality
      expect(result.effectiveScore).toBeCloseTo(0.8, 1);
    });

    it('should assign "keep" tier for high scores', () => {
      const memory = createMemory({
        quality_score: 0.8,
        access_count: 5,
        created_at: new Date().toISOString(),
      });
      const result = calculateEffectiveScore(memory);

      expect(result.tier).toBe('keep');
    });

    it('should assign "delete" tier for low scores', () => {
      // Old memory with low quality and no accesses
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 500); // 500 days old

      const memory = createMemory({
        quality_score: 0.2,
        access_count: 0,
        created_at: oldDate.toISOString(),
      });
      const result = calculateEffectiveScore(memory);

      expect(result.tier).toBe('delete');
    });

    it('should assign "warn" tier for borderline scores', () => {
      // Memory that falls between thresholds
      const config = {
        keep_threshold: 0.5,
        delete_threshold: 0.2,
      };

      const memory = createMemory({
        quality_score: 0.35, // Will result in score ~0.35 for new memory
        access_count: 0,
        created_at: new Date().toISOString(),
      });
      const result = calculateEffectiveScore(memory, config);

      expect(result.tier).toBe('warn');
    });

    it('should boost score with access count', () => {
      const baseMemory = createMemory({
        quality_score: 0.5,
        access_count: 0,
      });
      const accessedMemory = createMemory({
        quality_score: 0.5,
        access_count: 10,
      });

      const baseResult = calculateEffectiveScore(baseMemory);
      const accessedResult = calculateEffectiveScore(accessedMemory);

      expect(accessedResult.effectiveScore).toBeGreaterThan(baseResult.effectiveScore);
    });
  });

  describe('analyzeRetention', () => {
    it('should categorize memories into tiers', () => {
      const memories: MemoryForRetention[] = [
        createMemory({ id: 1, quality_score: 0.9 }), // keep
        createMemory({ id: 2, quality_score: 0.5 }), // keep
        createMemory({ id: 3, quality_score: 0.1 }), // delete
      ];

      const result = analyzeRetention(memories);

      expect(result.keep.length).toBeGreaterThanOrEqual(1);
      expect(result.delete.length).toBeGreaterThanOrEqual(0);
    });

    it('should include stats in result', () => {
      const memories: MemoryForRetention[] = [
        createMemory({ id: 1, quality_score: 0.8 }),
        createMemory({ id: 2, quality_score: 0.5 }),
      ];

      const result = analyzeRetention(memories);

      expect(result.stats).toBeDefined();
      expect(result.stats.totalMemories).toBe(2);
    });

    it('should sort delete candidates by score ascending', () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 1000);

      const memories: MemoryForRetention[] = [
        createMemory({ id: 1, quality_score: 0.08, created_at: oldDate.toISOString() }),
        createMemory({ id: 2, quality_score: 0.05, created_at: oldDate.toISOString() }),
        createMemory({ id: 3, quality_score: 0.12, created_at: oldDate.toISOString() }),
      ];

      const result = analyzeRetention(memories);

      if (result.delete.length >= 2) {
        expect(result.delete[0].effectiveScore).toBeLessThanOrEqual(result.delete[1].effectiveScore);
      }
    });

    it('should sort keep candidates by score descending', () => {
      const memories: MemoryForRetention[] = [
        createMemory({ id: 1, quality_score: 0.9 }),
        createMemory({ id: 2, quality_score: 0.8 }),
        createMemory({ id: 3, quality_score: 0.7 }),
      ];

      const result = analyzeRetention(memories);

      if (result.keep.length >= 2) {
        expect(result.keep[0].effectiveScore).toBeGreaterThanOrEqual(result.keep[1].effectiveScore);
      }
    });

    it('should handle empty memories array', () => {
      const result = analyzeRetention([]);

      expect(result.keep).toHaveLength(0);
      expect(result.warn).toHaveLength(0);
      expect(result.delete).toHaveLength(0);
      expect(result.stats.totalMemories).toBe(0);
    });
  });

  describe('calculateRetentionStats', () => {
    it('should return zeros for empty results', () => {
      const stats = calculateRetentionStats([]);

      expect(stats.totalMemories).toBe(0);
      expect(stats.keepCount).toBe(0);
      expect(stats.warnCount).toBe(0);
      expect(stats.deleteCount).toBe(0);
      expect(stats.avgEffectiveScore).toBe(0);
    });

    it('should calculate correct counts', () => {
      const results = [
        { tier: 'keep' as const, effectiveScore: 0.8, qualityScore: 0.8, ageDays: 10, accessCount: 5 },
        { tier: 'keep' as const, effectiveScore: 0.7, qualityScore: 0.7, ageDays: 20, accessCount: 3 },
        { tier: 'warn' as const, effectiveScore: 0.2, qualityScore: 0.3, ageDays: 100, accessCount: 0 },
        { tier: 'delete' as const, effectiveScore: 0.1, qualityScore: 0.2, ageDays: 200, accessCount: 0 },
      ].map((r, i) => ({
        memoryId: i + 1,
        content: `Memory ${i + 1}`,
        recencyFactor: 0.9,
        accessBoost: 1,
        ...r,
      }));

      const stats = calculateRetentionStats(results);

      expect(stats.totalMemories).toBe(4);
      expect(stats.keepCount).toBe(2);
      expect(stats.warnCount).toBe(1);
      expect(stats.deleteCount).toBe(1);
    });

    it('should calculate correct averages', () => {
      const results = [
        { effectiveScore: 0.8, qualityScore: 0.8, ageDays: 10, accessCount: 4 },
        { effectiveScore: 0.6, qualityScore: 0.6, ageDays: 20, accessCount: 2 },
      ].map((r, i) => ({
        memoryId: i + 1,
        content: `Memory ${i + 1}`,
        tier: 'keep' as const,
        recencyFactor: 0.9,
        accessBoost: 1,
        ...r,
      }));

      const stats = calculateRetentionStats(results);

      expect(stats.avgEffectiveScore).toBeCloseTo(0.7, 2);
      expect(stats.avgQualityScore).toBeCloseTo(0.7, 2);
      expect(stats.avgAgeDays).toBe(15);
      expect(stats.avgAccessCount).toBe(3);
    });

    it('should calculate score distribution', () => {
      const results = [
        { effectiveScore: 0.8 }, // high
        { effectiveScore: 0.4 }, // medium
        { effectiveScore: 0.2 }, // low
        { effectiveScore: 0.1 }, // critical
      ].map((r, i) => ({
        memoryId: i + 1,
        content: `Memory ${i + 1}`,
        tier: 'keep' as const,
        qualityScore: r.effectiveScore,
        ageDays: 10,
        accessCount: 0,
        recencyFactor: 0.9,
        accessBoost: 1,
        ...r,
      }));

      const stats = calculateRetentionStats(results);

      expect(stats.scoreDistribution.high).toBe(1);
      expect(stats.scoreDistribution.medium).toBe(1);
      expect(stats.scoreDistribution.low).toBe(1);
      expect(stats.scoreDistribution.critical).toBe(1);
    });
  });

  describe('formatRetentionAnalysis', () => {
    it('should return formatted string', () => {
      const analysis = {
        keep: [],
        warn: [],
        delete: [],
        stats: {
          totalMemories: 10,
          keepCount: 7,
          warnCount: 2,
          deleteCount: 1,
          avgEffectiveScore: 0.5,
          avgQualityScore: 0.6,
          avgAgeDays: 30,
          avgAccessCount: 2,
          scoreDistribution: { high: 3, medium: 4, low: 2, critical: 1 },
        },
      };

      const formatted = formatRetentionAnalysis(analysis);

      expect(formatted).toContain('Memory Retention Analysis');
      expect(formatted).toContain('Total memories: 10');
      expect(formatted).toContain('Keep:');
      expect(formatted).toContain('Warn:');
      expect(formatted).toContain('Delete:');
    });

    it('should show delete candidates when present', () => {
      const analysis = {
        keep: [],
        warn: [],
        delete: [
          {
            memoryId: 1,
            content: 'Low quality memory to delete',
            qualityScore: 0.1,
            accessCount: 0,
            ageDays: 100,
            recencyFactor: 0.5,
            accessBoost: 1,
            effectiveScore: 0.05,
            tier: 'delete' as const,
          },
        ],
        stats: {
          totalMemories: 1,
          keepCount: 0,
          warnCount: 0,
          deleteCount: 1,
          avgEffectiveScore: 0.05,
          avgQualityScore: 0.1,
          avgAgeDays: 100,
          avgAccessCount: 0,
          scoreDistribution: { high: 0, medium: 0, low: 0, critical: 1 },
        },
      };

      const formatted = formatRetentionAnalysis(analysis);

      expect(formatted).toContain('Delete Candidates');
      expect(formatted).toContain('[1]');
    });

    it('should show warn candidates in verbose mode', () => {
      const analysis = {
        keep: [],
        warn: [
          {
            memoryId: 2,
            content: 'Warning memory',
            qualityScore: 0.25,
            accessCount: 1,
            ageDays: 50,
            recencyFactor: 0.67,
            accessBoost: 1.1,
            effectiveScore: 0.18,
            tier: 'warn' as const,
          },
        ],
        delete: [],
        stats: {
          totalMemories: 1,
          keepCount: 0,
          warnCount: 1,
          deleteCount: 0,
          avgEffectiveScore: 0.18,
          avgQualityScore: 0.25,
          avgAgeDays: 50,
          avgAccessCount: 1,
          scoreDistribution: { high: 0, medium: 0, low: 1, critical: 0 },
        },
      };

      const formatted = formatRetentionAnalysis(analysis, true);

      expect(formatted).toContain('Warning');
      expect(formatted).toContain('[2]');
    });
  });

  describe('DEFAULT_RETENTION_CONFIG', () => {
    it('should have expected default values', () => {
      expect(DEFAULT_RETENTION_CONFIG.decay_rate).toBe(0.01);
      expect(DEFAULT_RETENTION_CONFIG.access_weight).toBe(0.1);
      expect(DEFAULT_RETENTION_CONFIG.max_access_boost).toBe(2.0);
      expect(DEFAULT_RETENTION_CONFIG.keep_threshold).toBe(0.3);
      expect(DEFAULT_RETENTION_CONFIG.delete_threshold).toBe(0.15);
      expect(DEFAULT_RETENTION_CONFIG.default_quality_score).toBe(0.5);
    });
  });
});
