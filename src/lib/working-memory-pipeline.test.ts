import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyWorkingMemoryPipeline,
  detectInvariant,
  isPinned,
  PIN_THRESHOLD,
} from './working-memory-pipeline.js';
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
    correction_count: 0,
    is_invariant: false,
    ...overrides,
  };
}

// =============================================================================
// detectInvariant
// =============================================================================

describe('detectInvariant', () => {
  it('detects "always" patterns', () => {
    expect(detectInvariant('Always use ESM imports')).toBe(true);
    expect(detectInvariant('You should always validate input before processing')).toBe(true);
  });

  it('detects "never" patterns', () => {
    expect(detectInvariant('Never commit .env files')).toBe(true);
    expect(detectInvariant('never push to main without review')).toBe(true);
  });

  it('detects "must" patterns', () => {
    expect(detectInvariant('Tests must pass before merge')).toBe(true);
    expect(detectInvariant('Must not use raw SQL queries')).toBe(true);
  });

  it('detects "do not" patterns', () => {
    expect(detectInvariant("Do not access the database directly")).toBe(true);
    expect(detectInvariant("Don't skip pre-commit hooks")).toBe(true);
  });

  it('detects standalone keywords', () => {
    expect(detectInvariant('ESM extensions are required for all imports')).toBe(true);
    expect(detectInvariant('Direct DB access is forbidden')).toBe(true);
    expect(detectInvariant('Unsafe code execution is prohibited in this codebase')).toBe(true);
  });

  it('detects "CRITICAL:" prefix', () => {
    expect(detectInvariant('CRITICAL: run tests before committing')).toBe(true);
    expect(detectInvariant('Important: validate all user input')).toBe(true);
  });

  it('detects compound patterns', () => {
    expect(detectInvariant('Never deploy without running the test suite')).toBe(true);
    expect(detectInvariant('Always lint before committing code')).toBe(true);
  });

  it('returns false for normal content', () => {
    expect(detectInvariant('The database uses SQLite for local storage')).toBe(false);
    expect(detectInvariant('React 19 introduced new hooks')).toBe(false);
    expect(detectInvariant('Fixed a bug in the login flow')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(detectInvariant('ALWAYS USE ESM')).toBe(true);
    expect(detectInvariant('NEVER commit secrets')).toBe(true);
  });
});

// =============================================================================
// isPinned
// =============================================================================

describe('isPinned', () => {
  it('returns true for invariant memories', () => {
    expect(isPinned(makeMemory({ is_invariant: true, correction_count: 0 }))).toBe(true);
  });

  it('returns true for correction_count >= threshold', () => {
    expect(isPinned(makeMemory({ correction_count: PIN_THRESHOLD }))).toBe(true);
    expect(isPinned(makeMemory({ correction_count: PIN_THRESHOLD + 1 }))).toBe(true);
  });

  it('returns false for uncorrected non-invariant memories', () => {
    expect(isPinned(makeMemory({ correction_count: 0, is_invariant: false }))).toBe(false);
    expect(isPinned(makeMemory({ correction_count: 1, is_invariant: false }))).toBe(false);
  });
});

// =============================================================================
// applyWorkingMemoryPipeline
// =============================================================================

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
      makeMemory({ id: 1, valid_until: '2026-02-13T00:00:00Z' }),
      makeMemory({ id: 2, valid_until: null }),
      makeMemory({ id: 3, valid_until: '2026-03-01T00:00:00Z' }),
    ];

    const result = applyWorkingMemoryPipeline(memories, 10, NOW);
    const ids = result.map((m) => m.id);
    expect(ids).not.toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
  });

  it('filters out memories with valid_from in the future', () => {
    const memories = [
      makeMemory({ id: 1, valid_from: '2026-03-01T00:00:00Z' }),
      makeMemory({ id: 2, valid_from: '2026-01-01T00:00:00Z' }),
      makeMemory({ id: 3, valid_from: null }),
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
    expect(result.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(logWarn).toHaveBeenCalledWith(
      'working-memory',
      expect.stringContaining('falling back to recency'),
      expect.any(Object)
    );
  });

  it('logs telemetry when validity filters out >10% of candidates', () => {
    const memories = Array.from({ length: 10 }, (_, i) =>
      makeMemory({
        id: i + 1,
        valid_until: i < 5 ? '2026-01-01T00:00:00Z' : null,
      })
    );

    applyWorkingMemoryPipeline(memories, 10, NOW);

    expect(logInfo).toHaveBeenCalledWith(
      'working-memory',
      expect.stringContaining('Validity filter removed'),
      expect.objectContaining({ filtered: expect.any(Number) })
    );
  });

  it('logs warning when pipeline returns empty from non-empty input', () => {
    const memories = [
      makeMemory({ id: 1, valid_until: '2026-01-01T00:00:00Z' }),
      makeMemory({ id: 2, valid_until: '2026-01-01T00:00:00Z' }),
    ];

    const result = applyWorkingMemoryPipeline(memories, 10, NOW);
    expect(result).toEqual([]);
    expect(logWarn).toHaveBeenCalledWith(
      'working-memory',
      expect.stringContaining('Pipeline returned 0 memories'),
      expect.objectContaining({ totalBefore: 2 })
    );
  });

  it('handles empty input gracefully', () => {
    const result = applyWorkingMemoryPipeline([], 10, NOW);
    expect(result).toEqual([]);
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
    expect(result[0]).toBe(memory);
    expect(result[0].content).toBe('important decision');
  });

  // =========================================================================
  // Two-phase fetch: pinned memories
  // =========================================================================

  it('includes pinned memories from separate fetch', () => {
    const recent = [
      makeMemory({ id: 1, quality_score: 0.9, created_at: '2026-02-14T00:00:00Z' }),
      makeMemory({ id: 2, quality_score: 0.8, created_at: '2026-02-13T00:00:00Z' }),
    ];

    const pinned = [
      makeMemory({
        id: 100,
        quality_score: 0.4,
        correction_count: 3,
        created_at: '2025-06-01T00:00:00Z', // 8 months old
      }),
    ];

    const result = applyWorkingMemoryPipeline(recent, 3, NOW, pinned);

    // Pinned memory should be first despite low quality and old age
    expect(result[0].id).toBe(100);
    expect(result.length).toBe(3);
  });

  it('deduplicates pinned memories that also appear in recent', () => {
    const memory = makeMemory({ id: 1, correction_count: 3, quality_score: 0.9 });
    const recent = [memory, makeMemory({ id: 2, quality_score: 0.5 })];
    const pinned = [memory];

    const result = applyWorkingMemoryPipeline(recent, 10, NOW, pinned);
    const id1Count = result.filter((m) => m.id === 1).length;
    expect(id1Count).toBe(1);
  });

  it('detects pinned memories inline (no separate pinned array)', () => {
    const memories = [
      makeMemory({ id: 1, quality_score: 0.9 }),
      makeMemory({ id: 2, quality_score: 0.3, correction_count: 5 }), // pinned inline
      makeMemory({ id: 3, quality_score: 0.6 }),
    ];

    const result = applyWorkingMemoryPipeline(memories, 3, NOW);

    // id:2 should be first (pinned), despite low quality
    expect(result[0].id).toBe(2);
  });

  it('includes is_invariant memories as pinned', () => {
    const memories = [
      makeMemory({ id: 1, quality_score: 0.9 }),
      makeMemory({ id: 2, quality_score: 0.2, is_invariant: true }), // invariant pin
    ];

    const result = applyWorkingMemoryPipeline(memories, 2, NOW);
    expect(result[0].id).toBe(2); // pinned first
  });

  it('logs pinned count telemetry', () => {
    const pinned = [
      makeMemory({ id: 1, correction_count: 3, is_invariant: true }),
      makeMemory({ id: 2, correction_count: 5 }),
    ];

    applyWorkingMemoryPipeline([], 10, NOW, pinned);

    expect(logInfo).toHaveBeenCalledWith(
      'working-memory',
      expect.stringContaining('2 pinned memories'),
      expect.objectContaining({ pinned: 2, invariant: 1, corrected: 2 })
    );
  });

  it('caps at limit even with many pinned memories', () => {
    const pinned = Array.from({ length: 20 }, (_, i) =>
      makeMemory({ id: i + 1, correction_count: 3 })
    );

    const result = applyWorkingMemoryPipeline([], 5, NOW, pinned);
    expect(result.length).toBe(5);
  });

  it('fills remaining slots with scored memories after pinned', () => {
    const pinned = [makeMemory({ id: 100, correction_count: 3, quality_score: 0.3 })];
    const recent = [
      makeMemory({ id: 1, quality_score: 0.5 }),
      makeMemory({ id: 2, quality_score: 0.9 }),
      makeMemory({ id: 3, quality_score: 0.7 }),
    ];

    const result = applyWorkingMemoryPipeline(recent, 3, NOW, pinned);

    expect(result[0].id).toBe(100); // pinned first
    expect(result[1].id).toBe(2);   // highest score
    expect(result.length).toBe(3);
  });

  it('excludes expired pinned memories', () => {
    const pinned = [
      makeMemory({ id: 100, correction_count: 3, valid_until: '2026-01-01T00:00:00Z' }),
    ];

    const result = applyWorkingMemoryPipeline([], 10, NOW, pinned);
    expect(result.length).toBe(0);
  });
});
