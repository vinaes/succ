import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from './types.js';

// ============================================================================
// Hoisted mocks
// ============================================================================

const { mockHybridSearch, mockGetEmbedding, mockLoadProgress } = vi.hoisted(() => ({
  mockHybridSearch: vi.fn(),
  mockGetEmbedding: vi.fn(),
  mockLoadProgress: vi.fn(),
}));

vi.mock('../storage/index.js', () => ({
  hybridSearchMemories: mockHybridSearch,
}));

vi.mock('../embeddings.js', () => ({
  getEmbedding: mockGetEmbedding,
}));

vi.mock('./state.js', () => ({
  loadProgress: mockLoadProgress,
}));

import { gatherTaskContext } from './context.js';

// ============================================================================
// Helpers
// ============================================================================

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_001',
    prd_id: 'prd_test',
    sequence: 1,
    title: 'Add auth module',
    description: 'Implement JWT authentication',
    status: 'pending',
    priority: 'high',
    depends_on: [],
    acceptance_criteria: ['Tests pass'],
    files_to_modify: ['src/auth.ts', 'src/middleware/jwt.ts'],
    relevant_files: [],
    context_queries: ['authentication', 'JWT tokens'],
    attempts: [],
    max_attempts: 3,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeMemory(id: number, content: string, type: string = 'learning') {
  return { id, content, type, tags: null, source: null, created_at: '2025-01-01', similarity: 0.8 };
}

// ============================================================================
// Tests
// ============================================================================

describe('gatherTaskContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
    mockHybridSearch.mockResolvedValue([]);
    mockLoadProgress.mockReturnValue('');
  });

  // --------------------------------------------------------------------------
  // Basic behavior
  // --------------------------------------------------------------------------

  it('should return default messages when no memories found', async () => {
    const result = await gatherTaskContext(makeTask(), 'prd_test');

    expect(result.recalled_memories).toBe('(No relevant memories found)');
    expect(result.dead_end_warnings).toBe('(No dead-ends recorded for this area)');
    expect(result.progress_so_far).toBe('(No progress recorded yet)');
  });

  it('should call hybridSearchMemories with correct args', async () => {
    await gatherTaskContext(makeTask(), 'prd_test');

    // Should search for context_queries + title + file basenames
    // context_queries: ['authentication', 'JWT tokens']
    // title: 'Add auth module'
    // file basenames: 'auth.ts', 'jwt.ts'
    // Total: 5 queries (at the 5-query limit)
    expect(mockHybridSearch).toHaveBeenCalledTimes(5);
    expect(mockGetEmbedding).toHaveBeenCalledTimes(5);

    // Check first call args
    expect(mockHybridSearch).toHaveBeenCalledWith('authentication', [0.1, 0.2, 0.3], 3, 0.3);
  });

  it('should limit queries to 5', async () => {
    const task = makeTask({
      context_queries: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'],
    });

    await gatherTaskContext(task, 'prd_test');

    // 6 context_queries + 1 title + 2 file basenames = 9
    // Sliced to 5
    expect(mockHybridSearch).toHaveBeenCalledTimes(5);
  });

  // --------------------------------------------------------------------------
  // Memory classification
  // --------------------------------------------------------------------------

  it('should separate regular memories from dead-ends', async () => {
    mockHybridSearch.mockResolvedValue([
      makeMemory(1, 'Use bcrypt for hashing', 'learning'),
      makeMemory(2, 'Tried MD5 hashing, insecure', 'dead_end'),
      makeMemory(3, 'Auth module uses middleware pattern', 'pattern'),
    ]);

    const result = await gatherTaskContext(makeTask(), 'prd_test');

    expect(result.recalled_memories).toContain('[learning] Use bcrypt for hashing');
    expect(result.recalled_memories).toContain('[pattern] Auth module uses middleware pattern');
    expect(result.recalled_memories).not.toContain('MD5');

    expect(result.dead_end_warnings).toContain('[DEAD-END] Tried MD5 hashing, insecure');
    expect(result.dead_end_warnings).not.toContain('bcrypt');
  });

  it('should default null type to observation', async () => {
    mockHybridSearch.mockResolvedValue([makeMemory(1, 'Some fact', null as unknown as string)]);

    const result = await gatherTaskContext(makeTask(), 'prd_test');

    expect(result.recalled_memories).toContain('[observation] Some fact');
  });

  // --------------------------------------------------------------------------
  // Deduplication
  // --------------------------------------------------------------------------

  it('should deduplicate memories across queries', async () => {
    const sharedMemory = makeMemory(1, 'JWT requires secret key', 'learning');

    // Same memory returned for multiple queries
    mockHybridSearch.mockResolvedValue([sharedMemory]);

    const result = await gatherTaskContext(makeTask(), 'prd_test');

    // Should appear only once despite being returned by multiple queries
    const occurrences = result.recalled_memories.split('JWT requires secret key').length - 1;
    expect(occurrences).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Progress
  // --------------------------------------------------------------------------

  it('should include progress from state', async () => {
    mockLoadProgress.mockReturnValue('task_001 completed\ntask_002 in progress');

    const result = await gatherTaskContext(makeTask(), 'prd_test');

    expect(result.progress_so_far).toBe('task_001 completed\ntask_002 in progress');
    expect(mockLoadProgress).toHaveBeenCalledWith('prd_test');
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  it('should handle storage import failure gracefully', async () => {
    mockHybridSearch.mockImplementation(() => {
      throw new Error('DB not initialized');
    });

    // The dynamic import mock already works — but let's simulate a total failure
    // by having the first query throw at the inner try level
    const result = await gatherTaskContext(makeTask(), 'prd_test');

    // Should still return valid context (empty memories or error message)
    expect(typeof result.recalled_memories).toBe('string');
    expect(typeof result.dead_end_warnings).toBe('string');
    expect(typeof result.progress_so_far).toBe('string');
  });

  it('should skip individual failed queries without aborting', async () => {
    let callCount = 0;
    mockHybridSearch.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('timeout');
      return [makeMemory(callCount, `Memory from query ${callCount}`, 'learning')];
    });

    const result = await gatherTaskContext(makeTask(), 'prd_test');

    // First query fails, rest succeed — should still have memories
    expect(result.recalled_memories).toContain('Memory from query');
  });

  // --------------------------------------------------------------------------
  // File basename extraction
  // --------------------------------------------------------------------------

  it('should extract file basenames for queries', async () => {
    const task = makeTask({
      context_queries: [],
      files_to_modify: ['src/lib/deep/nested/handler.ts'],
    });

    await gatherTaskContext(task, 'prd_test');

    // Queries: title + 'handler.ts'
    const queriedTerms = mockHybridSearch.mock.calls.map((c) => c[0]);
    expect(queriedTerms).toContain('handler.ts');
  });

  it('should handle empty context_queries and files_to_modify', async () => {
    const task = makeTask({
      context_queries: [],
      files_to_modify: [],
    });

    await gatherTaskContext(task, 'prd_test');

    // Only the title query
    expect(mockHybridSearch).toHaveBeenCalledTimes(1);
    expect(mockHybridSearch).toHaveBeenCalledWith('Add auth module', [0.1, 0.2, 0.3], 3, 0.3);
  });
});
