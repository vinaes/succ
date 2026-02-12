/**
 * Tests for session counters in StorageDispatcher.
 *
 * Verifies:
 * - Counter initialization and getSessionCounters() snapshot
 * - Increment in saveMemory (created + duplicate paths)
 * - Increment in saveGlobalMemory (created + duplicate paths)
 * - Increment in hybridSearchMemories, hybridSearchDocs, hybridSearchCode
 * - flushSessionCounters writes to learning_deltas and resets
 * - flushSessionCounters skips when all counters are zero
 * - flushSessionCounters handles errors gracefully
 * - typesCreated breakdown by memory type
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageDispatcher, getStorageDispatcher, resetStorageDispatcher } from './dispatcher.js';

// Mock config to avoid real file reads
vi.mock('../config.js', () => ({
  getConfig: vi.fn(() => ({ storage: {} })),
  getProjectRoot: vi.fn(() => '/test/project'),
  getSuccDir: vi.fn(() => '/test/project/.succ'),
  getStorageConfig: vi.fn(() => ({ backend: 'sqlite', vector: 'builtin' })),
  invalidateConfigCache: vi.fn(),
}));

describe('Session Counters', () => {
  let dispatcher: StorageDispatcher;

  // SQLite mock that returns enough for saveMemory/search to work
  const sqliteMock: Record<string, any> = {
    saveMemory: vi.fn(() => ({ id: 1, isDuplicate: false, similarity: null })),
    saveGlobalMemory: vi.fn(() => ({ id: 1, isDuplicate: false, similarity: null })),
    hybridSearchMemories: vi.fn(async () => []),
    hybridSearchDocs: vi.fn(async () => []),
    hybridSearchCode: vi.fn(async () => []),
    getMemoryStats: vi.fn(() => ({ total_memories: 10, by_type: {}, oldest_memory: null, newest_memory: null, stale_count: 0 })),
    getDb: vi.fn(() => ({
      prepare: vi.fn(() => ({ run: vi.fn() })),
    })),
  };

  beforeEach(async () => {
    resetStorageDispatcher();
    dispatcher = await getStorageDispatcher();
    // Inject mock SQLite functions via private field
    (dispatcher as any)._sqliteFns = sqliteMock;
    // Reset all mocks
    vi.clearAllMocks();
  });

  describe('getSessionCounters', () => {
    it('should return zeroed counters on fresh dispatcher', () => {
      const c = dispatcher.getSessionCounters();
      expect(c.memoriesCreated).toBe(0);
      expect(c.memoriesDuplicated).toBe(0);
      expect(c.globalMemoriesCreated).toBe(0);
      expect(c.recallQueries).toBe(0);
      expect(c.searchQueries).toBe(0);
      expect(c.codeSearchQueries).toBe(0);
      expect(c.typesCreated).toEqual({});
      expect(c.startedAt).toBeTruthy();
    });

    it('should return a snapshot (not a reference)', () => {
      const c1 = dispatcher.getSessionCounters();
      c1.memoriesCreated = 999;
      const c2 = dispatcher.getSessionCounters();
      expect(c2.memoriesCreated).toBe(0);
    });
  });

  describe('saveMemory increments', () => {
    it('should increment memoriesCreated when memory is new', async () => {
      sqliteMock.saveMemory.mockReturnValueOnce({ id: 1, isDuplicate: false, similarity: null });
      const result = await dispatcher.saveMemory('test content', [0.1, 0.2], ['tag1'], 'test');
      expect(result.created).toBe(true);
      const c = dispatcher.getSessionCounters();
      expect(c.memoriesCreated).toBe(1);
      expect(c.memoriesDuplicated).toBe(0);
    });

    it('should increment memoriesDuplicated when memory is duplicate', async () => {
      sqliteMock.saveMemory.mockReturnValueOnce({ id: 1, isDuplicate: true, similarity: 0.98 });
      const result = await dispatcher.saveMemory('test content', [0.1, 0.2], ['tag1'], 'test');
      expect(result.created).toBe(false);
      const c = dispatcher.getSessionCounters();
      expect(c.memoriesCreated).toBe(0);
      expect(c.memoriesDuplicated).toBe(1);
    });

    it('should track typesCreated breakdown', async () => {
      sqliteMock.saveMemory.mockReturnValueOnce({ id: 1, isDuplicate: false });
      await dispatcher.saveMemory('test', [0.1], [], 'test', { type: 'decision' });
      sqliteMock.saveMemory.mockReturnValueOnce({ id: 2, isDuplicate: false });
      await dispatcher.saveMemory('test2', [0.2], [], 'test', { type: 'decision' });
      sqliteMock.saveMemory.mockReturnValueOnce({ id: 3, isDuplicate: false });
      await dispatcher.saveMemory('test3', [0.3], [], 'test', { type: 'learning' });

      const c = dispatcher.getSessionCounters();
      expect(c.memoriesCreated).toBe(3);
      expect(c.typesCreated).toEqual({ decision: 2, learning: 1 });
    });

    it('should not track type for duplicates', async () => {
      sqliteMock.saveMemory.mockReturnValueOnce({ id: 1, isDuplicate: true, similarity: 0.99 });
      await dispatcher.saveMemory('test', [0.1], [], 'test', { type: 'decision' });
      const c = dispatcher.getSessionCounters();
      expect(c.typesCreated).toEqual({});
    });

    it('should default to observation type', async () => {
      sqliteMock.saveMemory.mockReturnValueOnce({ id: 1, isDuplicate: false });
      await dispatcher.saveMemory('test', [0.1], [], 'test');
      const c = dispatcher.getSessionCounters();
      expect(c.typesCreated).toEqual({ observation: 1 });
    });
  });

  describe('saveGlobalMemory increments', () => {
    it('should increment globalMemoriesCreated when new', async () => {
      sqliteMock.saveGlobalMemory.mockReturnValueOnce({ id: 1, isDuplicate: false });
      const result = await dispatcher.saveGlobalMemory('test', [0.1], ['tag1']);
      expect(result.created).toBe(true);
      const c = dispatcher.getSessionCounters();
      expect(c.globalMemoriesCreated).toBe(1);
      expect(c.memoriesCreated).toBe(0);
    });

    it('should increment memoriesDuplicated for global duplicates', async () => {
      sqliteMock.saveGlobalMemory.mockReturnValueOnce({ id: 1, isDuplicate: true, similarity: 0.97 });
      const result = await dispatcher.saveGlobalMemory('test', [0.1], ['tag1']);
      expect(result.created).toBe(false);
      const c = dispatcher.getSessionCounters();
      expect(c.globalMemoriesCreated).toBe(0);
      expect(c.memoriesDuplicated).toBe(1);
    });
  });

  describe('search increments', () => {
    it('should increment recallQueries on hybridSearchMemories', async () => {
      await dispatcher.hybridSearchMemories('test query', [0.1, 0.2]);
      await dispatcher.hybridSearchMemories('another query', [0.3, 0.4]);
      const c = dispatcher.getSessionCounters();
      expect(c.recallQueries).toBe(2);
    });

    it('should increment searchQueries on hybridSearchDocs', async () => {
      await dispatcher.hybridSearchDocs('test query', [0.1, 0.2]);
      const c = dispatcher.getSessionCounters();
      expect(c.searchQueries).toBe(1);
    });

    it('should increment codeSearchQueries on hybridSearchCode', async () => {
      await dispatcher.hybridSearchCode('test query', [0.1, 0.2]);
      await dispatcher.hybridSearchCode('query2', [0.3, 0.4]);
      await dispatcher.hybridSearchCode('query3', [0.5, 0.6]);
      const c = dispatcher.getSessionCounters();
      expect(c.codeSearchQueries).toBe(3);
    });

    it('should track all counter types independently', async () => {
      sqliteMock.saveMemory.mockReturnValueOnce({ id: 1, isDuplicate: false });
      await dispatcher.saveMemory('test', [0.1], [], 'test');
      sqliteMock.saveGlobalMemory.mockReturnValueOnce({ id: 2, isDuplicate: false });
      await dispatcher.saveGlobalMemory('test', [0.2], []);
      await dispatcher.hybridSearchMemories('q', [0.3]);
      await dispatcher.hybridSearchDocs('q', [0.4]);
      await dispatcher.hybridSearchCode('q', [0.5]);

      const c = dispatcher.getSessionCounters();
      expect(c.memoriesCreated).toBe(1);
      expect(c.globalMemoriesCreated).toBe(1);
      expect(c.recallQueries).toBe(1);
      expect(c.searchQueries).toBe(1);
      expect(c.codeSearchQueries).toBe(1);
    });
  });

  describe('flushSessionCounters', () => {
    it('should write to learning_deltas and reset counters', async () => {
      // Build up some counters
      sqliteMock.saveMemory.mockReturnValueOnce({ id: 1, isDuplicate: false });
      await dispatcher.saveMemory('test', [0.1], [], 'test', { type: 'decision' });
      await dispatcher.hybridSearchMemories('q', [0.2]);

      // Spy on appendLearningDelta
      const appendSpy = vi.spyOn(dispatcher, 'appendLearningDelta').mockResolvedValueOnce();

      await dispatcher.flushSessionCounters('test-source');

      expect(appendSpy).toHaveBeenCalledOnce();
      const arg = appendSpy.mock.calls[0][0];
      expect(arg.source).toBe('test-source');
      expect(arg.newMemories).toBe(1);
      expect(arg.typesAdded).toEqual({ decision: 1 });
      expect(arg.memoriesAfter).toBe(10); // from getMemoryStats mock

      // Counters should be reset
      const c = dispatcher.getSessionCounters();
      expect(c.memoriesCreated).toBe(0);
      expect(c.recallQueries).toBe(0);
      expect(c.typesCreated).toEqual({});
    });

    it('should skip flush when all counters are zero', async () => {
      const appendSpy = vi.spyOn(dispatcher, 'appendLearningDelta');

      await dispatcher.flushSessionCounters('test-source');

      expect(appendSpy).not.toHaveBeenCalled();
    });

    it('should flush even if only search queries exist (no memories)', async () => {
      await dispatcher.hybridSearchDocs('q', [0.1]);

      const appendSpy = vi.spyOn(dispatcher, 'appendLearningDelta').mockResolvedValueOnce();
      await dispatcher.flushSessionCounters('test-source');

      expect(appendSpy).toHaveBeenCalledOnce();
      expect(appendSpy.mock.calls[0][0].newMemories).toBe(0);
    });

    it('should not throw on appendLearningDelta error', async () => {
      sqliteMock.saveMemory.mockReturnValueOnce({ id: 1, isDuplicate: false });
      await dispatcher.saveMemory('test', [0.1], [], 'test');

      vi.spyOn(dispatcher, 'appendLearningDelta').mockRejectedValueOnce(new Error('DB error'));
      const { logError: logErrorFn } = await import('../fault-logger.js');
      const logSpy = vi.spyOn({ logError: logErrorFn }, 'logError');

      // Should not throw
      await dispatcher.flushSessionCounters('test-source');

      // The error is now logged via logError('storage', ...) instead of console.error
      // Just verify it didn't throw — the fault-logger handles the logging
      logSpy.mockRestore();
    });

    it('should reset counters even after error', async () => {
      sqliteMock.saveMemory.mockReturnValueOnce({ id: 1, isDuplicate: false });
      await dispatcher.saveMemory('test', [0.1], [], 'test');

      vi.spyOn(dispatcher, 'appendLearningDelta').mockRejectedValueOnce(new Error('fail'));

      await dispatcher.flushSessionCounters('test-source');

      // Counters should still be reset after error
      const c = dispatcher.getSessionCounters();
      expect(c.memoriesCreated).toBe(0);
      vi.restoreAllMocks();
    });

    it('should compute memoriesBefore correctly', async () => {
      sqliteMock.saveMemory.mockReturnValueOnce({ id: 1, isDuplicate: false });
      await dispatcher.saveMemory('a', [0.1], [], 'test');
      sqliteMock.saveMemory.mockReturnValueOnce({ id: 2, isDuplicate: false });
      await dispatcher.saveMemory('b', [0.2], [], 'test');
      sqliteMock.saveGlobalMemory.mockReturnValueOnce({ id: 3, isDuplicate: false });
      await dispatcher.saveGlobalMemory('c', [0.3], []);

      // getMemoryStats returns total=10, we created 3 (2 local + 1 global)
      const appendSpy = vi.spyOn(dispatcher, 'appendLearningDelta').mockResolvedValueOnce();
      await dispatcher.flushSessionCounters('test');

      const arg = appendSpy.mock.calls[0][0];
      expect(arg.memoriesBefore).toBe(7); // 10 - 3
      expect(arg.memoriesAfter).toBe(10);
      expect(arg.newMemories).toBe(3);
    });
  });
});
