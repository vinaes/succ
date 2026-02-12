/**
 * LLM-based query expansion for richer recall.
 *
 * Takes a user query and generates additional search terms
 * to improve retrieval coverage. Disabled by default.
 */

import { callLLM, getLLMConfig } from './llm.js';
import type { LLMBackend } from './llm.js';

const EXPANSION_PROMPT = `You are a search query expander. Given a user's search query about code, software development, or technical decisions, generate 3-5 alternative search queries that would help find relevant information.

Rules:
- Each query should capture a different aspect or phrasing of the original intent
- Include synonyms, related concepts, and alternative terminology
- Keep queries concise (3-8 words each)
- Return ONLY the queries, one per line, no numbering or bullets
- Do not repeat the original query

User query: "{query}"

Alternative queries:`;

/**
 * Expand a query into multiple search terms using LLM.
 *
 * @param query - The original user query
 * @param mode - LLM backend override (defaults to configured backend)
 * @returns Array of expanded queries (NOT including the original)
 */
export async function expandQuery(
  query: string,
  mode?: LLMBackend,
): Promise<string[]> {
  const prompt = EXPANSION_PROMPT.replace('{query}', query);

  const llmConfig = getLLMConfig();
  const backend = mode ?? llmConfig.backend;

  try {
    const configOverride = backend !== llmConfig.backend ? { backend } : undefined;
    const response = await callLLM(prompt, {
      maxTokens: 200,
      temperature: 0.7,
    }, configOverride);

    if (!response || response.trim().length === 0) return [];

    // Parse response: one query per line, filter empty/invalid
    const expanded = response
      .split('\n')
      .map(line => line.replace(/^[\d\-\*\.\)]+\s*/, '').trim())  // strip numbering
      .filter(line => line.length >= 3 && line.length <= 200)
      .filter(line => !/^(alternative|here are|queries?:)/i.test(line))
      .slice(0, 5);

    return expanded;
  } catch {
    // LLM failure should never break search — silently fall back to no expansion
    return [];
  }
}
