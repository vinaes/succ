/**
 * LLM-based query expansion for richer recall.
 *
 * Takes a user query and generates additional search terms
 * to improve retrieval coverage. Disabled by default.
 */

import { callLLM, getLLMConfig } from './llm.js';
import type { LLMBackend } from './llm.js';
import { EXPANSION_SYSTEM, EXPANSION_PROMPT } from '../prompts/index.js';

/**
 * Expand a query into multiple search terms using LLM.
 *
 * @param query - The original user query
 * @param mode - LLM backend override (defaults to configured backend)
 * @returns Array of expanded queries (NOT including the original)
 */
export async function expandQuery(query: string, mode?: LLMBackend): Promise<string[]> {
  const prompt = EXPANSION_PROMPT.replace('{query}', query);

  const llmConfig = getLLMConfig();
  const backend = mode ?? llmConfig.backend;

  try {
    const configOverride = backend !== llmConfig.backend ? { backend } : undefined;
    const response = await callLLM(
      prompt,
      {
        maxTokens: 200,
        temperature: 0.7,
        systemPrompt: EXPANSION_SYSTEM,
      },
      configOverride
    );

    if (!response || response.trim().length === 0) return [];

    // Parse response: one query per line, filter empty/invalid
    const expanded = response
      .split('\n')
      .map((line) => line.replace(/^[\d\-*.)]+\s*/, '').trim()) // strip numbering
      .filter((line) => line.length >= 3 && line.length <= 200)
      .filter((line) => !/^(alternative|here are|queries?:)/i.test(line))
      .slice(0, 5);

    return expanded;
  } catch {
    // LLM failure should never break search — silently fall back to no expansion
    return [];
  }
}
