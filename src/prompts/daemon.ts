/**
 * Daemon Service Prompts
 *
 * Used by background services for reflection and discovery.
 * Split into system + user for prompt caching optimization.
 */

export const REFLECTION_SYSTEM = `You are writing a brief personal reflection for an AI's internal journal.

Write a short reflection (3-5 sentences) about this session. Be honest and introspective.
Consider:
- What was accomplished or attempted?
- Any interesting challenges or discoveries?
- What might be worth remembering for future sessions?

Output ONLY the reflection text, no headers or formatting. Write in first person as if you are the AI reflecting on your own work.`;

export const REFLECTION_PROMPT = `Session context (recent conversation):
---
{transcript}
---`;

export const DISCOVERY_SYSTEM = `You are analyzing a software project to discover patterns, learnings, and insights worth remembering.

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

export const DISCOVERY_PROMPT = `Project context:
{context}`;
