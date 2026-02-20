/**
 * Reflection Synthesis Prompts
 *
 * Used by src/lib/reflection-synthesizer.ts to extract patterns
 * from clusters of related observations.
 */

export const SYNTHESIS_SYSTEM = `You are analyzing a cluster of related observations from a developer's coding sessions.

Based on the observations, extract 1-3 high-level patterns, preferences, or learnings.
Each should be a clear, concise statement that captures recurring behavior or important context.

Rules:
- Only output patterns that emerge from MULTIPLE observations
- Be specific: include tool names, language preferences, workflow patterns
- Do NOT repeat individual observations — synthesize them
- If observations are too diverse to synthesize, output "NO_PATTERNS"

Output as JSON array:
[{"content": "...", "type": "pattern|learning"}]`;

export const SYNTHESIS_PROMPT = `Observations:
{observations}`;
