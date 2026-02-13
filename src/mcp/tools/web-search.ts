/**
 * MCP Web Search tools via OpenRouter (Perplexity, Grok, and other search-capable models)
 *
 * - succ_quick_search: Fast, cheap search (default: Perplexity Sonar)
 * - succ_web_search: Quality search (default: Perplexity Sonar Pro)
 * - succ_deep_research: Multi-step deep research (default: Perplexity Sonar Deep Research)
 * - succ_web_search_history: Browse and filter past web search history
 *
 * Models are configurable via web_search.* config keys. Any OpenRouter model
 * with :online suffix supports web search (e.g., x-ai/grok-3:online).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getWebSearchConfig } from '../../lib/config.js';
import { isApiConfigured, callOpenRouterSearch, type OpenRouterSearchResponse, type ChatMessage } from '../../lib/llm.js';
import { projectPathParam, applyProjectPath } from '../helpers.js';
import { recordWebSearch, getTodayWebSearchSpend, getWebSearchHistory, getWebSearchSummary } from '../../lib/storage/index.js';
import type { WebSearchToolName } from '../../lib/storage/types.js';

// Approximate pricing per 1M tokens (USD) — OpenRouter models with web search
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Perplexity Sonar (native search)
  'perplexity/sonar': { input: 1, output: 1 },
  'perplexity/sonar-pro': { input: 3, output: 15 },
  'perplexity/sonar-pro-search': { input: 3, output: 15 },
  'perplexity/sonar-reasoning': { input: 1, output: 5 },
  'perplexity/sonar-reasoning-pro': { input: 2, output: 8 },
  'perplexity/sonar-deep-research': { input: 2, output: 8 },
  // xAI Grok (native web + X/Twitter search)
  'x-ai/grok-3': { input: 3, output: 15 },
  'x-ai/grok-3-mini': { input: 0.3, output: 0.5 },
  'x-ai/grok-3:online': { input: 5, output: 15 },
  'x-ai/grok-3-mini:online': { input: 0.3, output: 0.5 },
  // Google Gemini (:online via OpenRouter)
  'google/gemini-2.0-flash-001:online': { input: 0.1, output: 0.4 },
  'google/gemini-2.5-pro-preview:online': { input: 1.25, output: 10 },
  // OpenAI (:online via OpenRouter)
  'openai/gpt-4o:online': { input: 2.5, output: 10 },
  'openai/gpt-4o-mini:online': { input: 0.15, output: 0.6 },
};

/**
 * Estimate cost from usage and model
 */
function estimateCost(usage: OpenRouterSearchResponse['usage'], model: string): number {
  if (!usage) return 0;
  const pricing = MODEL_PRICING[model] || { input: 3, output: 15 };
  return (usage.prompt_tokens * pricing.input + usage.completion_tokens * pricing.output) / 1_000_000;
}

/**
 * Record search to database
 */
async function recordSearchToDb(
  toolName: WebSearchToolName,
  model: string,
  query: string,
  usage: OpenRouterSearchResponse['usage'],
  cost: number,
  citations: string[] | undefined,
  hasReasoning: boolean,
  responseLength: number,
): Promise<void> {
  try {
    await recordWebSearch({
      tool_name: toolName,
      model,
      query,
      prompt_tokens: usage?.prompt_tokens ?? 0,
      completion_tokens: usage?.completion_tokens ?? 0,
      estimated_cost_usd: cost,
      citations_count: citations?.length ?? 0,
      has_reasoning: hasReasoning,
      response_length_chars: responseLength,
    });
  } catch {
    // Non-critical — don't fail the search
  }
}

/**
 * Check budget and return error message if exceeded
 */
async function checkBudget(dailyBudget: number): Promise<string | null> {
  if (dailyBudget <= 0) return null;
  try {
    const spent = await getTodayWebSearchSpend();
    if (spent >= dailyBudget) {
      return `Daily web search budget exceeded ($${spent.toFixed(4)} / $${dailyBudget}). Reset tomorrow or increase with: succ_config_set key="web_search.daily_budget_usd" value="..."`;
    }
  } catch {
    // Can't check budget — allow the search
  }
  return null;
}

/**
 * Format citations from Perplexity response into readable markdown
 */
function formatCitations(
  citations?: string[],
  searchResults?: Array<{ title?: string; url: string; snippet?: string }>,
): string {
  if (!citations || citations.length === 0) return '';

  const lines: string[] = ['\n\n---\n**Sources:**'];
  for (let i = 0; i < citations.length; i++) {
    const url = citations[i];
    const result = searchResults?.find(r => r.url === url);
    let title: string;
    try {
      title = result?.title || new URL(url).hostname;
    } catch {
      title = url;
    }
    lines.push(`[${i + 1}] [${title}](${url})`);
  }
  return lines.join('\n');
}

