/**
 * Tests for cross-encoder reranker
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing reranker
vi.mock('./config.js', () => ({
  getErrorReportingConfig: vi.fn().mockReturnValue({ enabled: false }),
  getConfig: vi.fn(() => ({
    llm: {
      reranker: {
        enabled: true,
        weight: 0.7,
        min_results: 3,
        max_doc_chars: 1000,
      },
    },
  })),
  getConfigWithOverride: vi.fn(),
  getLLMTaskConfig: vi.fn(),
  LOCAL_MODEL: 'Xenova/bge-small-en-v1.5',
  getErrorReportingConfig: vi.fn().mockReturnValue({ enabled: false }),
}));

// Mock ONNX and tokenizer to avoid loading real models in tests
vi.mock('onnxruntime-node', () => ({
  InferenceSession: {
    create: vi.fn(),
  },
  Tensor: vi.fn(),
}));

vi.mock('./ort-session.js', () => ({
  resolveModelPath: vi.fn().mockResolvedValue('/mock/model.onnx'),
}));

vi.mock('./ort-provider.js', () => ({
  detectExecutionProvider: vi.fn().mockReturnValue({ provider: 'cpu', fallbackChain: ['cpu'] }),
}));

vi.mock('./fault-logger.js', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import type { HybridSearchResult } from './storage/types.js';

describe('reranker', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  describe('rerank', () => {
    it('should return empty array for empty input', async () => {
      const { rerank } = await import('./reranker.js');
      const result = await rerank('test query', []);
      expect(result).toEqual([]);
    });

    it('should return single result unchanged', async () => {
      const { rerank } = await import('./reranker.js');
      const input: HybridSearchResult[] = [
        {
          file_path: 'test.ts',
          content: 'test content',
          start_line: 1,
          end_line: 10,
          similarity: 0.9,
        },
      ];
      const result = await rerank('test', input);
      expect(result).toEqual(input);
    });

    it('should return results unchanged when min_results not met', async () => {
      const { rerank } = await import('./reranker.js');
      const input: HybridSearchResult[] = [
        { file_path: 'a.ts', content: 'a', start_line: 1, end_line: 1, similarity: 0.9 },
        { file_path: 'b.ts', content: 'b', start_line: 1, end_line: 1, similarity: 0.8 },
      ];
      const result = await rerank('test', input);
      expect(result).toEqual(input);
    });

    it('should rerank results when model loads successfully', async () => {
      // Mock a successful cross-encoder session with fresh module state
      vi.resetModules();

      const seqLen = 4;
      const batchSize = 3;

      vi.doMock('./config.js', () => ({
        getConfig: vi.fn(() => ({
          llm: {
            reranker: {
              enabled: true,
              weight: 0.7,
              min_results: 3,
              max_doc_chars: 1000,
            },
          },
          gpu_enabled: false,
        })),
      }));

      // Mock the tokenizer — must return arrays matching scoreBatch expectations:
      // encoded.input_ids[0].length is used for seqLen when no .dims property
      const mockTokenizer = () => ({
        input_ids: Array.from({ length: batchSize }, () =>
          Array.from({ length: seqLen }, (_, i) => i)
        ),
        attention_mask: Array.from({ length: batchSize }, () =>
          Array.from({ length: seqLen }, () => 1)
        ),
        token_type_ids: Array.from({ length: batchSize }, () =>
          Array.from({ length: seqLen }, () => 0)
        ),
      });

      vi.doMock('@huggingface/transformers', () => ({
        AutoTokenizer: {
          from_pretrained: vi.fn().mockResolvedValue(mockTokenizer),
        },
      }));

      // Mock session that returns scores: third doc most relevant
      const mockSession = {
        inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
        outputNames: ['logits'],
        run: vi.fn().mockResolvedValue({
          logits: { data: new Float32Array([-1.0, 0.0, 2.0]) },
        }),
        release: vi.fn(),
      };

      vi.doMock('onnxruntime-node', () => {
        class MockTensor {
          type: string;
          data: any;
          dims: any;
          constructor(type: string, data: any, dims: any) {
            this.type = type;
            this.data = data;
            this.dims = dims;
          }
        }
        return {
          InferenceSession: {
            create: vi.fn().mockResolvedValue(mockSession),
          },
          Tensor: MockTensor,
        };
      });
      vi.doMock('./ort-session.js', () => ({
        resolveModelPath: vi.fn().mockResolvedValue('/mock/model.onnx'),
      }));
      vi.doMock('./ort-provider.js', () => ({
        detectExecutionProvider: vi
          .fn()
          .mockReturnValue({ provider: 'cpu', fallbackChain: ['cpu'] }),
      }));
      vi.doMock('./fault-logger.js', () => ({
        logInfo: vi.fn(),
        logWarn: vi.fn(),
      }));

      const { rerank: rerankSuccess } = await import('./reranker.js');

      const input: HybridSearchResult[] = [
        {
          file_path: 'a.ts',
          content: 'least relevant',
          start_line: 1,
          end_line: 1,
          similarity: 0.9,
        },
        { file_path: 'b.ts', content: 'mid relevant', start_line: 1, end_line: 1, similarity: 0.8 },
        {
          file_path: 'c.ts',
          content: 'most relevant',
          start_line: 1,
          end_line: 1,
          similarity: 0.7,
        },
      ];

      const result = await rerankSuccess('test query', input);

      // Should have same number of results
      expect(result).toHaveLength(3);
      // Third doc got highest cross-encoder score (2.0 → sigmoid ~0.88)
      // Blended: c = 0.7*0.88 + 0.3*0.7 = 0.826
      //          a = 0.7*0.27 + 0.3*0.9 = 0.459
      //          b = 0.7*0.5  + 0.3*0.8 = 0.590
      // So c should be first
      expect(result[0].file_path).toBe('c.ts');
    });

    it('should return original results on reranker failure (graceful degradation)', async () => {
      // Force initialization failure by mocking InferenceSession.create to throw
      const ort = await import('onnxruntime-node');
      vi.mocked(ort.InferenceSession.create).mockRejectedValue(new Error('Model not found'));

      // Re-import to get fresh module state
      vi.resetModules();
      vi.doMock('./config.js', () => ({
        getConfig: vi.fn(() => ({
          llm: {
            reranker: {
              enabled: true,
              weight: 0.7,
              min_results: 2,
            },
          },
        })),
      }));
      vi.doMock('onnxruntime-node', () => ({
        InferenceSession: {
          create: vi.fn().mockRejectedValue(new Error('Model not found')),
        },
        Tensor: vi.fn(),
      }));
      vi.doMock('./ort-session.js', () => ({
        resolveModelPath: vi.fn().mockResolvedValue('/mock/model.onnx'),
      }));
      vi.doMock('./ort-provider.js', () => ({
        detectExecutionProvider: vi
          .fn()
          .mockReturnValue({ provider: 'cpu', fallbackChain: ['cpu'] }),
      }));
      vi.doMock('./fault-logger.js', () => ({
        logInfo: vi.fn(),
        logWarn: vi.fn(),
      }));

      const { rerank: rerankFresh } = await import('./reranker.js');

      const input: HybridSearchResult[] = [
        { file_path: 'a.ts', content: 'first', start_line: 1, end_line: 1, similarity: 0.9 },
        { file_path: 'b.ts', content: 'second', start_line: 1, end_line: 1, similarity: 0.8 },
        { file_path: 'c.ts', content: 'third', start_line: 1, end_line: 1, similarity: 0.7 },
      ];

      const result = await rerankFresh('test', input);
      // Should return original results on failure
      expect(result).toEqual(input);
    });
  });

  describe('isRerankerEnabled', () => {
    it('should return true by default', async () => {
      const { isRerankerEnabled } = await import('./reranker.js');
      expect(isRerankerEnabled()).toBe(true);
    });
  });

  describe('cleanupReranker', () => {
    it('should cleanup without errors', async () => {
      const { cleanupReranker } = await import('./reranker.js');
      await expect(cleanupReranker()).resolves.toBeUndefined();
    });
  });
});
