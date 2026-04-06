/**
 * Tests for extraction-consolidation.ts
 *
 * Tests the intelligent ADD/UPDATE/DELETE consolidation logic
 * that runs between fact extraction and storage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock external dependencies before importing
vi.mock('../storage/index.js', () => ({
  searchMemories: vi.fn(async () => []),
  invalidateMemory: vi.fn(async () => true),
  saveMemory: vi.fn(async () => ({ id: 99, isDuplicate: false })),
  getMemoryById: vi.fn(async (id: number) => ({
    id,
    content: `Memory #${id}`,
    tags: ['test'],
    confidence: 0.5,
  })),
  getStorageDispatcher: vi.fn(async () => ({ flushSessionCounters: vi.fn() })),
}));

vi.mock('../embeddings.js', () => ({
  getEmbedding: vi.fn(async () => new Array(384).fill(0.1)),
}));

vi.mock('../llm.js', () => ({
  callLLM: vi.fn(
    async () =>
      '{"decision": "ADD", "existing_id": null, "reason": "new info", "merged_content": null}'
  ),
}));

vi.mock('../fault-logger.js', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('../errors.js', () => ({
  getErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

vi.mock('../quality.js', () => ({
  scoreMemory: vi.fn(async () => ({ score: 0.8, factors: {} })),
}));

vi.mock('../config.js', () => ({
  getConfig: vi.fn(() => ({
    auto_memory: { extraction_consolidation: true },
  })),
  getErrorReportingConfig: vi.fn().mockReturnValue({ enabled: false }),
}));

import {
  parseConsolidationResponse,
  consolidateExtractedFacts,
  executeUpdates,
  executeDeletes,
  isExtractionConsolidationEnabled,
} from './extraction-consolidation.js';
import type { ExtractedFactInput, FactToUpdate } from './extraction-consolidation.js';

import { searchMemories, invalidateMemory, saveMemory, getMemoryById } from '../storage/index.js';
import { callLLM } from '../llm.js';
import { getConfig } from '../config.js';

// ============================================================================
// parseConsolidationResponse
// ============================================================================

describe('parseConsolidationResponse', () => {
  it('should parse valid ADD response', () => {
    const response =
      '{"decision": "ADD", "existing_id": null, "reason": "new fact", "merged_content": null}';
    const result = parseConsolidationResponse(response);

    expect(result.decision).toBe('ADD');
    expect(result.existingId).toBeNull();
    expect(result.reason).toBe('new fact');
    expect(result.mergedContent).toBeNull();
  });

  it('should parse valid UPDATE response', () => {
    const response =
      '{"decision": "UPDATE", "existing_id": 2, "reason": "supersedes old", "merged_content": "merged text"}';
    const result = parseConsolidationResponse(response);

    expect(result.decision).toBe('UPDATE');
    expect(result.existingId).toBe(2);
    expect(result.reason).toBe('supersedes old');
    expect(result.mergedContent).toBe('merged text');
  });

  it('should parse valid DELETE response', () => {
    const response = '{"decision": "DELETE", "existing_id": 3, "reason": "contradicted"}';
    const result = parseConsolidationResponse(response);

    expect(result.decision).toBe('DELETE');
    expect(result.existingId).toBe(3);
  });

  it('should parse valid NONE response', () => {
    const response = '{"decision": "NONE", "existing_id": null, "reason": "already known"}';
    const result = parseConsolidationResponse(response);

    expect(result.decision).toBe('NONE');
  });

  it('should handle case-insensitive decisions', () => {
    const response = '{"decision": "add", "existing_id": null, "reason": "new"}';
    const result = parseConsolidationResponse(response);

    expect(result.decision).toBe('ADD');
  });

  it('should handle JSON wrapped in markdown code block', () => {
    const response =
      '```json\n{"decision": "UPDATE", "existing_id": 1, "reason": "better version", "merged_content": "updated"}\n```';
    const result = parseConsolidationResponse(response);

    expect(result.decision).toBe('UPDATE');
    expect(result.existingId).toBe(1);
  });

  it('should fall back to ADD for invalid JSON', () => {
    const response = 'This is not valid JSON at all';
    const result = parseConsolidationResponse(response);

    expect(result.decision).toBe('ADD');
    expect(result.reason).toBe('parse-fallback');
  });

  it('should fall back to ADD for unknown decision type', () => {
    const response = '{"decision": "MERGE", "existing_id": null, "reason": "unknown action"}';
    const result = parseConsolidationResponse(response);

    expect(result.decision).toBe('ADD');
    expect(result.reason).toBe('parse-fallback');
  });

  it('should fall back to ADD for malformed JSON', () => {
    const response = '{"decision": "ADD", "existing_id": ';
    const result = parseConsolidationResponse(response);

    expect(result.decision).toBe('ADD');
    expect(result.reason).toBe('parse-fallback');
  });

  it('should handle null existing_id for non-number values', () => {
    const response = '{"decision": "ADD", "existing_id": "abc", "reason": "test"}';
    const result = parseConsolidationResponse(response);

    expect(result.existingId).toBeNull();
  });

  it('should handle missing merged_content', () => {
    const response = '{"decision": "ADD", "existing_id": null, "reason": "test"}';
    const result = parseConsolidationResponse(response);

    expect(result.mergedContent).toBeNull();
  });
});

// ============================================================================
// consolidateExtractedFacts
// ============================================================================

describe('consolidateExtractedFacts', () => {
  const makeFact = (content: string): ExtractedFactInput => ({
    content,
    type: 'observation',
    confidence: 0.8,
    tags: ['test'],
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return all facts as ADD when no similar memories exist', async () => {
    vi.mocked(searchMemories).mockResolvedValue([]);

    const facts = [
      makeFact('This is a completely new fact about the codebase architecture patterns'),
      makeFact('Another new fact about testing approaches and vitest configuration'),
    ];

    const result = await consolidateExtractedFacts(facts);

    expect(result.toAdd).toHaveLength(2);
    expect(result.toUpdate).toHaveLength(0);
    expect(result.toDelete).toHaveLength(0);
    expect(result.skippedNone).toBe(0);
  });

  it('should return all as ADD in dry run mode', async () => {
    vi.mocked(searchMemories).mockResolvedValue([
      { id: 1, content: 'existing memory', confidence: 0.7 },
    ]);

    const facts = [makeFact('Some fact that might match existing memories in the database')];

    const result = await consolidateExtractedFacts(facts, { dryRun: true });

    expect(result.toAdd).toHaveLength(1);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('should handle UPDATE decision with ID remapping', async () => {
    // Return a similar memory with real ID 42
    vi.mocked(searchMemories).mockResolvedValue([
      { id: 42, content: 'old version of the fact about code architecture', confidence: 0.6 },
    ]);

    // LLM decides UPDATE, using sequential ID 1 (not real ID 42)
    vi.mocked(callLLM).mockResolvedValue(
      '{"decision": "UPDATE", "existing_id": 1, "reason": "newer version", "merged_content": "merged fact content about code architecture and patterns"}'
    );

    const facts = [
      makeFact('Updated version of the fact about code architecture and new patterns'),
    ];

    const result = await consolidateExtractedFacts(facts);

    expect(result.toUpdate).toHaveLength(1);
    expect(result.toUpdate[0].existingMemoryId).toBe(42); // Remapped back to real ID
    expect(result.toUpdate[0].content).toBe(
      'merged fact content about code architecture and patterns'
    );
  });

  it('should handle DELETE decision with ID remapping', async () => {
    vi.mocked(searchMemories).mockResolvedValue([
      { id: 100, content: 'incorrect fact that was previously stored', confidence: 0.5 },
    ]);

    vi.mocked(callLLM).mockResolvedValue(
      '{"decision": "DELETE", "existing_id": 1, "reason": "contradicted by new evidence"}'
    );

    const facts = [
      makeFact('New evidence that contradicts the old stored fact about configuration'),
    ];

    const result = await consolidateExtractedFacts(facts);

    expect(result.toDelete).toEqual([100]); // Remapped back to real ID
    expect(result.toAdd).toHaveLength(0);
  });

  it('should handle NONE decision (skip duplicate)', async () => {
    vi.mocked(searchMemories).mockResolvedValue([
      { id: 5, content: 'exact same fact already stored in the database', confidence: 0.8 },
    ]);

    vi.mocked(callLLM).mockResolvedValue(
      '{"decision": "NONE", "existing_id": null, "reason": "already captured"}'
    );

    const facts = [
      makeFact('Exact same fact that is already stored in the database for this project'),
    ];

    const result = await consolidateExtractedFacts(facts);

    expect(result.skippedNone).toBe(1);
    expect(result.toAdd).toHaveLength(0);
  });

  it('should fall back to ADD on LLM failure', async () => {
    vi.mocked(searchMemories).mockResolvedValue([{ id: 1, content: 'existing', confidence: 0.7 }]);

    vi.mocked(callLLM).mockRejectedValue(new Error('LLM timeout'));

    const facts = [
      makeFact('Fact that triggers LLM failure but should still be preserved for safety'),
    ];

    const result = await consolidateExtractedFacts(facts);

    expect(result.fallbackAdd).toHaveLength(1);
    expect(result.toAdd).toHaveLength(0);
  });

  it('should handle UPDATE with no valid existing_id by falling back to ADD', async () => {
    vi.mocked(searchMemories).mockResolvedValue([
      { id: 10, content: 'some memory', confidence: 0.6 },
    ]);

    // LLM says UPDATE but gives invalid existing_id (99 doesn't map)
    vi.mocked(callLLM).mockResolvedValue(
      '{"decision": "UPDATE", "existing_id": 99, "reason": "bad id"}'
    );

    const facts = [
      makeFact('Fact where LLM returns invalid memory ID reference for update decision'),
    ];

    const result = await consolidateExtractedFacts(facts);

    // Should fall back to ADD since seq ID 99 doesn't exist in the map
    expect(result.toAdd).toHaveLength(1);
    expect(result.toUpdate).toHaveLength(0);
  });

  it('should handle empty facts array', async () => {
    const result = await consolidateExtractedFacts([]);

    expect(result.toAdd).toHaveLength(0);
    expect(result.toUpdate).toHaveLength(0);
    expect(result.toDelete).toHaveLength(0);
    expect(result.skippedNone).toBe(0);
    expect(result.fallbackAdd).toHaveLength(0);
  });

  it('should process multiple facts with mixed decisions', async () => {
    // First fact: no similar memories → ADD
    // Second fact: similar memory exists, LLM says NONE
    // Third fact: similar memory exists, LLM says UPDATE

    vi.mocked(searchMemories)
      .mockResolvedValueOnce([]) // No similar for fact 1
      .mockResolvedValueOnce([{ id: 20, content: 'existing duplicate', confidence: 0.8 }]) // Similar for fact 2
      .mockResolvedValueOnce([{ id: 30, content: 'old version', confidence: 0.5 }]); // Similar for fact 3

    vi.mocked(callLLM)
      .mockResolvedValueOnce('{"decision": "NONE", "existing_id": null, "reason": "duplicate"}')
      .mockResolvedValueOnce(
        '{"decision": "UPDATE", "existing_id": 1, "reason": "newer", "merged_content": "updated fact"}'
      );

    const facts = [
      makeFact('Brand new fact one that has no matches in the existing memory database at all'),
      makeFact('Fact two that already exists word for word in the memory database system'),
      makeFact('Fact three that updates an older version of a memory about system design'),
    ];

    const result = await consolidateExtractedFacts(facts);

    expect(result.toAdd).toHaveLength(1); // fact 1
    expect(result.skippedNone).toBe(1); // fact 2
    expect(result.toUpdate).toHaveLength(1); // fact 3
    expect(result.toUpdate[0].existingMemoryId).toBe(30);
  });
});

// ============================================================================
// executeUpdates
// ============================================================================

describe('executeUpdates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should save new memory and invalidate old one', async () => {
    vi.mocked(saveMemory).mockResolvedValue({ id: 99, isDuplicate: false });
    vi.mocked(invalidateMemory).mockResolvedValue(true);

    const updates: FactToUpdate[] = [
      {
        existingMemoryId: 42,
        content: 'Updated memory content that is better and more current than old',
        type: 'observation',
        confidence: 0.8,
        tags: ['test'],
      },
    ];

    const executed = await executeUpdates(updates);

    expect(executed).toBe(1);
    expect(saveMemory).toHaveBeenCalledTimes(1);
    expect(invalidateMemory).toHaveBeenCalledWith(42, 99, 'extraction');
  });

  it('should not invalidate if save produces duplicate', async () => {
    vi.mocked(saveMemory).mockResolvedValue({ id: 50, isDuplicate: true });

    const updates: FactToUpdate[] = [
      {
        existingMemoryId: 10,
        content: 'Content that turns out to be a duplicate when saved to the database',
        type: 'learning',
        confidence: 0.7,
        tags: ['dup'],
      },
    ];

    const executed = await executeUpdates(updates);

    expect(executed).toBe(0);
    expect(invalidateMemory).not.toHaveBeenCalled();
  });

  it('should handle save errors gracefully', async () => {
    vi.mocked(saveMemory).mockRejectedValue(new Error('DB error'));

    const updates: FactToUpdate[] = [
      {
        existingMemoryId: 1,
        content: 'Content that fails to save due to database error during update operation',
        type: 'observation',
        confidence: 0.8,
        tags: [],
      },
    ];

    const executed = await executeUpdates(updates);

    expect(executed).toBe(0);
  });

  it('should cap confidence at 0.9 for auto-extracted updates', async () => {
    vi.mocked(saveMemory).mockResolvedValue({ id: 100, isDuplicate: false });

    const updates: FactToUpdate[] = [
      {
        existingMemoryId: 1,
        content: 'High confidence update that should still be capped at 0.9 for auto extracted',
        type: 'decision',
        confidence: 0.95,
        tags: ['high-conf'],
      },
    ];

    await executeUpdates(updates);

    // Check that saveMemory was called with confidence capped at 0.9
    const saveCall = vi.mocked(saveMemory).mock.calls[0];
    expect(saveCall[4]?.confidence).toBeLessThanOrEqual(0.9);
    expect(saveCall[4]?.confidence).toBe(0.9);
  });
});

// ============================================================================
// executeDeletes
// ============================================================================

describe('executeDeletes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should invalidate existing memories', async () => {
    vi.mocked(getMemoryById)
      .mockResolvedValueOnce({ id: 10, content: 'old' })
      .mockResolvedValueOnce({ id: 20, content: 'old' });
    vi.mocked(invalidateMemory).mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    const executed = await executeDeletes([10, 20]);

    expect(executed).toBe(2);
    expect(invalidateMemory).toHaveBeenCalledWith(10, 0, 'extraction');
    expect(invalidateMemory).toHaveBeenCalledWith(20, 0, 'extraction');
  });

  it('should skip non-existent memories', async () => {
    vi.mocked(getMemoryById).mockResolvedValue(null);

    const executed = await executeDeletes([999]);

    expect(executed).toBe(0);
    expect(invalidateMemory).not.toHaveBeenCalled();
  });

  it('should handle invalidation errors gracefully', async () => {
    vi.mocked(getMemoryById).mockResolvedValue({ id: 5, content: 'exists' });
    vi.mocked(invalidateMemory).mockRejectedValue(new Error('DB error'));

    const executed = await executeDeletes([5]);

    expect(executed).toBe(0);
  });
});

// ============================================================================
// isExtractionConsolidationEnabled
// ============================================================================

describe('isExtractionConsolidationEnabled', () => {
  it('should return true when config enables it', () => {
    vi.mocked(getConfig).mockReturnValue({
      auto_memory: { extraction_consolidation: true },
    } as any);

    expect(isExtractionConsolidationEnabled()).toBe(true);
  });

  it('should return false when config disables it', () => {
    vi.mocked(getConfig).mockReturnValue({
      auto_memory: { extraction_consolidation: false },
    } as any);

    expect(isExtractionConsolidationEnabled()).toBe(false);
  });

  it('should return false when auto_memory is missing', () => {
    vi.mocked(getConfig).mockReturnValue({} as any);

    expect(isExtractionConsolidationEnabled()).toBe(false);
  });

  it('should return false when extraction_consolidation is undefined', () => {
    vi.mocked(getConfig).mockReturnValue({
      auto_memory: {},
    } as any);

    expect(isExtractionConsolidationEnabled()).toBe(false);
  });

  it('should return false when getConfig throws', () => {
    vi.mocked(getConfig).mockImplementation(() => {
      throw new Error('no config');
    });

    expect(isExtractionConsolidationEnabled()).toBe(false);
  });
});
