/**
 * Briefing Prompts
 *
 * Used for session summarization and handoff between contexts.
 * Three formats: structured (XML), prose (conversational), minimal (4 lines).
 *
 * Split into system + user for prompt caching optimization.
 */

/**
 * Structured format with XML tags.
 * Used by compact-briefing.ts as default format.
 */
export const BRIEFING_STRUCTURED_SYSTEM = `Summarize this coding session for handoff to a fresh context.

Output in this EXACT XML format (keep the XML tags exactly as shown):

<task>
[1-2 sentences: what was the main goal/task being worked on]
</task>

<completed>
- [bullet point: what was done]
- [bullet point: what was done]
</completed>

<in-progress>
- [bullet point: what's partially done or being tested]
</in-progress>

<decisions>
- [bullet point: key technical decision made and why]
</decisions>

<next-steps priority="high">
- [bullet point: what to do next]
- [bullet point: what to do next]
</next-steps>

Be concise and specific. Include file names, function names, and technical details.
If a section is empty (e.g., no decisions), output the tag with "None" inside.`;

export const BRIEFING_STRUCTURED_PROMPT = `Session transcript:
---
{transcript}
---

{memories_section}`;

/**
 * Prose format with conversational summary.
 * Used by compact-briefing.ts when format=prose.
 */
export const BRIEFING_PROSE_SYSTEM = `Summarize this coding session for handoff to a fresh context.

Output in this EXACT XML format:

<task>[1 sentence: main goal]</task>

<summary>
[2-3 paragraphs covering: what was accomplished, current state, key decisions, what's next]
</summary>

<continue-with hint="start here">
[1 sentence: the immediate next action to take]
</continue-with>

Be conversational but concise. Include specific technical details (files, functions, errors).`;

export const BRIEFING_PROSE_PROMPT = `Session transcript:
---
{transcript}
---

{memories_section}`;

/**
 * Minimal format - just 4 lines.
 * Used by compact-briefing.ts when format=minimal.
 */
export const BRIEFING_MINIMAL_SYSTEM = `Summarize this coding session in exactly 4 lines.

Output EXACTLY 4 lines:
Task: [what was being done]
Done: [what was completed]
State: [current status]
Next: [what to do next]

Be extremely concise. Use technical terms.`;

export const BRIEFING_MINIMAL_PROMPT = `Session transcript:
---
{transcript}
---

{memories_section}`;

/**
 * Session briefing for precompute-context.
 * Used to prepare context for the next session.
 */
export const SESSION_BRIEFING_SYSTEM = `You are preparing a briefing for an AI assistant's next coding session.

Generate a concise briefing (3-5 bullet points) that will help the assistant quickly understand:
1. What was being worked on
2. Current state/progress
3. Any pending tasks or issues
4. Key context to remember

Output format:
## Session Briefing

- [bullet point 1]
- [bullet point 2]
...

## Suggested Focus
[One sentence about what to focus on next]`;

export const SESSION_BRIEFING_PROMPT = `Session transcript (recent activity):
---
{transcript}
---

Relevant memories from past sessions:
---
{memories}
---`;
