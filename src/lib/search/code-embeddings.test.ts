/**
 * Tests for code-specific embeddings support (jina model + configurable max_length)
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  getErrorReportingConfig: vi.fn().mockReturnValue({ enabled: false }),
  getConfig: vi.fn(() => ({})),
  getConfigWithOverride: vi.fn(() => ({})),
  getLLMTaskConfig: vi.fn(() => ({
    mode: 'local',
    model: 'jinaai/jina-embeddings-v2-base-code',
    api_url: 'http://localhost:11434/v1',
  })),
}));

vi.mock('../fault-logger.js', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('../ort-provider.js', () => ({
  detectExecutionProvider: vi.fn().mockReturnValue({ provider: 'cpu', fallbackChain: ['cpu'] }),
}));

import { getModelDimension, getModelMaxLength } from '../embeddings.js';

describe('code-specific embeddings', () => {
  describe('getModelDimension', () => {
    it('should return 768 for jina-embeddings-v2-base-code', () => {
      expect(getModelDimension('jinaai/jina-embeddings-v2-base-code')).toBe(768);
    });

    it('should return 768 for jina-embeddings-v2-base-en', () => {
      expect(getModelDimension('jinaai/jina-embeddings-v2-base-en')).toBe(768);
    });

    it('should return 512 for jina-embeddings-v2-small-en', () => {
      expect(getModelDimension('jinaai/jina-embeddings-v2-small-en')).toBe(512);
    });

    it('should return 768 for nomic-embed-code', () => {
      expect(getModelDimension('nomic-ai/nomic-embed-code')).toBe(768);
    });

    it('should return 384 for default MiniLM model', () => {
      expect(getModelDimension('Xenova/all-MiniLM-L6-v2')).toBe(384);
    });

    it('should return undefined for unknown models', () => {
      expect(getModelDimension('unknown/model')).toBeUndefined();
    });
  });

  describe('getModelMaxLength', () => {
    it('should return 8192 for jina code model', () => {
      expect(getModelMaxLength('jinaai/jina-embeddings-v2-base-code')).toBe(8192);
    });

    it('should return 8192 for nomic-embed-code', () => {
      expect(getModelMaxLength('nomic-ai/nomic-embed-code')).toBe(8192);
    });

    it('should return 512 for BGE models', () => {
      expect(getModelMaxLength('Xenova/bge-small-en-v1.5')).toBe(512);
      expect(getModelMaxLength('Xenova/bge-base-en-v1.5')).toBe(512);
    });

    it('should return correct max length for known models', () => {
      expect(getModelMaxLength('Xenova/all-MiniLM-L6-v2')).toBe(256);
      expect(getModelMaxLength('Xenova/multilingual-e5-large')).toBe(512);
    });

    it('should return 512 for unknown models (safe default)', () => {
      expect(getModelMaxLength('unknown/model')).toBe(512);
    });
  });
});
