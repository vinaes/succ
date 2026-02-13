import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyWorkingMemoryPipeline } from './working-memory-pipeline.js';
import type { WorkingMemoryCandidate } from './working-memory-pipeline.js';

// Mock fault-logger to verify telemetry calls
vi.mock('./fault-logger.js', () => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

import { logWarn, logInfo } from './fault-logger.js';

const NOW = new Date('2026-02-14T12:00:00Z');

function makeMemory(overrides: Partial<WorkingMemoryCandidate> = {}): WorkingMemoryCandidate {
  return {
    id: 1,
    content: 'test memory',
    quality_score: 0.7,
    access_count: 5,
    created_at: '2026-02-13T12:00:00Z',
    last_accessed: '2026-02-14T10:00:00Z',
    valid_from: null,
    valid_until: null,
    ...overrides,
  };
}

describe('applyWorkingMemoryPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns memories sorted by effective score (higher quality first)', () => {
    const memories = [
      makeMemory({ id: 1, quality_score: 0.3, access_count: 0 }),
      makeMemory({ id: 2, quality_score: 0.9, access_count: 10 }),
      makeMemory({ id: 3, quality_score: 0.6, access_count: 2 }),
    ];

    const result = applyWorkingMemoryPipeline(memories, 3, NOW);

    // Highest quality + most accessed should be first
    expect(result[0].id).toBe(2);
    expect(result.length).toBe(3);
  });

  it('respects limit parameter', () => {
    const memories = Array.from({ length: 10 }, (_, i) =>
      makeMemory({ id: i + 1, quality_score: 0.5 + i * 0.01 })
    );

    const result = applyWorkingMemoryPipeline(memories, 3, NOW);
    expect(result.length).toBe(3);
  });

  it('filters out expired memories (valid_until in the past)', () => {
    const memories = [
      makeMemory({ id: 1, valid_until: '2026-02-13T00:00:00Z' }), // expired
      makeMemory({ id: 2, valid_until: null }), // no expiry
      makeMemory({ id: 3, valid_until: '2026-03-01T00:00:00Z' }), // future
    ];

    const result = applyWorkingMemoryPipeline(memories, 10, NOW);
    const ids = result.map((m) => m.id);

    expect(ids).not.toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
  });

  it('filters out memories with valid_from in the future', () => {
    const memories = [
      makeMemory({ id: 1, valid_from: '2026-03-01T00:00:00Z' }), // not yet valid
      makeMemory({ id: 2, valid_from: '2026-01-01T00:00:00Z' }), // already valid
      makeMemory({ id: 3, valid_from: null }), // always valid
    ];

    const result = applyWorkingMemoryPipeline(memories, 10, NOW);
    const ids = result.map((m) => m.id);

    expect(ids).not.toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
  });

  it('falls back to recency order when all quality_score are null', () => {
    const memories = [
      makeMemory({ id: 1, quality_score: null, created_at: '2026-02-10T00:00:00Z' }),
      makeMemory({ id: 2, quality_score: null, created_at: '2026-02-14T00:00:00Z' }),
      makeMemory({ id: 3, quality_score: null, created_at: '2026-02-12T00:00:00Z' }),
    ];

    const result = applyWorkingMemoryPipeline(memories, 10, NOW);

    // Should preserve original (recency) order from backend
    expect(result.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(logWarn).toHaveBeenCalledWith(
      'working-memory',
      expect.stringContaining('falling back to recency'),
      expect.any(Object)
    );
  });

  it('logs telemetry when validity filters out >10% of candidates', () => {
    // 5 out of 10 expired = 50%
    const memories = Array.from({ length: 10 }, (_, i) =>
      makeMemory({
        id: i + 1,
        valid_until: i < 5 ? '2026-01-01T00:00:00Z' : null, // first 5 expired
      })
    );

    applyWorkingMemoryPipeline(memories, 10, NOW);

    expect(logInfo).toHaveBeenCalledWith(
      'working-memory',
      expect.stringContaining('Validity filter removed 5/10'),
      expect.objectContaining({ total: 10, filtered: 5 })
    );
  });

  it('does NOT log when validity filters <=10% of candidates', () => {
    // 1 out of 20 expired = 5%
    const memories = Array.from({ length: 20 }, (_, i) =>
      makeMemory({
        id: i + 1,
        valid_until: i === 0 ? '2026-01-01T00:00:00Z' : null,
      })
    );

    applyWorkingMemoryPipeline(memories, 20, NOW);

    expect(logInfo).not.toHaveBeenCalled();
  });

  it('logs warning when pipeline returns empty from non-empty input', () => {
    // All memories expired
    const memories = [
      makeMemory({ id: 1, valid_until: '2026-01-01T00:00:00Z' }),
      makeMemory({ id: 2, valid_until: '2026-01-01T00:00:00Z' }),
    ];

    const result = applyWorkingMemoryPipeline(memories, 10, NOW);

    expect(result).toEqual([]);
    expect(logWarn).toHaveBeenCalledWith(
      'working-memory',
      expect.stringContaining('Pipeline returned 0 memories'),
      expect.objectContaining({ totalBefore: 2, afterValidity: 0 })
    );
  });

  it('handles empty input gracefully', () => {
    const result = applyWorkingMemoryPipeline([], 10, NOW);
    expect(result).toEqual([]);
    // No warnings for empty input
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('preserves all original fields on returned memories', () => {
    const memory = makeMemory({
      id: 42,
      content: 'important decision',
      quality_score: 0.9,
      access_count: 20,
    });

    const result = applyWorkingMemoryPipeline([memory], 10, NOW);

    expect(result[0]).toBe(memory); // same reference, not a copy
    expect(result[0].content).toBe('important decision');
    expect(result[0].access_count).toBe(20);
  });

  it('handles mixed null and non-null quality scores (partial scoring)', () => {
    const memories = [
      makeMemory({ id: 1, quality_score: null, access_count: 0 }),
      makeMemory({ id: 2, quality_score: 0.9, access_count: 10 }),
      makeMemory({ id: 3, quality_score: null, access_count: 0 }),
    ];

    // Should still use scoring path (hasAnyQuality = true)
    // Null quality_score gets default 0.5 from calculateEffectiveScore
    const result = applyWorkingMemoryPipeline(memories, 10, NOW);

    // id:2 with quality 0.9 and 10 accesses should be first
    expect(result[0].id).toBe(2);
    expect(logWarn).not.toHaveBeenCalledWith(
      'working-memory',
      expect.stringContaining('falling back to recency'),
      expect.any(Object)
    );
  });
});
