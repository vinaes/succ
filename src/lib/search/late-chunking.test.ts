/**
 * Tests for late chunking
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies to avoid loading real models
vi.mock('../config.js', () => ({
  getConfig: vi.fn(() => ({ chunk_size: 500, chunk_overlap: 50 })),
  getConfigWithOverride: vi.fn(() => ({})),
  getLLMTaskConfig: vi.fn(() => ({
    mode: 'local',
    model: 'jinaai/jina-embeddings-v2-base-code',
    api_url: 'http://localhost:11434/v1',
  })),
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

vi.mock('../config-defaults.js', () => ({
  LOCAL_MODEL: 'Xenova/all-MiniLM-L6-v2',
}));

vi.mock('../fault-logger.js', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('../embeddings.js', () => ({
  getNativeSession: vi.fn(),
  getModelMaxLength: vi.fn((model: string) => {
    const lengths: Record<string, number> = {
      'jinaai/jina-embeddings-v2-base-code': 8192,
      'Xenova/all-MiniLM-L6-v2': 128,
    };
    return lengths[model] ?? 128;
  }),
}));

vi.mock('../chunker.js', () => ({
  chunkCodeAsync: vi.fn(),
}));

import { isLateChunkingSupported, lateChunkEmbed } from './late-chunking.js';
import { getLLMTaskConfig } from '../config.js';
import { chunkCodeAsync } from '../chunker.js';
import { getNativeSession } from '../embeddings.js';

describe('late-chunking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isLateChunkingSupported', () => {
    it('should return true for long-context models', () => {
      vi.mocked(getLLMTaskConfig).mockReturnValue({
        mode: 'local',
        model: 'jinaai/jina-embeddings-v2-base-code',
        api_url: '',
        api_key: undefined,
        max_tokens: 2000,
        temperature: 0.3,
      });
      expect(isLateChunkingSupported()).toBe(true);
    });

    it('should return false for short-context models', () => {
      vi.mocked(getLLMTaskConfig).mockReturnValue({
        mode: 'local',
        model: 'Xenova/all-MiniLM-L6-v2',
        api_url: '',
        api_key: undefined,
        max_tokens: 2000,
        temperature: 0.3,
      });
      expect(isLateChunkingSupported()).toBe(false);
    });
  });

  describe('lateChunkEmbed', () => {
    it('should return fallback when model context is too short', async () => {
      vi.mocked(getLLMTaskConfig).mockReturnValue({
        mode: 'local',
        model: 'Xenova/all-MiniLM-L6-v2',
        api_url: '',
        api_key: undefined,
        max_tokens: 2000,
        temperature: 0.3,
      });

      const result = await lateChunkEmbed('const x = 1;', 'test.ts');
      expect(result.usedLateChunking).toBe(false);
      expect(result.fallbackReason).toContain('too short');
    });

    it('should return empty chunks for empty files', async () => {
      vi.mocked(getLLMTaskConfig).mockReturnValue({
        mode: 'local',
        model: 'jinaai/jina-embeddings-v2-base-code',
        api_url: '',
        api_key: undefined,
        max_tokens: 2000,
        temperature: 0.3,
      });
      vi.mocked(chunkCodeAsync).mockResolvedValue([]);

      const result = await lateChunkEmbed('', 'empty.ts');
      expect(result.usedLateChunking).toBe(true);
      expect(result.chunks).toEqual([]);
    });

    it('should generate context-aware embeddings for chunked code', async () => {
      vi.mocked(getLLMTaskConfig).mockReturnValue({
        mode: 'local',
        model: 'jinaai/jina-embeddings-v2-base-code',
        api_url: '',
        api_key: undefined,
        max_tokens: 2000,
        temperature: 0.3,
      });

      const content = 'function foo() { return 1; }\nfunction bar() { return 2; }';

      vi.mocked(chunkCodeAsync).mockResolvedValue([
        { content: 'function foo() { return 1; }', startLine: 1, endLine: 1 },
        { content: 'function bar() { return 2; }', startLine: 2, endLine: 2 },
      ]);

      // Mock session with raw embeddings
      const hiddenDim = 4;
      const seqLen = 20;
      const hiddenStates = new Float32Array(seqLen * hiddenDim);
      for (let i = 0; i < hiddenStates.length; i++) {
        hiddenStates[i] = Math.random();
      }
      const attentionMask = new Array(seqLen).fill(1);

      const mockSession = {
        getTokenOffsets: vi.fn().mockReturnValue(
          // Generate token offsets spanning the content
          Array.from({ length: seqLen }, (_, i) => {
            const charPerToken = Math.ceil(content.length / seqLen);
            return [i * charPerToken, Math.min((i + 1) * charPerToken, content.length)];
          })
        ),
        embedRaw: vi.fn().mockResolvedValue({
          hiddenStates,
          attentionMask,
          seqLen,
          hiddenDim,
        }),
      };

      vi.mocked(getNativeSession).mockResolvedValue(mockSession as any);

      const result = await lateChunkEmbed(content, 'test.ts');

      expect(result.usedLateChunking).toBe(true);
      expect(result.chunks.length).toBe(2);
      expect(result.chunks[0].embedding.length).toBe(hiddenDim);
      expect(result.chunks[1].embedding.length).toBe(hiddenDim);

      // Embeddings should be L2-normalized (magnitude ≈ 1)
      for (const chunk of result.chunks) {
        const mag = Math.sqrt(chunk.embedding.reduce((sum, v) => sum + v * v, 0));
        expect(mag).toBeCloseTo(1.0, 1);
      }

      // getTokenOffsets should have been called with the full content to map
      // chunk boundaries to token positions (the core of late chunking)
      expect(mockSession.getTokenOffsets).toHaveBeenCalledWith(content);

      // Chunks from different code spans should produce different embeddings
      const emb0 = result.chunks[0].embedding;
      const emb1 = result.chunks[1].embedding;
      const identical = emb0.every((v, i) => v === emb1[i]);
      expect(identical).toBe(false);
    });

    it('should handle embedRaw failure gracefully', async () => {
      vi.mocked(getLLMTaskConfig).mockReturnValue({
        mode: 'local',
        model: 'jinaai/jina-embeddings-v2-base-code',
        api_url: '',
        api_key: undefined,
        max_tokens: 2000,
        temperature: 0.3,
      });

      vi.mocked(chunkCodeAsync).mockResolvedValue([
        { content: 'const x = 1;', startLine: 1, endLine: 1 },
      ]);

      vi.mocked(getNativeSession).mockRejectedValue(new Error('ORT session failed'));

      const result = await lateChunkEmbed('const x = 1;', 'test.ts');
      expect(result.usedLateChunking).toBe(false);
      expect(result.fallbackReason).toContain('ORT session failed');
    });
  });
});
