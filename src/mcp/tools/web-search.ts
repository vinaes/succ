/**
 * MCP Web Search tools (Perplexity Sonar via OpenRouter)
 *
 * - succ_web_search: Real-time web search using Perplexity Sonar
 * - succ_deep_research: Multi-step deep research using Perplexity Sonar Deep Research
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { getWebSearchConfig, getSuccDir } from '../../lib/config.js';
import { isOpenRouterConfigured, callOpenRouterSearch, type OpenRouterSearchResponse, type ChatMessage } from '../../lib/llm.js';
import { projectPathParam, applyProjectPath } from '../helpers.js';

// Approximate pricing per 1M tokens (USD) — OpenRouter Perplexity models
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'perplexity/sonar': { input: 1, output: 1 },
  'perplexity/sonar-pro': { input: 3, output: 15 },
  'perplexity/sonar-pro-search': { input: 3, output: 15 },
  'perplexity/sonar-reasoning': { input: 1, output: 5 },
  'perplexity/sonar-reasoning-pro': { input: 2, output: 8 },
  'perplexity/sonar-deep-research': { input: 2, output: 8 },
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
 * Get today's spend file path
 */
function getSpendFilePath(): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(getSuccDir(), `web-search-spend-${today}.json`);
}

/**
 * Read today's cumulative spend
 */
function getTodaySpend(): number {
  try {
    const data = JSON.parse(fs.readFileSync(getSpendFilePath(), 'utf-8'));
    return data.total_usd || 0;
  } catch {
    return 0;
  }
}

/**
 * Record spend for a request
 */
function recordSpend(cost: number, model: string, query: string): void {
  const filePath = getSpendFilePath();
  let data: { total_usd: number; requests: Array<{ time: string; model: string; cost: number; query: string }> };
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    data = { total_usd: 0, requests: [] };
  }
  data.total_usd += cost;
  data.requests.push({
    time: new Date().toISOString(),
    model,
    cost: Math.round(cost * 1_000_000) / 1_000_000,
    query: query.slice(0, 100),
  });
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch {
    // Non-critical — don't fail the search
  }
}

/**
 * Check budget and return error message if exceeded
 */
function checkBudget(dailyBudget: number): string | null {
  if (dailyBudget <= 0) return null; // unlimited
  const spent = getTodaySpend();
  if (spent >= dailyBudget) {
    return `Daily web search budget exceeded ($${spent.toFixed(4)} / $${dailyBudget}). Reset tomorrow or increase with: succ_config_set key="web_search.daily_budget_usd" value="..."`;
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
function formatUsage(usage: OpenRouterSearchResponse['usage'], cost: number, dailyBudget: number): string {
  if (!usage) return '';
  const parts = [
    `Tokens: ${usage.total_tokens.toLocaleString()} (prompt: ${usage.prompt_tokens.toLocaleString()}, completion: ${usage.completion_tokens.toLocaleString()})`,
    `Cost: ~$${cost.toFixed(4)}`,
  ];
  if (dailyBudget > 0) {
    const spent = getTodaySpend();
    parts.push(`Budget: $${spent.toFixed(4)} / $${dailyBudget}`);
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
      [toolName === 'succ_web_search' ? 'web-search' : 'deep-research', 'auto-saved'],
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

  // succ_web_search — fast real-time web search
  server.tool(
    'succ_web_search',
    'Search the web in real-time using Perplexity Sonar via OpenRouter. Returns answers with citations. Requires OPENROUTER_API_KEY. Use for current events, documentation lookups, fact-checking, and queries needing up-to-date web information.',
    {
      query: z.string().describe('The search query (e.g., "latest React 19 features", "how to configure nginx reverse proxy")'),
      model: z.string().optional().describe('Override search model (default: perplexity/sonar-pro). Options: perplexity/sonar, perplexity/sonar-pro, perplexity/sonar-reasoning-pro'),
      system_prompt: z.string().optional().describe('Optional system prompt to guide the response format or focus'),
      max_tokens: z.number().optional().describe('Max response tokens (default: 4000)'),
      save_to_memory: z.boolean().optional().describe('Save result to succ memory (default: from config)'),
      project_path: projectPathParam,
    },
    async ({ query, model, system_prompt, max_tokens, save_to_memory, project_path }) => {
      await applyProjectPath(project_path);

      if (!isOpenRouterConfigured()) {
        return {
          content: [{ type: 'text' as const, text: 'OpenRouter API key not configured. Set OPENROUTER_API_KEY environment variable or run:\nsucc_config_set key="openrouter_api_key" value="sk-or-..."' }],
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

      const budgetError = checkBudget(wsConfig.daily_budget_usd);
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
        recordSpend(cost, effectiveModel, query);

        let text = result.content;
        text += formatCitations(result.citations, result.search_results);
        text += formatUsage(result.usage, cost, wsConfig.daily_budget_usd);

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
    'Conduct deep, multi-step web research using Perplexity Sonar Deep Research via OpenRouter. Autonomously searches, reads, and synthesizes multiple sources. WARNING: Significantly more expensive and slower than succ_web_search (30-120 seconds, runs 30+ searches). Requires OPENROUTER_API_KEY.',
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

      if (!isOpenRouterConfigured()) {
        return {
          content: [{ type: 'text' as const, text: 'OpenRouter API key not configured. Set OPENROUTER_API_KEY environment variable or run:\nsucc_config_set key="openrouter_api_key" value="sk-or-..."' }],
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

      const budgetError = checkBudget(wsConfig.daily_budget_usd);
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
        recordSpend(cost, wsConfig.deep_research_model, query);

        let text = '';
        if (include_reasoning && result.reasoning) {
          text += `**Reasoning Process:**\n${result.reasoning}\n\n---\n\n`;
        }
        text += result.content;
        text += formatCitations(result.citations, result.search_results);
        text += formatUsage(result.usage, cost, wsConfig.daily_budget_usd);

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
}
