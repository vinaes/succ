/**
 * Fact Extraction Prompt
 *
 * Used by session-summary.ts and session-processor.ts
 * to extract memorable facts from session transcripts.
 *
 * Split into system + user for prompt caching optimization.
 * The system prompt is stable across calls and can be cached by LLM providers.
 */

export const FACT_EXTRACTION_SYSTEM = `You are analyzing a coding session transcript to extract key facts worth remembering.

Extract concrete, actionable facts from the session. Focus on:
1. **Decisions** - choices made about architecture, tools, approaches
2. **Learnings** - new understanding gained, gotchas discovered
3. **Observations** - facts about the codebase, patterns noticed
4. **Errors** - bugs found and how they were fixed
5. **Patterns** - recurring themes or approaches used
6. **Dead Ends** - approaches that were tried and explicitly failed, with reasons why they didn't work

Rules:
- Extract ONLY facts that would be useful in future sessions
- Be specific: include file names, function names, commands when mentioned
- Skip generic conversation, greetings, confirmations
- Each fact should stand alone (make sense without the full transcript)
- Minimum 50 characters per fact
- For dead_end type: clearly state what was tried and WHY it failed
- If file paths or filenames are mentioned, include a "files" array with the basenames (e.g., ["cloud-init.ts", "deploy-test.sh"])

Output as JSON array:
[
  {
    "content": "The authentication middleware in src/auth/middleware.ts uses JWT tokens with 1-hour expiry",
    "type": "observation",
    "confidence": 0.9,
    "tags": ["auth", "jwt", "middleware"],
    "files": ["middleware.ts"]
  },
  {
    "content": "DEAD END: Tried using Redis for session storage — memory usage too high for VPS tier, switched to SQLite",
    "type": "dead_end",
    "confidence": 0.95,
    "tags": ["redis", "session", "dead-end"]
  },
  ...
]

If no meaningful facts found, return: []`;

export const FACT_EXTRACTION_PROMPT = `Session transcript:
---
{transcript}
---`;

/**
 * Session progress extraction prompt (for daemon session-processor).
 * Reuses FACT_EXTRACTION_SYSTEM, only the user template differs.
 */
export const SESSION_PROGRESS_EXTRACTION_PROMPT = `Session progress (accumulated briefings from idle reflections):
---
{content}
---`;

/**
 * Search Result Extraction Prompts
 *
 * Used by extractAnswerFromResults() in mcp/helpers.ts
 * for Smart Result Compression (extract parameter on search tools).
 *
 * Split into system + user for prompt caching optimization.
 * The system prompt is stable across all extract calls and cached by LLM providers.
 * The user prompt contains dynamic search results and the user's question.
 */
export const SEARCH_EXTRACT_SYSTEM = `You are a concise research assistant analyzing search results from a project knowledge base.

Rules:
- Answer ONLY using information from the provided results
- Be concise — aim for 2-5 sentences unless the question requires more detail
- If multiple results are relevant, synthesize them into a unified answer
- If the answer is not found in the results, say "Not found in search results"
- Include specific details: file paths, function names, config keys when present
- Do not speculate or add information beyond what the results contain`;

export const SEARCH_EXTRACT_PROMPT = `<results>
{results}
</results>

Question: {question}`;
