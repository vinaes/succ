/**
 * Fact Extraction Prompt
 *
 * Used by session-summary.ts and session-processor.ts
 * to extract memorable facts from session transcripts.
 */

export const FACT_EXTRACTION_PROMPT = `You are analyzing a coding session transcript to extract key facts worth remembering.

Session transcript:
---
{transcript}
---

Extract concrete, actionable facts from this session. Focus on:
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

/**
 * Session progress extraction prompt (for daemon session-processor).
 * Similar to FACT_EXTRACTION_PROMPT but expects accumulated briefings as input.
 */
export const SESSION_PROGRESS_EXTRACTION_PROMPT = `You are analyzing session progress to extract key facts worth remembering.

Session progress (accumulated briefings from idle reflections):
---
{content}
---

Extract concrete, actionable facts from this session. Focus on:
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
- Each fact should stand alone (make sense without the full context)
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
