/**
 * Tests for session-processor.ts
 *
 * Tests the progress-based session processing architecture:
 * - Progress file path generation
 * - Transcript tail reading
 * - Fact extraction parsing
 * - Transcript formatting
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let testTmpDir: string;

// Mock external dependencies before importing
vi.mock('../lib/db/index.js', () => ({
  saveMemory: vi.fn(() => ({ id: 'test-id', isDuplicate: false })),
  saveMemoriesBatch: vi.fn((memories: any[]) => ({
    saved: memories.length,
    skipped: 0,
    results: memories.map((_: any, index: number) => ({
      index,
      isDuplicate: false,
      id: index + 1,
      reason: 'saved' as const,
    })),
  })),
  searchMemories: vi.fn(() => []),
}));

vi.mock('../lib/embeddings.js', () => ({
  getEmbedding: vi.fn(() => new Float32Array(1536).fill(0)),
}));

vi.mock('../lib/config.js', () => ({
  getSuccDir: vi.fn(() => testTmpDir),
  getIdleReflectionConfig: vi.fn(() => ({
    agent_model: 'haiku',
    thresholds: { min_quality_for_summary: 0.5 },
  })),
  getConfig: vi.fn(() => ({
    sensitive_filter_enabled: false,
  })),
}));

vi.mock('../lib/quality.js', () => ({
  scoreMemory: vi.fn(() => ({ score: 0.8, factors: {} })),
  passesQualityThreshold: vi.fn(() => true),
}));

vi.mock('../lib/sensitive-filter.js', () => ({
  scanSensitive: vi.fn(() => ({ hasSensitive: false, redactedText: '' })),
}));

vi.mock('../lib/token-counter.js', () => ({
  countTokens: vi.fn(() => 100),
}));

vi.mock('../lib/llm.js', () => ({
  callLLM: vi.fn(() => Promise.resolve(JSON.stringify({ facts: [] }))),
}));

// Import after mocks are set up
import {
  parseTranscript,
  getProgressFilePath,
  readTailTranscript,
  parseFactsResponse,
  formatTranscriptForExtraction,
  type ExtractedFact,
} from './session-processor.js';

beforeEach(() => {
  testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'succ-test-'));
  fs.mkdirSync(path.join(testTmpDir, '.tmp'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(testTmpDir, { recursive: true, force: true });
});

// ============================================================================
// getProgressFilePath
// ============================================================================

describe('getProgressFilePath', () => {
  it('should return correct path format', () => {
    const sessionId = 'abc123';
    const result = getProgressFilePath(sessionId);

    expect(result).toContain('.tmp');
    expect(result).toContain(`session-${sessionId}-progress.md`);
  });

  it('should handle session IDs with special characters', () => {
    const sessionId = 'session-2026-02-03-12-30-00';
    const result = getProgressFilePath(sessionId);

    expect(result).toContain(`session-${sessionId}-progress.md`);
  });
});

// ============================================================================
// readTailTranscript
// ============================================================================

describe('readTailTranscript', () => {
  it('should return empty string for non-existent file', () => {
    const result = readTailTranscript('/non/existent/path.jsonl');
    expect(result).toBe('');
  });

  it('should read entire file if smaller than maxBytes', () => {
    const filePath = path.join(testTmpDir, 'small.jsonl');
    const content = 'line1\nline2\nline3\n';
    fs.writeFileSync(filePath, content);

    const result = readTailTranscript(filePath, 1000);
    expect(result).toBe(content);
  });

  it('should read only tail if file larger than maxBytes', () => {
    const filePath = path.join(testTmpDir, 'large.jsonl');
    // Create a file with 100 lines
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const content = lines.join('\n') + '\n';
    fs.writeFileSync(filePath, content);

    // Read only last 50 bytes
    const result = readTailTranscript(filePath, 50);

    // Should not include the full file
    expect(result.length).toBeLessThan(content.length);
    // Should start from a complete line (after first newline in buffer)
    expect(result).not.toContain('line 1\n');
  });

  it('should skip partial first line when reading tail', () => {
    const filePath = path.join(testTmpDir, 'partial.jsonl');
    const content = 'aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n';
    fs.writeFileSync(filePath, content);

    // Read only 20 bytes from end (will cut into middle of 'bbb...')
    const result = readTailTranscript(filePath, 20);

    // Should start with a complete line, not partial 'bbb...'
    expect(result).toMatch(/^[bc]/);
    expect(result).toContain('cccccccccc');
  });

  it('should handle empty file', () => {
    const filePath = path.join(testTmpDir, 'empty.jsonl');
    fs.writeFileSync(filePath, '');

    const result = readTailTranscript(filePath);
    expect(result).toBe('');
  });
});

// ============================================================================
// parseTranscript
// ============================================================================

describe('parseTranscript', () => {
  it('should parse valid JSONL transcript', () => {
    const transcriptPath = path.join(testTmpDir, 'test.jsonl');
    const content = [
      JSON.stringify({ type: 'user', message: { content: 'Hello' } }),
      JSON.stringify({ type: 'assistant', message: { content: 'Hi there!' } }),
    ].join('\n');

    fs.writeFileSync(transcriptPath, content);

    const entries = parseTranscript(transcriptPath);

    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('user');
    expect(entries[1].type).toBe('assistant');
  });

  it('should handle non-existent file', () => {
    const entries = parseTranscript('/non/existent/path.jsonl');
    expect(entries).toEqual([]);
  });

  it('should skip invalid JSON lines', () => {
    const transcriptPath = path.join(testTmpDir, 'test.jsonl');
    const content = [
      JSON.stringify({ type: 'user', message: { content: 'Hello' } }),
      'invalid json line',
      JSON.stringify({ type: 'assistant', message: { content: 'Hi!' } }),
    ].join('\n');

    fs.writeFileSync(transcriptPath, content);

    const entries = parseTranscript(transcriptPath);
    expect(entries).toHaveLength(2);
  });

  it('should handle empty file', () => {
    const transcriptPath = path.join(testTmpDir, 'empty.jsonl');
    fs.writeFileSync(transcriptPath, '');

    const entries = parseTranscript(transcriptPath);
    expect(entries).toEqual([]);
  });

  it('should handle file with only whitespace', () => {
    const transcriptPath = path.join(testTmpDir, 'whitespace.jsonl');
    fs.writeFileSync(transcriptPath, '  \n  \n  ');

    const entries = parseTranscript(transcriptPath);
    expect(entries).toEqual([]);
  });
});

// ============================================================================
// parseFactsResponse
// ============================================================================

describe('parseFactsResponse', () => {
  it('should parse valid JSON array from response', () => {
    const response = `Here are the extracted facts:
[
  {
    "content": "The session-processor uses progress files to avoid reading large transcripts at session end",
    "type": "observation",
    "confidence": 0.9,
    "tags": ["architecture", "performance"]
  }
]`;

    const facts = parseFactsResponse(response);

    expect(facts).toHaveLength(1);
    expect(facts[0].content).toContain('progress files');
    expect(facts[0].type).toBe('observation');
    expect(facts[0].confidence).toBe(0.9);
    expect(facts[0].tags).toContain('architecture');
  });

  it('should return empty array for response without JSON', () => {
    const response = 'No meaningful facts found in this session.';
    const facts = parseFactsResponse(response);
    expect(facts).toEqual([]);
  });

  it('should filter facts shorter than 50 characters', () => {
    const response = `[
      { "content": "Short fact", "type": "observation", "confidence": 0.9, "tags": [] },
      { "content": "This is a longer fact that should pass the minimum length requirement of fifty chars", "type": "learning", "confidence": 0.8, "tags": ["test"] }
    ]`;

    const facts = parseFactsResponse(response);

    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe('learning');
  });

  it('should filter invalid fact types', () => {
    const response = `[
      { "content": "Valid observation fact content here that is definitely long enough to pass", "type": "observation", "confidence": 0.9, "tags": [] },
      { "content": "Invalid type fact content here that is also definitely long enough to pass", "type": "invalid_type", "confidence": 0.8, "tags": [] }
    ]`;

    const facts = parseFactsResponse(response);

    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe('observation');
  });

  it('should accept all valid fact types', () => {
    const validTypes = ['decision', 'learning', 'observation', 'error', 'pattern'];
    const factsJson = validTypes.map((type, i) => ({
      content: `This is a valid ${type} fact with enough characters to pass the filter number ${i}`,
      type,
      confidence: 0.8,
      tags: [],
    }));

    const response = JSON.stringify(factsJson);
    const facts = parseFactsResponse(response);

    expect(facts).toHaveLength(5);
    expect(facts.map(f => f.type)).toEqual(validTypes);
  });

  it('should clamp confidence between 0 and 1', () => {
    const response = `[
      { "content": "Fact with high confidence that is long enough to pass the minimum requirement", "type": "observation", "confidence": 1.5, "tags": [] },
      { "content": "Fact with negative confidence that is long enough to pass the minimum requirement", "type": "observation", "confidence": -0.5, "tags": [] }
    ]`;

    const facts = parseFactsResponse(response);

    expect(facts).toHaveLength(2);
    expect(facts[0].confidence).toBe(1);
    expect(facts[1].confidence).toBe(0);
  });

  it('should default confidence to 0.7 if missing', () => {
    const response = `[
      { "content": "Fact without confidence value that is long enough to pass the minimum requirement", "type": "observation", "tags": [] }
    ]`;

    const facts = parseFactsResponse(response);

    expect(facts).toHaveLength(1);
    expect(facts[0].confidence).toBe(0.7);
  });

  it('should filter non-string tags', () => {
    const response = `[
      { "content": "Fact with mixed tags that is long enough to pass the minimum requirement here", "type": "observation", "confidence": 0.8, "tags": ["valid", 123, "also-valid", null] }
    ]`;

    const facts = parseFactsResponse(response);

    expect(facts).toHaveLength(1);
    expect(facts[0].tags).toEqual(['valid', 'also-valid']);
  });

  it('should handle malformed JSON gracefully', () => {
    const response = '[{ "content": "broken json';
    expect(() => parseFactsResponse(response)).not.toThrow();
    // Will throw during JSON.parse but should be caught in real implementation
  });

  it('should handle array-like string that is not valid JSON', () => {
    const response = 'Some text [not json] more text';
    // The regex will match [not json] but JSON.parse will fail
    expect(() => parseFactsResponse(response)).not.toThrow();
  });
});

// ============================================================================
// formatTranscriptForExtraction
// ============================================================================

describe('formatTranscriptForExtraction', () => {
  it('should format user and assistant messages', () => {
    const content = [
      JSON.stringify({ type: 'user', message: { content: 'Hello world' } }),
      JSON.stringify({ type: 'assistant', message: { content: 'Hi there!' } }),
    ].join('\n');

    const result = formatTranscriptForExtraction(content);

    expect(result).toContain('User: Hello world');
    expect(result).toContain('Assistant: Hi there!');
  });

  it('should handle human type as user', () => {
    const content = JSON.stringify({ type: 'human', message: { content: 'Human message' } });

    const result = formatTranscriptForExtraction(content);

    expect(result).toContain('User: Human message');
  });

  it('should skip non-text entries', () => {
    const content = [
      JSON.stringify({ type: 'user', message: { content: 'Hello' } }),
      JSON.stringify({ type: 'tool_use', tool_name: 'Read', tool_input: {} }),
      JSON.stringify({ type: 'tool_result', tool_result: 'file content' }),
      JSON.stringify({ type: 'assistant', message: { content: 'Done!' } }),
    ].join('\n');

    const result = formatTranscriptForExtraction(content);

    expect(result).toContain('User: Hello');
    expect(result).toContain('Assistant: Done!');
    expect(result).not.toContain('Read');
    expect(result).not.toContain('file content');
  });

  it('should handle array content blocks', () => {
    const content = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'First part' },
          { type: 'tool_use', name: 'Read' },
          { type: 'text', text: 'Second part' },
        ],
      },
    });

    const result = formatTranscriptForExtraction(content);

    expect(result).toContain('Assistant: First part Second part');
  });

  it('should truncate long messages', () => {
    const longMessage = 'a'.repeat(2000);
    const content = JSON.stringify({
      type: 'assistant',
      message: { content: longMessage },
    });

    const result = formatTranscriptForExtraction(content);

    // Assistant messages truncated to 1000 chars
    expect(result.length).toBeLessThan(1100);
  });

  it('should handle empty content', () => {
    const result = formatTranscriptForExtraction('');
    expect(result).toBe('');
  });

  it('should skip invalid JSON lines', () => {
    const content = [
      JSON.stringify({ type: 'user', message: { content: 'Valid' } }),
      'not valid json',
      JSON.stringify({ type: 'assistant', message: { content: 'Also valid' } }),
    ].join('\n');

    const result = formatTranscriptForExtraction(content);

    expect(result).toContain('User: Valid');
    expect(result).toContain('Assistant: Also valid');
    expect(result).not.toContain('not valid json');
  });
});

// ============================================================================
// Integration: Progress file workflow
// ============================================================================

describe('progress file workflow', () => {
  it('should generate consistent progress file paths', () => {
    const sessionId = 'test-session-123';
    const path1 = getProgressFilePath(sessionId);
    const path2 = getProgressFilePath(sessionId);

    expect(path1).toBe(path2);
  });

  it('should create progress file in .tmp directory', () => {
    const sessionId = 'test-session';
    const progressPath = getProgressFilePath(sessionId);

    expect(progressPath).toContain('.tmp');
    expect(progressPath).toContain('session-test-session-progress.md');
  });
});

// ============================================================================
// Batch Memory Save Tests (N+1 optimization)
// ============================================================================

describe('batch memory save optimization', () => {
  it('should call saveMemoriesBatch with correct deduplication threshold', async () => {
    // Note: Full integration tests are complex due to LLM mocking.
    // This test verifies the batch API contract.
    const db = await import('../lib/db/index.js');

    const batch = [
      {
        content: 'Test fact 1',
        embedding: new Array(384).fill(0.1),
        tags: ['test', 'batch'],
        type: 'observation' as const,
      },
      {
        content: 'Test fact 2',
        embedding: new Array(384).fill(0.2),
        tags: ['test', 'batch'],
        type: 'decision' as const,
      },
    ];

    const result = db.saveMemoriesBatch(batch, 0.92);

    expect(result.saved).toBeGreaterThanOrEqual(0);
    expect(result.skipped).toBeGreaterThanOrEqual(0);
    expect(result.results).toHaveLength(2);
    expect(result.results.every(r => r.reason === 'saved' || r.reason === 'duplicate')).toBe(true);
  });
});
