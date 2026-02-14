import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyWorkingMemoryPipeline,
  applyDiversityFilter,
  detectInvariant,
  detectInvariantWithEmbedding,
  clearInvariantEmbeddingCache,
  INVARIANT_REFERENCE_PHRASES,
  isPinned,
  getTagWeight,
  computeConfidenceDecay,
  computePriorityScore,
  PinnedMemoryError,
  PIN_THRESHOLD,
  DIVERSITY_THRESHOLD,
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
    expect(detectInvariant('Do not access the database directly')).toBe(true);
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

  // Multi-language support
  it('detects Russian invariant patterns', () => {
    expect(detectInvariant('Всегда делай PR review перед мержем')).toBe(true);
    expect(detectInvariant('Никогда не пушь напрямую в main')).toBe(true);
    expect(detectInvariant('Обязательно запускай тесты перед коммитом')).toBe(true);
    expect(detectInvariant('Запрещено коммитить секреты в репо')).toBe(true);
    expect(detectInvariant('Нельзя использовать any в TypeScript')).toBe(true);
    expect(detectInvariant('Ни в коем случае не удаляй миграции')).toBe(true);
    expect(detectInvariant('Это запрещено')).toBe(true); // keyword at end of string
    expect(detectInvariant('Это нельзя')).toBe(true);
  });

  it('detects German invariant patterns', () => {
    expect(detectInvariant('Immer Tests vor dem Commit ausführen')).toBe(true);
    expect(detectInvariant('Niemals direkt auf main pushen')).toBe(true);
    expect(detectInvariant('Das ist verboten in Produktion')).toBe(true);
  });

  it('detects French invariant patterns', () => {
    expect(detectInvariant('Toujours vérifier les tests avant de merger')).toBe(true);
    expect(detectInvariant('Jamais pousser directement sur main')).toBe(true);
    expect(detectInvariant('Accès interdit sans authentification')).toBe(true);
  });

  it('detects Spanish invariant patterns', () => {
    expect(detectInvariant('Siempre ejecutar tests antes de commit')).toBe(true);
    expect(detectInvariant('Nunca hacer push directo a main')).toBe(true);
    expect(detectInvariant('Acceso prohibido sin autenticación')).toBe(true);
  });

  it('detects Chinese invariant patterns', () => {
    expect(detectInvariant('必须在提交前运行测试')).toBe(true);
    expect(detectInvariant('绝不允许直接推送到主分支')).toBe(true);
    expect(detectInvariant('禁止提交敏感信息')).toBe(true);
  });

  it('detects Japanese invariant patterns', () => {
    expect(detectInvariant('必ずテストを実行してからコミットすること')).toBe(true);
    expect(detectInvariant('本番環境での直接変更は禁止')).toBe(true);
  });

  it('detects Korean invariant patterns', () => {
    expect(detectInvariant('반드시 테스트를 실행한 후 커밋하세요')).toBe(true);
    expect(detectInvariant('메인 브랜치에 직접 푸시해서는 안됩니다')).toBe(true); // "해서는 안" = "must not"
  });

  it('does not false-positive on normal non-English content', () => {
    expect(detectInvariant('Базу данных обновили вчера')).toBe(false);
    expect(detectInvariant('Die Datenbank wurde gestern aktualisiert')).toBe(false);
    expect(detectInvariant('数据库昨天更新了')).toBe(false);
  });
});

