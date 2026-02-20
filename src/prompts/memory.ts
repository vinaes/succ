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
