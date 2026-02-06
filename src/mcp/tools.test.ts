/**
 * Tests for MCP tool handlers
 *
 * Creates a mock McpServer, registers tools, then calls handlers directly.
 * Much faster than spawning a subprocess for each test.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Mocks — correct return shapes matching actual DB functions
// ============================================================================

vi.mock('../lib/db/index.js', () => ({
  hybridSearchDocs: vi.fn(() => [
    { content: 'doc result', file_path: 'test.md', similarity: 0.85, chunk_index: 0, start_line: 1, end_line: 10 },
  ]),
  hybridSearchCode: vi.fn(() => [
    { content: 'code result', file_path: 'code:test.ts', similarity: 0.8, chunk_index: 0, start_line: 1, end_line: 5 },
  ]),
  hybridSearchMemories: vi.fn(() => [
    { id: 1, content: 'memory result', tags: ['test'], similarity: 0.9, type: 'observation', created_at: new Date().toISOString() },
  ]),
  hybridSearchGlobalMemories: vi.fn(() => [
    { id: 10, content: 'global memory', tags: ['global'], similarity: 0.85, type: 'learning', created_at: new Date().toISOString() },
  ]),
  getRecentDocuments: vi.fn(() => [
    { content: 'recent doc', file_path: 'recent.md', chunk_index: 0, start_line: 1, end_line: 5 },
  ]),
  getRecentMemories: vi.fn(() => [
    { id: 1, content: 'recent memory', tags: [], type: 'observation', created_at: new Date().toISOString() },
  ]),
  getRecentGlobalMemories: vi.fn(() => []),
  saveMemory: vi.fn(() => ({ id: 1, isDuplicate: false })),
  saveGlobalMemory: vi.fn(() => ({ id: 10, isDuplicate: false })),
  searchMemories: vi.fn(() => []),
  getMemoryById: vi.fn((id: number) => ({
    id,
    content: `Memory #${id}`,
    tags: ['test'],
    type: 'observation',
    created_at: new Date().toISOString(),
  })),
  deleteMemory: vi.fn(() => true),
  deleteMemoriesOlderThan: vi.fn(() => 3),
  deleteMemoriesByTag: vi.fn(() => 2),
  createMemoryLink: vi.fn(() => ({ id: 1, created: true })),
  deleteMemoryLink: vi.fn(() => true),
  getMemoryWithLinks: vi.fn((id: number) => ({
    id,
    content: `Memory #${id}`,
    tags: ['test'],
    type: 'observation',
    created_at: new Date().toISOString(),
    outgoing_links: [],
    incoming_links: [],
  })),
  findConnectedMemories: vi.fn(() => [
    { memory: { id: 2, content: 'connected memory', tags: ['test'] }, depth: 1, path: [1, 2] },
  ]),
  autoLinkSimilarMemories: vi.fn(() => 2),
  getGraphStats: vi.fn(() => ({
    total_memories: 10, total_links: 5, avg_links_per_memory: 0.5,
    isolated_memories: 3, relations: { related: 3, caused_by: 2 },
  })),
  LINK_RELATIONS: ['related', 'caused_by', 'leads_to', 'similar_to', 'contradicts', 'implements', 'supersedes', 'references'],
  getStats: vi.fn(() => ({ total_documents: 100, total_files: 10, last_indexed: '2025-01-01' })),
  getMemoryStats: vi.fn(() => ({
    total_memories: 20,
    oldest_memory: '2024-01-01',
    newest_memory: '2025-01-01',
    by_type: { observation: 10, decision: 5, learning: 5 },
    stale_count: 2,
  })),
  getTokenStatsAggregated: vi.fn(() => []),
  getTokenStatsSummary: vi.fn(() => ({
    total_queries: 50,
    total_savings_tokens: 10000,
    total_returned_tokens: 2000,
    total_full_source_tokens: 12000,
  })),
  closeDb: vi.fn(),
  closeGlobalDb: vi.fn(),
  incrementMemoryAccessBatch: vi.fn(),
}));

vi.mock('../lib/embeddings.js', () => ({
  getEmbedding: vi.fn(async () => new Float32Array(384).fill(0.1)),
}));

vi.mock('../lib/config.js', () => ({
  isGlobalOnlyMode: vi.fn(() => false),
  getConfig: vi.fn(() => ({
    sensitive_filter_enabled: false,
    sensitive_auto_redact: false,
    quality_threshold: 0.3,
  })),
  getProjectRoot: vi.fn(() => '/test/project'),
  getSuccDir: vi.fn(() => '/test/project/.succ'),
  getDaemonStatuses: vi.fn(() => [
    { name: 'daemon', running: false, pid: null },
  ]),
  getIdleReflectionConfig: vi.fn(() => ({
    enabled: false,
    idle_minutes: 5,
    cooldown_minutes: 10,
  })),
  isProjectInitialized: vi.fn(() => true),
}));

vi.mock('../lib/quality.js', () => ({
  scoreMemory: vi.fn(async () => ({ score: 0.8, factors: { specificity: 0.8, actionability: 0.7, novelty: 0.9, clarity: 0.8 } })),
  passesQualityThreshold: vi.fn(() => true),
  formatQualityScore: vi.fn(() => 'Quality: 0.80'),
}));

vi.mock('../lib/sensitive-filter.js', () => ({
  scanSensitive: vi.fn(() => ({ hasSensitive: false, matches: [], redactedText: '' })),
  formatMatches: vi.fn(() => ''),
}));

vi.mock('../lib/temporal.js', () => ({
  parseDuration: vi.fn(() => null),
  applyTemporalScoring: vi.fn((results: any[]) => results),
  getTemporalConfig: vi.fn(() => ({ decay_rate: 0.1, boost_recent_days: 7 })),
}));

vi.mock('../lib/session-summary.js', () => ({
  extractFactsWithLLM: vi.fn(async () => ['fact 1', 'fact 2']),
}));

vi.mock('../lib/token-counter.js', () => ({
  formatTokens: vi.fn((n: number) => `${n} tokens`),
  compressionPercent: vi.fn(() => '80%'),
  countTokens: vi.fn(() => 100),
  countTokensArray: vi.fn(() => 200),
}));

vi.mock('../lib/pricing.js', () => ({
  estimateSavings: vi.fn(() => 0.001),
  getCurrentModel: vi.fn(() => 'claude-sonnet-4-5-20250929'),
}));

// ============================================================================
// Imports after mocks
// ============================================================================

import { registerSearchTools } from './tools/search.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerGraphTools } from './tools/graph.js';
import { registerStatusTools } from './tools/status.js';

import { isGlobalOnlyMode } from '../lib/config.js';
import {
  hybridSearchDocs,
  hybridSearchCode,
  hybridSearchMemories,
  getRecentDocuments,
  getRecentMemories,
  saveMemory,
  deleteMemory,
  getMemoryById,
  getMemoryWithLinks,
  autoLinkSimilarMemories,
  findConnectedMemories,
} from '../lib/db/index.js';
import { scanSensitive } from '../lib/sensitive-filter.js';

// ============================================================================
// Mock McpServer - captures tool handlers
// ============================================================================

type ToolHandler = (args: any) => Promise<any>;

function createMockServer() {
  const toolHandlers = new Map<string, ToolHandler>();

  const server = {
    tool: vi.fn((name: string, _desc: string, _schema: any, handler: ToolHandler) => {
      toolHandlers.set(name, handler);
    }),
    resource: vi.fn(),
  };

  return { server, toolHandlers };
}

// ============================================================================
// Tests
// ============================================================================

describe('MCP Tools', () => {
  let toolHandlers: Map<string, ToolHandler>;

  beforeEach(() => {
    vi.clearAllMocks();

    const mock = createMockServer();
    toolHandlers = mock.toolHandlers;

    // Register all tools
    registerSearchTools(mock.server as any);
    registerMemoryTools(mock.server as any);
    registerGraphTools(mock.server as any);
    registerStatusTools(mock.server as any);
  });

  // --------------------------------------------------------------------------
  // Search Tools
  // --------------------------------------------------------------------------

  describe('succ_search', () => {
    it('should return formatted search results', async () => {
      const handler = toolHandlers.get('succ_search')!;
      const result = await handler({ query: 'test query', limit: 5, threshold: 0.2 });

      // hybridSearchDocs is called with (query, embedding, limit, threshold)
      expect(hybridSearchDocs).toHaveBeenCalled();
      expect(result.content[0].text).toContain('doc result');
    });

    it('should return recent docs for wildcard query', async () => {
      const handler = toolHandlers.get('succ_search')!;
      const result = await handler({ query: '*', limit: 3, threshold: 0.2 });

      expect(getRecentDocuments).toHaveBeenCalledWith(3);
      expect(result.content[0].text).toContain('recent doc');
    });

    it('should return hint in global-only mode', async () => {
      vi.mocked(isGlobalOnlyMode).mockReturnValueOnce(true);

      const handler = toolHandlers.get('succ_search')!;
      const result = await handler({ query: 'test', limit: 5, threshold: 0.2 });

      expect(result.content[0].text).toContain('not initialized');
    });
  });

  describe('succ_search_code', () => {
    it('should return code search results', async () => {
      const handler = toolHandlers.get('succ_search_code')!;
      const result = await handler({ query: 'handleAuth', limit: 5, threshold: 0.25 });

      expect(hybridSearchCode).toHaveBeenCalled();
      expect(result.content[0].text).toContain('code result');
    });
  });

  // --------------------------------------------------------------------------
  // Memory Tools
  // --------------------------------------------------------------------------

  describe('succ_remember', () => {
    it('should save memory', async () => {
      const handler = toolHandlers.get('succ_remember')!;
      const result = await handler({
        content: 'Important architecture decision',
        tags: ['decision'],
        type: 'decision',
        global: false,
      });

      // Should contain success indication
      expect(result.content[0].text).toMatch(/[Ss]aved|[Mm]emory|[Ff]act/);
      expect(result.isError).toBeFalsy();
    });

    it('should block sensitive content in fallback path', async () => {
      // Make LLM extraction fail to trigger saveSingleMemory (which has sensitive check)
      const { extractFactsWithLLM } = await import('../lib/session-summary.js');
      vi.mocked(extractFactsWithLLM).mockRejectedValueOnce(new Error('LLM unavailable'));

      vi.mocked(scanSensitive).mockReturnValueOnce({
        hasSensitive: true,
        matches: [{ type: 'api_key', value: 'sk-xxx', position: 0, length: 6 }],
        redactedText: '[REDACTED]',
      } as any);

      // Enable sensitive filter for this test
      const { getConfig } = await import('../lib/config.js');
      vi.mocked(getConfig).mockReturnValue({
        sensitive_filter_enabled: true,
        sensitive_auto_redact: false,
        quality_threshold: 0.3,
      } as any);

      const handler = toolHandlers.get('succ_remember')!;
      const result = await handler({
        content: 'my api key sk-xxx',
        tags: [],
        type: 'observation',
        global: false,
      });

      // Should warn about sensitive content
      expect(result.content[0].text.toLowerCase()).toContain('sensitive');
      expect(saveMemory).not.toHaveBeenCalled();
    });
  });

  describe('succ_recall', () => {
    it('should return hybrid search results', async () => {
      const handler = toolHandlers.get('succ_recall')!;
      const result = await handler({ query: 'auth flow', limit: 5 });

      expect(hybridSearchMemories).toHaveBeenCalled();
      expect(result.content[0].text).toContain('memory result');
    });

    it('should return recent memories for wildcard query', async () => {
      const handler = toolHandlers.get('succ_recall')!;
      const result = await handler({ query: '*', limit: 3 });

      expect(getRecentMemories).toHaveBeenCalledWith(3);
    });
  });

  describe('succ_forget', () => {
    it('should delete memory by ID', async () => {
      const handler = toolHandlers.get('succ_forget')!;
      const result = await handler({ id: 42 });

      expect(getMemoryById).toHaveBeenCalledWith(42);
      expect(deleteMemory).toHaveBeenCalledWith(42);
      // Should confirm deletion
      expect(result.content[0].text).toMatch(/[Ff]orgot|[Dd]eleted|[Rr]emoved/);
    });
  });

  // --------------------------------------------------------------------------
  // Graph Tools
  // --------------------------------------------------------------------------

  describe('succ_link', () => {
    it('should create link between memories', async () => {
      const handler = toolHandlers.get('succ_link')!;
      const result = await handler({
        action: 'create',
        source_id: 1,
        target_id: 2,
        relation: 'related',
      });

      expect(result.content[0].text).toMatch(/[Cc]reated|[Ll]ink/);
    });

    it('should show memory with links', async () => {
      const handler = toolHandlers.get('succ_link')!;
      const result = await handler({
        action: 'show',
        source_id: 1,
      });

      expect(getMemoryWithLinks).toHaveBeenCalledWith(1);
      expect(result.content[0].text).toContain('Memory #1');
    });

    it('should auto-link similar memories', async () => {
      const handler = toolHandlers.get('succ_link')!;
      const result = await handler({ action: 'auto' });

      expect(autoLinkSimilarMemories).toHaveBeenCalled();
      expect(result.content[0].text).toMatch(/link|auto/i);
    });
  });

  describe('succ_explore', () => {
    it('should explore connected memories', async () => {
      const handler = toolHandlers.get('succ_explore')!;
      const result = await handler({ memory_id: 1, depth: 2 });

      expect(findConnectedMemories).toHaveBeenCalled();
      // With empty connected results, shows the memory itself
      expect(result.content[0].text).toContain('#1');
    });
  });

  // --------------------------------------------------------------------------
  // Status Tools
  // --------------------------------------------------------------------------

  describe('succ_status', () => {
    it('should return index and memory stats', async () => {
      const handler = toolHandlers.get('succ_status')!;
      const result = await handler({});

      expect(result.content[0].text).toContain('Documents');
      expect(result.content[0].text).toContain('Memories');
    });
  });

  describe('succ_stats', () => {
    it('should return token savings stats', async () => {
      const handler = toolHandlers.get('succ_stats')!;
      const result = await handler({});

      expect(result.content[0].text).toMatch(/[Tt]oken|[Ss]aving|queries/);
    });
  });
});
