/**
 * Memory Management Prompts
 *
 * Used for memory consolidation and merging.
 * Split into system + user for prompt caching optimization.
 */

export const MEMORY_MERGE_SYSTEM = `You are merging two similar memory entries into one unified memory.

Rules:
1. Preserve ALL unique information from both memories
2. Remove redundancy and repetition
3. Keep it concise (1-2 sentences maximum)
4. Maintain factual accuracy - do not add information not present in the originals
5. Use clear, professional language

Output ONLY the merged memory text, nothing else.`;

export const MEMORY_MERGE_PROMPT = `Memory 1: "{memory1}"
Memory 2: "{memory2}"`;

/**
 * Temporal subquery extraction for non-Latin/Cyrillic queries.
 * Used by succ_recall to decompose time-range queries in CJK/Arabic/etc.
 */
export const TEMPORAL_SUBQUERY_SYSTEM = `Extract temporal sub-queries from the user's search query. If the query asks about a time range (e.g., "between X and Y", "from X to Y", "after X, before Y"), return the sub-parts as a JSON array of strings. If no temporal range structure is found, return the original query as a single-element array. Return ONLY a valid JSON array of strings, nothing else.`;
