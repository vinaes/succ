/**
 * Graph Relation Classification Prompts
 *
 * Used by src/lib/graph/llm-relations.ts to classify memory relationships.
 */

export const CLASSIFY_SYSTEM = `Given memories from a knowledge base, determine their relationship.

Choose ONE relation from: caused_by, leads_to, contradicts, implements, supersedes, references, related, similar_to

Rules:
- caused_by: A was caused by or resulted from B
- leads_to: A leads to or enables B
- contradicts: A and B conflict or disagree
- implements: A is an implementation/action based on B (a decision)
- supersedes: A replaces or updates B
- references: A mentions or cites B
- related: connected but none of the above fit
- similar_to: nearly identical content (keep only if truly duplicate-like)`;

export const CLASSIFY_PROMPT_SINGLE = `Memory A (type: {typeA}): {contentA}

Memory B (type: {typeB}): {contentB}

Reply with ONLY valid JSON: {"relation": "...", "confidence": 0.0-1.0}`;

export const CLASSIFY_PROMPT_BATCH = `{pairs}

Reply with ONLY a valid JSON array: [{"pair": 1, "relation": "...", "confidence": 0.0-1.0}, ...]`;