// =============================================================================
// detectInvariantWithEmbedding (embedding-based fallback)
// =============================================================================
describe('detectInvariantWithEmbedding', () => {
  beforeEach(() => {
    clearInvariantEmbeddingCache();
    vi.restoreAllMocks();
  });

  it('returns false for empty embedding', async () => {
    expect(await detectInvariantWithEmbedding('test', [])).toBe(false);
  });

  it('returns true when embedding is similar to invariant references', async () => {
    // Mock the reference-embeddings module to return high similarity
    vi.doMock('./reference-embeddings.js', () => ({
      registerReferenceSet: vi.fn(),
      maxSimilarityToReference: vi.fn().mockResolvedValue(0.75),
    }));

    // Re-import to pick up mocks — need to clear cache first
    clearInvariantEmbeddingCache();
    const { detectInvariantWithEmbedding: fn } = await import('./working-memory-pipeline.js');
    const result = await fn('some invariant-like content', [0.1, 0.2, 0.3]);
    expect(result).toBe(true);
  });

  it('returns false when embedding is not similar to invariant references', async () => {
    vi.doMock('./reference-embeddings.js', () => ({
      registerReferenceSet: vi.fn(),
      maxSimilarityToReference: vi.fn().mockResolvedValue(0.2),
    }));

    clearInvariantEmbeddingCache();
    const { detectInvariantWithEmbedding: fn } = await import('./working-memory-pipeline.js');
    const result = await fn('just a normal observation', [0.1, 0.2, 0.3]);
    expect(result).toBe(false);
  });

  it('returns false on error (non-fatal)', async () => {
    vi.doMock('./reference-embeddings.js', () => ({
      registerReferenceSet: vi.fn(() => {
        throw new Error('test');
      }),
      maxSimilarityToReference: vi.fn().mockRejectedValue(new Error('test')),
    }));

    clearInvariantEmbeddingCache();
    const { detectInvariantWithEmbedding: fn } = await import('./working-memory-pipeline.js');
    const result = await fn('test', [0.1, 0.2, 0.3]);
    expect(result).toBe(false);
  });

  it('exports INVARIANT_REFERENCE_PHRASES as non-empty array', () => {
    expect(INVARIANT_REFERENCE_PHRASES).toBeDefined();
    expect(INVARIANT_REFERENCE_PHRASES.length).toBeGreaterThanOrEqual(5);
    expect(INVARIANT_REFERENCE_PHRASES.every((p) => typeof p === 'string')).toBe(true);
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
// getTagWeight
// =============================================================================

describe('getTagWeight', () => {
  it('returns correct weights for each memory type', () => {
    expect(getTagWeight('decision', [])).toBe(1.0);
    expect(getTagWeight('error', [])).toBe(0.9);
    expect(getTagWeight('dead_end', [])).toBe(0.85);
    expect(getTagWeight('pattern', [])).toBe(0.8);
    expect(getTagWeight('learning', [])).toBe(0.7);
    expect(getTagWeight('observation', [])).toBe(0.5);
  });

  it('defaults to observation weight for null type', () => {
    expect(getTagWeight(null, [])).toBe(0.5);
  });

  it('defaults to 0.5 for unknown types', () => {
    expect(getTagWeight('unknown_type', [])).toBe(0.5);
  });

  it('boosts for critical/architecture/security tags', () => {
    expect(getTagWeight('observation', ['critical'])).toBe(0.6);
    expect(getTagWeight('observation', ['architecture'])).toBe(0.6);
    expect(getTagWeight('observation', ['security'])).toBe(0.6);
  });

  it('caps at 1.0 even with boost', () => {
    expect(getTagWeight('decision', ['critical'])).toBe(1.0);
  });

  it('boost is case-insensitive', () => {
    expect(getTagWeight('observation', ['CRITICAL'])).toBe(0.6);
    expect(getTagWeight('observation', ['Architecture'])).toBe(0.6);
  });

  it('ignores non-boost tags', () => {
    expect(getTagWeight('observation', ['debug', 'temp', 'test'])).toBe(0.5);
  });
});

// =============================================================================
// computeConfidenceDecay
// =============================================================================

describe('computeConfidenceDecay', () => {
  it('returns full quality for recently accessed memory', () => {
    const result = computeConfidenceDecay(0.8, '2026-02-14T11:00:00Z', '2026-02-13T00:00:00Z', NOW);
    // 1 hour ago → decay close to 1.0
    expect(result).toBeGreaterThan(0.79);
    expect(result).toBeLessThanOrEqual(0.8);
  });

  it('decays quality after 7 days (half-life)', () => {
    const sevenDaysAgo = '2026-02-07T12:00:00Z';
    const result = computeConfidenceDecay(1.0, sevenDaysAgo, '2026-02-01T00:00:00Z', NOW);
    // After 7 days, decay factor ~= 0.5
    expect(result).toBeCloseTo(0.5, 1);
  });

  it('floors at 10% of quality', () => {
    const veryOld = '2025-01-01T00:00:00Z';
    const result = computeConfidenceDecay(1.0, veryOld, '2025-01-01T00:00:00Z', NOW);
    expect(result).toBeGreaterThanOrEqual(0.1);
  });

  it('uses created_at when last_accessed is null', () => {
    const result = computeConfidenceDecay(0.8, null, '2026-02-14T11:00:00Z', NOW);
    // Uses created_at (1 hour ago) → high
    expect(result).toBeGreaterThan(0.79);
  });

  it('defaults quality to 0.5 when null', () => {
    const result = computeConfidenceDecay(
      null,
      '2026-02-14T11:00:00Z',
      '2026-02-14T00:00:00Z',
      NOW
    );
    expect(result).toBeGreaterThan(0.49);
    expect(result).toBeLessThanOrEqual(0.5);
  });

  it('handles future timestamps gracefully (clamps to 0)', () => {
    const future = '2026-02-15T00:00:00Z';
    const result = computeConfidenceDecay(0.8, future, '2026-02-14T00:00:00Z', NOW);
    // hoursSince would be negative, clamped to 0 → decay = 1.0
    expect(result).toBe(0.8);
  });
});

// =============================================================================
// computePriorityScore
// =============================================================================

describe('computePriorityScore', () => {
  it('gives highest score to invariant + high quality + corrected decision', () => {
    const score = computePriorityScore(
      {
        is_invariant: true,
        quality_score: 1.0,
        correction_count: 5,
        type: 'decision',
        tags: ['critical'],
        access_count: 20,
        last_accessed: '2026-02-14T11:00:00Z',
        created_at: '2026-02-14T00:00:00Z',
      },
      NOW
    );
    // 0.30*1 + 0.25*~1.0 + 0.20*1.0 + 0.15*1.0 + 0.10*1.0 = ~1.0
    expect(score).toBeGreaterThan(0.9);
  });

  it('gives low score to old, unaccessed observation', () => {
    const score = computePriorityScore(
      {
        is_invariant: false,
        quality_score: 0.3,
        correction_count: 0,
        type: 'observation',
        tags: [],
        access_count: 0,
        last_accessed: null,
        created_at: '2025-01-01T00:00:00Z',
      },
      NOW
    );
    // 0.30*0 + 0.25*~0.03 + 0.20*0 + 0.15*0.5 + 0.10*0 = ~0.08
    expect(score).toBeLessThan(0.15);
  });

  it('is_invariant contributes 0.30', () => {
    const base = computePriorityScore(
      {
        is_invariant: false,
        quality_score: 0.5,
        correction_count: 0,
        type: 'observation',
        tags: [],
        access_count: 0,
        last_accessed: '2026-02-14T11:00:00Z',
        created_at: '2026-02-14T00:00:00Z',
      },
      NOW
    );
    const withInvariant = computePriorityScore(
      {
        is_invariant: true,
        quality_score: 0.5,
        correction_count: 0,
        type: 'observation',
        tags: [],
        access_count: 0,
        last_accessed: '2026-02-14T11:00:00Z',
        created_at: '2026-02-14T00:00:00Z',
      },
      NOW
    );
    expect(withInvariant - base).toBeCloseTo(0.3, 1);
  });

  it('handles string tags (JSON)', () => {
    const score = computePriorityScore(
      {
        is_invariant: false,
        quality_score: 0.5,
        correction_count: 0,
        type: 'observation',
        tags: '["critical"]',
        access_count: 0,
        last_accessed: '2026-02-14T11:00:00Z',
        created_at: '2026-02-14T00:00:00Z',
      },
      NOW
    );
    // Should parse JSON tags and apply boost
    expect(score).toBeGreaterThan(0.19); // 0.15 * 0.6 = 0.09 for tag component
  });

  it('handles null tags gracefully', () => {
    expect(() =>
      computePriorityScore(
        {
          is_invariant: false,
          quality_score: 0.5,
          correction_count: 0,
          type: null,
          tags: null,
          access_count: 0,
          last_accessed: null,
          created_at: '2026-02-14T00:00:00Z',
        },
        NOW
      )
    ).not.toThrow();
  });
});

// =============================================================================
// PinnedMemoryError
// =============================================================================

describe('PinnedMemoryError', () => {
  it('has correct name and message', () => {
    const err = new PinnedMemoryError(42);
    expect(err.name).toBe('PinnedMemoryError');
    expect(err.message).toContain('42');
    expect(err.message).toContain('pinned');
    expect(err.memoryId).toBe(42);
  });

  it('is instanceof Error', () => {
    expect(new PinnedMemoryError(1)).toBeInstanceOf(Error);
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

  it('prefers priority_score over effectiveScore when available', () => {
    const memories = [
      makeMemory({ id: 1, quality_score: 0.9, access_count: 20, priority_score: 0.1 }),
      makeMemory({ id: 2, quality_score: 0.3, access_count: 0, priority_score: 0.9 }),
    ];

    const result = applyWorkingMemoryPipeline(memories, 2, NOW);
    // id:2 has higher priority_score despite lower quality
    expect(result[0].id).toBe(2);
  });

  it('falls back to effectiveScore when priority_score is null', () => {
    const memories = [
      makeMemory({ id: 1, quality_score: 0.3, access_count: 0, priority_score: null }),
      makeMemory({ id: 2, quality_score: 0.9, access_count: 10, priority_score: null }),
    ];

    const result = applyWorkingMemoryPipeline(memories, 2, NOW);
    expect(result[0].id).toBe(2);
  });

  it('mixes priority_score and effectiveScore fallback', () => {
    const memories = [
      makeMemory({ id: 1, quality_score: 0.3, access_count: 1 }), // no priority_score → low effectiveScore
      makeMemory({ id: 2, quality_score: 0.1, priority_score: 0.99 }), // has priority_score
    ];

    const result = applyWorkingMemoryPipeline(memories, 2, NOW);
    expect(result[0].id).toBe(2); // priority_score 0.99 > effectiveScore
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
    expect(result[1].id).toBe(2); // highest score
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

// =============================================================================
// applyDiversityFilter
// =============================================================================

describe('applyDiversityFilter', () => {
  // Helper: create embedding that's a unit vector in dimension i
  function unitVec(dim: number, i: number): number[] {
    const v = new Array(dim).fill(0);
    v[i] = 1;
    return v;
  }

  it('returns single item unchanged', async () => {
    const items = [{ id: 1 }];
    const getEmb = vi.fn().mockResolvedValue(new Map());
    const result = await applyDiversityFilter(items, getEmb);
    expect(result).toEqual([{ id: 1 }]);
    expect(getEmb).not.toHaveBeenCalled();
  });

  it('returns all items when no embeddings available', async () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const getEmb = vi.fn().mockResolvedValue(new Map());
    const result = await applyDiversityFilter(items, getEmb);
    expect(result.length).toBe(3);
  });

  it('keeps diverse items (orthogonal embeddings)', async () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const embeddings = new Map([
      [1, unitVec(3, 0)],
      [2, unitVec(3, 1)],
      [3, unitVec(3, 2)],
    ]);
    const getEmb = vi.fn().mockResolvedValue(embeddings);

    const result = await applyDiversityFilter(items, getEmb);
    expect(result.length).toBe(3);
  });

  it('removes near-duplicate items (identical embeddings)', async () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const sameVec = [1, 0, 0];
    const embeddings = new Map([
      [1, sameVec],
      [2, sameVec], // duplicate of 1
      [3, [0, 1, 0]], // different
    ]);
    const getEmb = vi.fn().mockResolvedValue(embeddings);

    const result = await applyDiversityFilter(items, getEmb);
    expect(result.length).toBe(2);
    expect(result.map((r) => r.id)).toEqual([1, 3]);
  });

  it('respects custom maxSimilarity threshold', async () => {
    const items = [{ id: 1 }, { id: 2 }];
    // These vectors have cosine similarity ~0.7
    const embeddings = new Map([
      [1, [1, 0, 0]],
      [2, [0.7, 0.7, 0]],
    ]);
    const getEmb = vi.fn().mockResolvedValue(embeddings);

    // With high threshold (0.9) — both kept
    const resultHigh = await applyDiversityFilter(items, getEmb, 0.9);
    expect(resultHigh.length).toBe(2);

    // With low threshold (0.5) — second removed
    const resultLow = await applyDiversityFilter(items, getEmb, 0.5);
    expect(resultLow.length).toBe(1);
  });

  it('keeps items without embeddings', async () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const embeddings = new Map([
      [1, [1, 0, 0]],
      // id:2 has no embedding
      [3, [1, 0, 0]], // duplicate of 1
    ]);
    const getEmb = vi.fn().mockResolvedValue(embeddings);

    const result = await applyDiversityFilter(items, getEmb);
    // id:1 kept (first), id:2 kept (no embedding), id:3 removed (duplicate of 1)
    expect(result.map((r) => r.id)).toEqual([1, 2]);
  });

  it('preserves order (first item always kept)', async () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const sameVec = [1, 0, 0];
    const embeddings = new Map([
      [1, sameVec],
      [2, sameVec],
      [3, sameVec],
    ]);
    const getEmb = vi.fn().mockResolvedValue(embeddings);

    const result = await applyDiversityFilter(items, getEmb);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(1);
  });
});
