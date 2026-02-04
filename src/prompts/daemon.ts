/**
 * Daemon Service Prompts
 *
 * Used by background services for reflection and discovery.
 */

/**
 * Personal reflection prompt for AI journal entries.
 * Used by daemon service.ts during idle time.
 */
export const REFLECTION_PROMPT = `You are writing a brief personal reflection for an AI's internal journal.

Session context (recent conversation):
---
{transcript}
---

Write a short reflection (3-5 sentences) about this session. Be honest and introspective.
Consider:
- What was accomplished or attempted?
- Any interesting challenges or discoveries?
- What might be worth remembering for future sessions?

Output ONLY the reflection text, no headers or formatting. Write in first person as if you are the AI reflecting on your own work.`;

/**
 * Discovery agent prompt for finding patterns and learnings.
 * Used by daemon analyzer.ts during background analysis.
 */
export const DISCOVERY_PROMPT = `You are analyzing a software project to discover patterns, learnings, and insights worth remembering.

Project context:
{context}

Find 2-5 interesting discoveries. Each should be a concrete, reusable insight.

Output as JSON array:
[
  {
    "type": "learning" | "pattern" | "decision" | "observation",
    "title": "Short title",
    "content": "Detailed description (2-3 sentences)",
    "tags": ["tag1", "tag2"]
  }
]

If no interesting discoveries, output: []`;