/**
 * Format usage/cost information
 */
function formatUsage(usage: OpenRouterSearchResponse['usage'], cost: number, dailyBudget: number, todaySpent: number): string {
  if (!usage) return '';
  const parts = [
    `Tokens: ${usage.total_tokens.toLocaleString()} (prompt: ${usage.prompt_tokens.toLocaleString()}, completion: ${usage.completion_tokens.toLocaleString()})`,
    `Cost: ~$${cost.toFixed(4)}`,
  ];
  if (dailyBudget > 0) {
    parts.push(`Budget: $${todaySpent.toFixed(4)} / $${dailyBudget}`);
  }
  return `\n\n_${parts.join(' | ')}_`;
}

/**
 * Save search result to succ memory
 */
async function saveResultToMemory(
  query: string,
  content: string,
  citations: string[] | undefined,
  toolName: string,
  type: 'observation' | 'learning',
): Promise<string> {
  try {
    const { getEmbedding } = await import('../../lib/embeddings.js');
    const { saveMemory } = await import('../../lib/storage/index.js');

    const sourcesBlock = citations?.length
      ? `\n\nSources:\n${citations.map((url, i) => `[${i + 1}] ${url}`).join('\n')}`
      : '';

    const memoryContent = `Web search: "${query}"\n\n${content.slice(0, 800)}${sourcesBlock}`;
    const embedding = await getEmbedding(memoryContent);
    const result = await saveMemory(
      memoryContent,
      embedding,
      [toolName === 'succ_deep_research' ? 'deep-research' : 'web-search', 'auto-saved'],
      toolName,
      { type },
    );

    if (result.isDuplicate) {
      return '\n_Similar result already in memory._';
    }
    return `\n_Saved to memory (id: ${result.id})._`;
  } catch (err: any) {
    return `\n_Failed to save to memory: ${err.message}_`;
  }
}

