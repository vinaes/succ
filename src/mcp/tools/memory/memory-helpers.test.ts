import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/storage/index.js', () => ({
  saveMemory: vi.fn(async () => ({ id: 5, isDuplicate: false })),
  saveMemoriesBatch: vi.fn(async () => ({ saved: 0, skipped: 0, results: [] })),
  saveGlobalMemory: vi.fn(async () => ({ id: 9, isDuplicate: false })),
  closeDb: vi.fn(),
  closeGlobalDb: vi.fn(),
  getStorageDispatcher: vi.fn(async () => ({ flushSessionCounters: vi.fn() })),
}));

vi.mock('../../../lib/config.js', () => ({
  getErrorReportingConfig: vi.fn().mockReturnValue({ enabled: false }),
  getConfig: vi.fn(() => ({})),
  getProjectRoot: vi.fn(() => '/tmp/test-project'),
  getIdleReflectionConfig: vi.fn(() => ({ agent_model: 'haiku' })),
  getErrorReportingConfig: vi.fn().mockReturnValue({ enabled: false }),
}));

vi.mock('../../../lib/embeddings.js', () => ({
  getEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
}));

vi.mock('../../../lib/quality.js', () => ({
  scoreMemory: vi.fn(async () => ({ score: 0.9, factors: { clarity: 0.9 } })),
  passesQualityThreshold: vi.fn(() => true),
  formatQualityScore: vi.fn(() => 'Quality: 0.90'),
}));

vi.mock('../../../lib/sensitive-filter.js', () => ({
  scanSensitive: vi.fn(() => ({ hasSensitive: false, matches: [], redactedText: '' })),
  formatMatches: vi.fn(() => 'api-key'),
}));

vi.mock('../../../lib/temporal.js', () => ({
  parseDuration: vi.fn(() => new Date('2026-02-22T00:00:00.000Z')),
}));

vi.mock('../../../lib/session-summary.js', () => ({
  extractFactsWithLLM: vi.fn(async () => []),
}));

import { saveMemory } from '../../../lib/storage/index.js';
import { extractFactsWithLLM } from '../../../lib/session-summary.js';
import { scanSensitive } from '../../../lib/sensitive-filter.js';
import { rememberWithLLMExtraction, saveSingleMemory } from './memory-helpers.js';

describe('memory-helpers', () => {
  const baseConfig = {
    sensitive_filter_enabled: true,
    sensitive_auto_redact: false,
    quality_scoring_enabled: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blocks saveSingleMemory when sensitive data is detected and auto-redact is off', async () => {
    vi.mocked(scanSensitive).mockReturnValueOnce({
      hasSensitive: true,
      matches: [{ kind: 'api_key' }] as unknown as any[],
      redactedText: '[REDACTED]',
    });

    const result = await saveSingleMemory({
      content: 'token=sk-secret',
      tags: [],
      type: 'observation',
      useGlobal: false,
      config: baseConfig as any,
    });

    expect(result.content[0].text).toContain('Sensitive information detected');
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('saves local memory in saveSingleMemory happy path', async () => {
    const result = await saveSingleMemory({
      content: 'Use feature flag rollout for migration',
      tags: ['decision'],
      source: 'unit-test',
      type: 'decision',
      useGlobal: false,
      config: baseConfig as any,
    });

    expect(saveMemory).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('Remembered (id: 5)');
  });

  it('falls back to saveSingleMemory when LLM extraction fails', async () => {
    vi.mocked(extractFactsWithLLM).mockRejectedValueOnce(new Error('LLM unavailable'));

    const result = await rememberWithLLMExtraction({
      content: 'Auth endpoint returns 401 without token',
      tags: ['auth'],
      source: 'unit-test',
      type: 'learning',
      useGlobal: false,
      config: baseConfig as any,
    });

    expect(result.content[0].text).toContain('LLM extraction failed: LLM unavailable');
    expect(saveMemory).toHaveBeenCalledTimes(1);
  });
});
