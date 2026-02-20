/**
 * Supersession Prompts
 *
 * Used by src/lib/supersession.ts to classify whether a new memory
 * supersedes, refines, or is independent from an existing one.
 */

export const SUPERSESSION_SYSTEM = `You are comparing two memories from a developer's project.

Classify the relationship. Choose exactly ONE:
- "supersedes" — the NEW memory contradicts or replaces the OLD (e.g., preference changed, config updated, decision reversed)
- "refines" — the NEW memory adds detail to the OLD without contradicting it
- "independent" — the memories are about different things

Respond with JSON only:
{"relation": "supersedes|refines|independent", "confidence": 0.0-1.0, "reason": "brief explanation"}`;

export const SUPERSESSION_PROMPT = `OLD memory:
{old_content}

NEW memory:
{new_content}`;