export function registerWebSearchTools(server: McpServer) {

  // succ_quick_search — cheapest, fastest web search
  server.tool(
    'succ_quick_search',
    'Quick, cheap web search via OpenRouter (default: Perplexity Sonar, ~$1/MTok). Best for simple factual queries: version numbers, release dates, quick lookups. Configure model with web_search.quick_search_model. Requires OPENROUTER_API_KEY.',
    {
      query: z.string().describe('Simple factual query (e.g., "latest Node.js LTS version", "TypeScript 5.8 release date")'),
      system_prompt: z.string().optional().describe('Optional system prompt to guide response format'),
      max_tokens: z.number().optional().describe('Max response tokens (default: 2000)'),
      save_to_memory: z.boolean().optional().describe('Save result to succ memory (default: from config)'),
      project_path: projectPathParam,
    },
    async ({ query, system_prompt, max_tokens, save_to_memory, project_path }) => {
      await applyProjectPath(project_path);

      if (!isApiConfigured()) {
        return {
          content: [{ type: 'text' as const, text: 'API key not configured. Set OPENROUTER_API_KEY environment variable or run:\nsucc_config_set key="llm.api_key" value="sk-or-..."' }],
          isError: true,
        };
      }

      const wsConfig = getWebSearchConfig();
      if (!wsConfig.enabled) {
        return {
          content: [{ type: 'text' as const, text: 'Web search is disabled. Enable with: succ_config_set key="web_search.enabled" value="true"' }],
          isError: true,
        };
      }

      const budgetError = await checkBudget(wsConfig.daily_budget_usd);
      if (budgetError) return { content: [{ type: 'text' as const, text: budgetError }], isError: true };

      try {
        const messages: ChatMessage[] = [];
        if (system_prompt) {
          messages.push({ role: 'system', content: system_prompt });
        }
        messages.push({ role: 'user', content: query });

        const effectiveModel = wsConfig.quick_search_model;
        const result = await callOpenRouterSearch(
          messages,
          effectiveModel,
          wsConfig.quick_search_timeout_ms,
          max_tokens || wsConfig.quick_search_max_tokens,
          wsConfig.temperature,
        );

        const cost = estimateCost(result.usage, effectiveModel);
        await recordSearchToDb('succ_quick_search', effectiveModel, query, result.usage, cost, result.citations, false, result.content.length);

        const todaySpent = wsConfig.daily_budget_usd > 0 ? await getTodayWebSearchSpend() : 0;
        let text = result.content;
        text += formatCitations(result.citations, result.search_results);
        text += formatUsage(result.usage, cost, wsConfig.daily_budget_usd, todaySpent);

        const shouldSave = save_to_memory ?? wsConfig.save_to_memory;
        if (shouldSave) {
          text += await saveResultToMemory(query, result.content, result.citations, 'succ_quick_search', 'observation');
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: any) {
        return { content: [{ type: 'text' as const, text: `Quick search failed: ${error.message}` }], isError: true };
      }
    },
  );

  // succ_web_search — fast real-time web search
  server.tool(
    'succ_web_search',
    'Web search via OpenRouter (default: Perplexity Sonar Pro). Higher quality than succ_quick_search. Use for complex queries, documentation lookups, multi-faceted questions. Returns answers with citations. Alternatives: x-ai/grok-3:online, google/gemini-2.0-flash-001:online, or any model with :online suffix. Requires OPENROUTER_API_KEY.',
    {
      query: z.string().describe('The search query (e.g., "latest React 19 features", "how to configure nginx reverse proxy")'),
      model: z.string().optional().describe('Override search model. Default from config (perplexity/sonar-pro). Perplexity: sonar, sonar-pro, sonar-reasoning-pro. Grok: x-ai/grok-3:online, x-ai/grok-3-mini:online. Any OpenRouter model with :online suffix supports web search.'),
      system_prompt: z.string().optional().describe('Optional system prompt to guide the response format or focus'),
      max_tokens: z.number().optional().describe('Max response tokens (default: 4000)'),
      save_to_memory: z.boolean().optional().describe('Save result to succ memory (default: from config)'),
      project_path: projectPathParam,
    },
    async ({ query, model, system_prompt, max_tokens, save_to_memory, project_path }) => {
      await applyProjectPath(project_path);

      if (!isApiConfigured()) {
        return {
          content: [{ type: 'text' as const, text: 'API key not configured. Set OPENROUTER_API_KEY environment variable or run:\nsucc_config_set key="llm.api_key" value="sk-or-..."' }],
          isError: true,
        };
      }

      const wsConfig = getWebSearchConfig();
      if (!wsConfig.enabled) {
        return {
          content: [{ type: 'text' as const, text: 'Web search is disabled. Enable with: succ_config_set key="web_search.enabled" value="true"' }],
          isError: true,
        };
      }

      const budgetError = await checkBudget(wsConfig.daily_budget_usd);
      if (budgetError) return { content: [{ type: 'text' as const, text: budgetError }], isError: true };

      const effectiveModel = model || wsConfig.model;

      try {
        const messages: ChatMessage[] = [];
        if (system_prompt) {
          messages.push({ role: 'system', content: system_prompt });
        }
        messages.push({ role: 'user', content: query });

        const result = await callOpenRouterSearch(
          messages,
          effectiveModel,
          wsConfig.timeout_ms,
          max_tokens || wsConfig.max_tokens,
          wsConfig.temperature,
        );

        const cost = estimateCost(result.usage, effectiveModel);
        await recordSearchToDb('succ_web_search', effectiveModel, query, result.usage, cost, result.citations, false, result.content.length);

        const todaySpent = wsConfig.daily_budget_usd > 0 ? await getTodayWebSearchSpend() : 0;
        let text = result.content;
        text += formatCitations(result.citations, result.search_results);
        text += formatUsage(result.usage, cost, wsConfig.daily_budget_usd, todaySpent);

        const shouldSave = save_to_memory ?? wsConfig.save_to_memory;
        if (shouldSave) {
          text += await saveResultToMemory(query, result.content, result.citations, 'succ_web_search', 'observation');
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: any) {
        return { content: [{ type: 'text' as const, text: `Web search failed: ${error.message}` }], isError: true };
      }
    },
  );

  // succ_deep_research — expensive multi-step research
  server.tool(
    'succ_deep_research',
    'Deep multi-step web research via OpenRouter (default: Perplexity Sonar Deep Research). Autonomously searches, reads, and synthesizes multiple sources. WARNING: Significantly more expensive and slower than succ_web_search (30-120s, runs 30+ searches). Configure model with web_search.deep_research_model. Requires OPENROUTER_API_KEY.',
    {
      query: z.string().describe('The research question (e.g., "Compare React Server Components vs Astro Islands for e-commerce")'),
      system_prompt: z.string().optional().describe('Optional system prompt to guide research focus or output format'),
      max_tokens: z.number().optional().describe('Max response tokens (default: 8000)'),
      include_reasoning: z.boolean().optional().describe('Include the model\'s internal reasoning process (default: false)'),
      save_to_memory: z.boolean().optional().describe('Save result to succ memory (default: from config)'),
      project_path: projectPathParam,
    },
    async ({ query, system_prompt, max_tokens, include_reasoning, save_to_memory, project_path }) => {
      await applyProjectPath(project_path);

      if (!isApiConfigured()) {
        return {
          content: [{ type: 'text' as const, text: 'API key not configured. Set OPENROUTER_API_KEY environment variable or run:\nsucc_config_set key="llm.api_key" value="sk-or-..."' }],
          isError: true,
        };
      }

      const wsConfig = getWebSearchConfig();
      if (!wsConfig.enabled) {
        return {
          content: [{ type: 'text' as const, text: 'Web search is disabled. Enable with: succ_config_set key="web_search.enabled" value="true"' }],
          isError: true,
        };
      }

      const budgetError = await checkBudget(wsConfig.daily_budget_usd);
      if (budgetError) return { content: [{ type: 'text' as const, text: budgetError }], isError: true };

      try {
        const messages: ChatMessage[] = [];
        if (system_prompt) {
          messages.push({ role: 'system', content: system_prompt });
        }
        messages.push({ role: 'user', content: query });

        const result = await callOpenRouterSearch(
          messages,
          wsConfig.deep_research_model,
          wsConfig.deep_research_timeout_ms,
          max_tokens || wsConfig.deep_research_max_tokens,
          wsConfig.temperature,
        );

        const cost = estimateCost(result.usage, wsConfig.deep_research_model);
        await recordSearchToDb('succ_deep_research', wsConfig.deep_research_model, query, result.usage, cost, result.citations, !!result.reasoning, result.content.length);

        const todaySpent = wsConfig.daily_budget_usd > 0 ? await getTodayWebSearchSpend() : 0;
        let text = '';
        if (include_reasoning && result.reasoning) {
          text += `**Reasoning Process:**\n${result.reasoning}\n\n---\n\n`;
        }
        text += result.content;
        text += formatCitations(result.citations, result.search_results);
        text += formatUsage(result.usage, cost, wsConfig.daily_budget_usd, todaySpent);

        const shouldSave = save_to_memory ?? wsConfig.save_to_memory;
        if (shouldSave) {
          text += await saveResultToMemory(query, result.content, result.citations, 'succ_deep_research', 'learning');
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: any) {
        return { content: [{ type: 'text' as const, text: `Deep research failed: ${error.message}` }], isError: true };
      }
    },
  );

  // succ_web_search_history — view past searches
  server.tool(
    'succ_web_search_history',
    'View web search history with filtering. Shows past searches, costs, and usage statistics. Useful for tracking spend, reviewing past queries, and auditing search usage.',
    {
      tool_name: z.enum(['succ_quick_search', 'succ_web_search', 'succ_deep_research']).optional().describe('Filter by tool'),
      model: z.string().optional().describe('Filter by model (e.g., "perplexity/sonar-pro")'),
      query_text: z.string().optional().describe('Filter by query substring'),
      date_from: z.string().optional().describe('Start date (ISO, e.g., "2025-01-01")'),
      date_to: z.string().optional().describe('End date (ISO, e.g., "2025-12-31")'),
      limit: z.number().optional().describe('Max records to return (default: 20)'),
      project_path: projectPathParam,
    },
    async ({ tool_name, model, query_text, date_from, date_to, limit, project_path }) => {
      await applyProjectPath(project_path);

      try {
        const [records, summary] = await Promise.all([
          getWebSearchHistory({ tool_name, model, query_text, date_from, date_to, limit }),
          getWebSearchSummary(),
        ]);

        const lines: string[] = [];

        // Summary section
        lines.push('## Web Search Summary');
        lines.push(`Total: ${summary.total_searches} searches, $${summary.total_cost_usd.toFixed(4)}`);
        lines.push(`Today: ${summary.today_searches} searches, $${summary.today_cost_usd.toFixed(4)}`);

        if (Object.keys(summary.by_tool).length > 0) {
          lines.push('');
          lines.push('**By tool:**');
          for (const [tool, stats] of Object.entries(summary.by_tool)) {
            lines.push(`  ${tool}: ${stats.count} queries, $${stats.cost.toFixed(4)}`);
          }
        }

        // Records section
        if (records.length > 0) {
          lines.push('');
          lines.push(`## Recent Searches (${records.length})`);
          for (const r of records) {
            const date = r.created_at.slice(0, 16).replace('T', ' ');
            const tokens = r.prompt_tokens + r.completion_tokens;
            lines.push(`- **[${date}]** \`${r.tool_name}\` — "${r.query.slice(0, 80)}${r.query.length > 80 ? '...' : ''}"`);
            lines.push(`  Model: ${r.model} | Tokens: ${tokens.toLocaleString()} | Cost: $${r.estimated_cost_usd.toFixed(4)}${r.citations_count > 0 ? ` | Citations: ${r.citations_count}` : ''}`);
          }
        } else {
          lines.push('\n_No search records found matching filters._');
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error: any) {
        return { content: [{ type: 'text' as const, text: `Failed to retrieve search history: ${error.message}` }], isError: true };
      }
    },
  );
}
