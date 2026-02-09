/**
 * Tests for web search MCP tools (succ_quick_search, succ_web_search, succ_deep_research)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// ============================================================================
// Mocks
// ============================================================================

const mockSearchResponse = {
  content: 'TypeScript 5.8 introduced enhanced return type checking.',
  citations: ['https://devblogs.microsoft.com/typescript/5.8/', 'https://example.com/ts'],
  search_results: [
    { title: 'TypeScript 5.8 Blog', url: 'https://devblogs.microsoft.com/typescript/5.8/' },
    { url: 'https://example.com/ts' },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
};

const mockDeepResearchResponse = {
  content: 'Comprehensive analysis of React vs Vue...',
  citations: ['https://react.dev', 'https://vuejs.org'],
  search_results: [
    { title: 'React', url: 'https://react.dev' },
    { title: 'Vue.js', url: 'https://vuejs.org' },
  ],
  usage: { prompt_tokens: 500, completion_tokens: 2000, total_tokens: 2500 },
  reasoning: 'I should compare rendering performance first...',
};

vi.mock('../../lib/llm.js', () => ({
  isOpenRouterConfigured: vi.fn(() => true),
  callOpenRouterSearch: vi.fn(async () => ({ ...mockSearchResponse })),
  getOpenRouterApiKey: vi.fn(() => 'sk-or-test'),
}));

vi.mock('../../lib/config.js', () => ({
  getWebSearchConfig: vi.fn(() => ({
    enabled: true,
    model: 'perplexity/sonar-pro',
    deep_research_model: 'perplexity/sonar-deep-research',
    max_tokens: 4000,
    deep_research_max_tokens: 8000,
    timeout_ms: 30000,
    deep_research_timeout_ms: 120000,
    temperature: 0.1,
    save_to_memory: false,
    daily_budget_usd: 0,
    quick_search_model: 'perplexity/sonar',
    quick_search_max_tokens: 2000,
    quick_search_timeout_ms: 15000,
  })),
  getSuccDir: vi.fn(() => '/tmp/test-succ'),
  getProjectRoot: vi.fn(() => '/test/project'),
}));

vi.mock('../helpers.js', () => ({
  projectPathParam: {} as any,
  applyProjectPath: vi.fn(async () => {}),
  createToolResponse: (text: string) => ({
    content: [{ type: 'text' as const, text }],
  }),
  createErrorResponse: (text: string) => ({
    content: [{ type: 'text' as const, text }],
    isError: true,
  }),
}));

vi.mock('../../lib/embeddings.js', () => ({
  getEmbedding: vi.fn(async () => new Float32Array(384).fill(0.1)),
}));

vi.mock('../../lib/storage/index.js', () => ({
  saveMemory: vi.fn(async () => ({ id: 42, isDuplicate: false })),
}));

// ============================================================================
// Imports after mocks
// ============================================================================

import { registerWebSearchTools } from './web-search.js';
import { isOpenRouterConfigured, callOpenRouterSearch } from '../../lib/llm.js';
import { getWebSearchConfig } from '../../lib/config.js';
import { saveMemory } from '../../lib/storage/index.js';

// ============================================================================
// Mock McpServer
// ============================================================================

type ToolHandler = (args: any) => Promise<any>;

function createMockServer() {
  const toolHandlers = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn((name: string, _desc: string, _schema: any, handler: ToolHandler) => {
      toolHandlers.set(name, handler);
    }),
  };
  return { server, toolHandlers };
}

// ============================================================================
// Tests
// ============================================================================

describe('Web Search MCP Tools', () => {
  let toolHandlers: Map<string, ToolHandler>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Restore default mock implementations after clearAllMocks
    vi.mocked(isOpenRouterConfigured).mockReturnValue(true);
    vi.mocked(callOpenRouterSearch).mockResolvedValue({ ...mockSearchResponse });
    vi.mocked(getWebSearchConfig).mockReturnValue({
      enabled: true,
      quick_search_model: 'perplexity/sonar',
      quick_search_max_tokens: 2000,
      quick_search_timeout_ms: 15000,
      model: 'perplexity/sonar-pro',
      deep_research_model: 'perplexity/sonar-deep-research',
      max_tokens: 4000,
      deep_research_max_tokens: 8000,
      timeout_ms: 30000,
      deep_research_timeout_ms: 120000,
      temperature: 0.1,
      save_to_memory: false,
      daily_budget_usd: 0,
    });
    vi.mocked(saveMemory).mockResolvedValue({ id: 42, isDuplicate: false });

    // Reset fs mock state
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT'); });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    const mock = createMockServer();
    toolHandlers = mock.toolHandlers;
    registerWebSearchTools(mock.server as any);
  });

  // --------------------------------------------------------------------------
  // Tool Registration
  // --------------------------------------------------------------------------

  describe('registration', () => {
    it('should register all three tools', () => {
      expect(toolHandlers.has('succ_quick_search')).toBe(true);
      expect(toolHandlers.has('succ_web_search')).toBe(true);
      expect(toolHandlers.has('succ_deep_research')).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // succ_quick_search
  // --------------------------------------------------------------------------

  describe('succ_quick_search', () => {
    it('should use sonar model with quick settings', async () => {
      const handler = toolHandlers.get('succ_quick_search')!;
      await handler({ query: 'latest Node.js LTS version' });

      expect(callOpenRouterSearch).toHaveBeenCalledWith(
        [{ role: 'user', content: 'latest Node.js LTS version' }],
        'perplexity/sonar',
        15000,
        2000,
        0.1,
      );
    });

    it('should return formatted results with citations', async () => {
      const handler = toolHandlers.get('succ_quick_search')!;
      const result = await handler({ query: 'test' });

      expect(result.content[0].text).toContain('TypeScript 5.8 introduced');
      expect(result.content[0].text).toContain('**Sources:**');
    });

    it('should handle API errors gracefully', async () => {
      vi.mocked(callOpenRouterSearch).mockRejectedValueOnce(new Error('network error'));

      const handler = toolHandlers.get('succ_quick_search')!;
      const result = await handler({ query: 'test' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Quick search failed: network error');
    });

    it('should error when OpenRouter not configured', async () => {
      vi.mocked(isOpenRouterConfigured).mockReturnValueOnce(false);

      const handler = toolHandlers.get('succ_quick_search')!;
      const result = await handler({ query: 'test' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('API key not configured');
    });

    it('should save to memory as observation type', async () => {
      const handler = toolHandlers.get('succ_quick_search')!;
      await handler({ query: 'test query', save_to_memory: true });

      expect(saveMemory).toHaveBeenCalledWith(
        expect.stringContaining('Web search: "test query"'),
        expect.any(Float32Array),
        ['web-search', 'auto-saved'],
        'succ_quick_search',
        { type: 'observation' },
      );
    });

    it('should include system prompt when provided', async () => {
      const handler = toolHandlers.get('succ_quick_search')!;
      await handler({ query: 'test', system_prompt: 'Answer briefly' });

      expect(callOpenRouterSearch).toHaveBeenCalledWith(
        [
          { role: 'system', content: 'Answer briefly' },
          { role: 'user', content: 'test' },
        ],
        expect.any(String),
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
      );
    });
  });

  // --------------------------------------------------------------------------
  // succ_web_search
  // --------------------------------------------------------------------------

  describe('succ_web_search', () => {
    it('should return formatted search results with citations', async () => {
      const handler = toolHandlers.get('succ_web_search')!;
      const result = await handler({ query: 'TypeScript 5.8 features' });

      expect(callOpenRouterSearch).toHaveBeenCalledWith(
        [{ role: 'user', content: 'TypeScript 5.8 features' }],
        'perplexity/sonar-pro',
        30000,
        4000,
        0.1,
      );
      expect(result.content[0].text).toContain('TypeScript 5.8 introduced');
      expect(result.content[0].text).toContain('**Sources:**');
      expect(result.content[0].text).toContain('[1]');
      expect(result.content[0].text).toContain('devblogs.microsoft.com');
    });

    it('should include system prompt when provided', async () => {
      const handler = toolHandlers.get('succ_web_search')!;
      await handler({ query: 'test', system_prompt: 'Be concise' });

      expect(callOpenRouterSearch).toHaveBeenCalledWith(
        [
          { role: 'system', content: 'Be concise' },
          { role: 'user', content: 'test' },
        ],
        expect.any(String),
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('should use custom model when provided', async () => {
      const handler = toolHandlers.get('succ_web_search')!;
      await handler({ query: 'test', model: 'perplexity/sonar' });

      expect(callOpenRouterSearch).toHaveBeenCalledWith(
        expect.any(Array),
        'perplexity/sonar',
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('should show usage and cost info', async () => {
      const handler = toolHandlers.get('succ_web_search')!;
      const result = await handler({ query: 'test' });

      expect(result.content[0].text).toContain('Tokens:');
      expect(result.content[0].text).toContain('Cost:');
    });

    it('should error when OpenRouter not configured', async () => {
      vi.mocked(isOpenRouterConfigured).mockReturnValueOnce(false);

      const handler = toolHandlers.get('succ_web_search')!;
      const result = await handler({ query: 'test' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('API key not configured');
    });

    it('should error when web search disabled', async () => {
      vi.mocked(getWebSearchConfig).mockReturnValueOnce({
        enabled: false,
        quick_search_model: 'perplexity/sonar',
        quick_search_max_tokens: 2000,
        quick_search_timeout_ms: 15000,
        model: 'perplexity/sonar-pro',
        deep_research_model: 'perplexity/sonar-deep-research',
        max_tokens: 4000,
        deep_research_max_tokens: 8000,
        timeout_ms: 30000,
        deep_research_timeout_ms: 120000,
        temperature: 0.1,
        save_to_memory: false,
        daily_budget_usd: 0,
      });

      const handler = toolHandlers.get('succ_web_search')!;
      const result = await handler({ query: 'test' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('disabled');
    });

    it('should handle API errors gracefully', async () => {
      vi.mocked(callOpenRouterSearch).mockRejectedValueOnce(new Error('timeout'));

      const handler = toolHandlers.get('succ_web_search')!;
      const result = await handler({ query: 'test' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Web search failed: timeout');
    });

    it('should format citations with hostname fallback', async () => {
      vi.mocked(callOpenRouterSearch).mockResolvedValueOnce({
        content: 'Answer',
        citations: ['https://docs.example.com/guide'],
        search_results: [],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });

      const handler = toolHandlers.get('succ_web_search')!;
      const result = await handler({ query: 'test' });

      // Falls back to hostname when no title in search_results
      expect(result.content[0].text).toContain('docs.example.com');
    });
  });

  // --------------------------------------------------------------------------
  // succ_deep_research
  // --------------------------------------------------------------------------

  describe('succ_deep_research', () => {
    beforeEach(() => {
      vi.mocked(callOpenRouterSearch).mockResolvedValue({ ...mockDeepResearchResponse });
    });

    it('should use deep research model and timeout', async () => {
      const handler = toolHandlers.get('succ_deep_research')!;
      await handler({ query: 'React vs Vue' });

      expect(callOpenRouterSearch).toHaveBeenCalledWith(
        [{ role: 'user', content: 'React vs Vue' }],
        'perplexity/sonar-deep-research',
        120000,
        8000,
        0.1,
      );
    });

    it('should include reasoning when requested', async () => {
      const handler = toolHandlers.get('succ_deep_research')!;
      const result = await handler({ query: 'React vs Vue', include_reasoning: true });

      expect(result.content[0].text).toContain('**Reasoning Process:**');
      expect(result.content[0].text).toContain('compare rendering performance');
    });

    it('should not include reasoning by default', async () => {
      const handler = toolHandlers.get('succ_deep_research')!;
      const result = await handler({ query: 'React vs Vue' });

      expect(result.content[0].text).not.toContain('**Reasoning Process:**');
    });

    it('should show citations', async () => {
      const handler = toolHandlers.get('succ_deep_research')!;
      const result = await handler({ query: 'React vs Vue' });

      expect(result.content[0].text).toContain('react.dev');
      expect(result.content[0].text).toContain('vuejs.org');
    });
  });

  // --------------------------------------------------------------------------
  // Budget Tracking
  // --------------------------------------------------------------------------

  describe('budget tracking', () => {
    it('should block when daily budget exceeded', async () => {
      vi.mocked(getWebSearchConfig).mockReturnValue({
        enabled: true,
        quick_search_model: 'perplexity/sonar',
        quick_search_max_tokens: 2000,
        quick_search_timeout_ms: 15000,
        model: 'perplexity/sonar-pro',
        deep_research_model: 'perplexity/sonar-deep-research',
        max_tokens: 4000,
        deep_research_max_tokens: 8000,
        timeout_ms: 30000,
        deep_research_timeout_ms: 120000,
        temperature: 0.1,
        save_to_memory: false,
        daily_budget_usd: 0.01,
      });

      // Simulate existing spend file with exceeded budget
      vi.mocked(fs.readFileSync).mockReturnValueOnce(
        JSON.stringify({ total_usd: 0.05, requests: [] }),
      );

      const handler = toolHandlers.get('succ_web_search')!;
      const result = await handler({ query: 'test' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('budget exceeded');
    });

    it('should show budget info when budget is set', async () => {
      vi.mocked(getWebSearchConfig).mockReturnValueOnce({
        enabled: true,
        quick_search_model: 'perplexity/sonar',
        quick_search_max_tokens: 2000,
        quick_search_timeout_ms: 15000,
        model: 'perplexity/sonar-pro',
        deep_research_model: 'perplexity/sonar-deep-research',
        max_tokens: 4000,
        deep_research_max_tokens: 8000,
        timeout_ms: 30000,
        deep_research_timeout_ms: 120000,
        temperature: 0.1,
        save_to_memory: false,
        daily_budget_usd: 1.0,
      });

      const handler = toolHandlers.get('succ_web_search')!;
      const result = await handler({ query: 'test' });

      expect(result.content[0].text).toContain('Budget:');
    });

    it('should record spend after successful search', async () => {
      const handler = toolHandlers.get('succ_web_search')!;
      await handler({ query: 'test query' });

      expect(fs.writeFileSync).toHaveBeenCalled();
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const data = JSON.parse(writeCall[1] as string);
      expect(data.total_usd).toBeGreaterThan(0);
      expect(data.requests).toHaveLength(1);
      expect(data.requests[0].query).toBe('test query');
    });

    it('should allow unlimited when budget is 0', async () => {
      const handler = toolHandlers.get('succ_web_search')!;
      const result = await handler({ query: 'test' });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).not.toContain('Budget:');
    });
  });

  // --------------------------------------------------------------------------
  // Save to Memory
  // --------------------------------------------------------------------------

  describe('save to memory', () => {
    it('should save to memory when save_to_memory=true', async () => {
      const handler = toolHandlers.get('succ_web_search')!;
      const result = await handler({ query: 'test query', save_to_memory: true });

      expect(saveMemory).toHaveBeenCalledWith(
        expect.stringContaining('Web search: "test query"'),
        expect.any(Float32Array),
        ['web-search', 'auto-saved'],
        'succ_web_search',
        { type: 'observation' },
      );
      expect(result.content[0].text).toContain('Saved to memory');
    });

    it('should not save to memory by default', async () => {
      const handler = toolHandlers.get('succ_web_search')!;
      await handler({ query: 'test query' });

      expect(saveMemory).not.toHaveBeenCalled();
    });

    it('should save deep research as learning type', async () => {
      vi.mocked(callOpenRouterSearch).mockResolvedValueOnce({ ...mockDeepResearchResponse });

      const handler = toolHandlers.get('succ_deep_research')!;
      await handler({ query: 'React vs Vue', save_to_memory: true });

      expect(saveMemory).toHaveBeenCalledWith(
        expect.stringContaining('Web search: "React vs Vue"'),
        expect.any(Float32Array),
        ['deep-research', 'auto-saved'],
        'succ_deep_research',
        { type: 'learning' },
      );
    });

    it('should include citations in saved memory', async () => {
      vi.mocked(callOpenRouterSearch).mockResolvedValueOnce({ ...mockSearchResponse });

      const handler = toolHandlers.get('succ_web_search')!;
      await handler({ query: 'test', save_to_memory: true });

      const savedContent = vi.mocked(saveMemory).mock.calls[0][0] as string;
      expect(savedContent).toContain('Sources:');
      expect(savedContent).toContain('devblogs.microsoft.com');
    });

    it('should use config default for save_to_memory', async () => {
      vi.mocked(getWebSearchConfig).mockReturnValue({
        enabled: true,
        quick_search_model: 'perplexity/sonar',
        quick_search_max_tokens: 2000,
        quick_search_timeout_ms: 15000,
        model: 'perplexity/sonar-pro',
        deep_research_model: 'perplexity/sonar-deep-research',
        max_tokens: 4000,
        deep_research_max_tokens: 8000,
        timeout_ms: 30000,
        deep_research_timeout_ms: 120000,
        temperature: 0.1,
        save_to_memory: true,
        daily_budget_usd: 0,
      });

      const handler = toolHandlers.get('succ_web_search')!;
      await handler({ query: 'test' });

      expect(saveMemory).toHaveBeenCalled();
    });

    it('should handle duplicate detection', async () => {
      vi.mocked(saveMemory).mockResolvedValueOnce({ id: 42, isDuplicate: true, existingId: 10, similarity: 0.95 });

      const handler = toolHandlers.get('succ_web_search')!;
      const result = await handler({ query: 'test', save_to_memory: true });

      expect(result.content[0].text).toContain('already in memory');
    });
  });
});
