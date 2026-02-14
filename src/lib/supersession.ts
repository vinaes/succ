/**
 * Smart Supersession
 *
 * After saving a new memory, async-check if it supersedes (contradicts/replaces)
 * an existing memory. Uses 3-way LLM classification:
 *   - supersedes: new fact replaces old → soft-delete old via invalidated_by
 *   - refines: new fact extends old → link them
 *   - independent: unrelated → noop
 *
 * Only acts when LLM confidence >= 0.9 for "supersedes".
 * Uses sleep agent (local Qwen) to avoid cloud costs.
 */

import { callLLM } from './llm.js';
import { invalidateMemory, getAllMemoriesWithEmbeddings } from './storage/index.js';
import { cosineSimilarity } from './embeddings.js';

const SUPERSESSION_PROMPT = `You are comparing two memories from a developer's project.

OLD memory:
{old_content}

NEW memory:
{new_content}

Classify the relationship. Choose exactly ONE:
- "supersedes" — the NEW memory contradicts or replaces the OLD (e.g., preference changed, config updated, decision reversed)
- "refines" — the NEW memory adds detail to the OLD without contradicting it
- "independent" — the memories are about different things

Respond with JSON only:
{"relation": "supersedes|refines|independent", "confidence": 0.0-1.0, "reason": "brief explanation"}`;

const SIMILARITY_THRESHOLD = 0.8;
const CONFIDENCE_THRESHOLD = 0.9;
const MAX_CANDIDATES = 5;

export interface SupersessionResult {
  checked: number;
  superseded: number;
  refined: number;
  errors: string[];
}

/**
 * Check if a newly saved memory supersedes any existing ones.
 * Should be called async (fire-and-forget) after memory save.
 */
export async function checkSupersession(
  newMemoryId: number,
  newContent: string,
  newEmbedding: number[],
  options: { log?: (msg: string) => void } = {}
): Promise<SupersessionResult> {
  const { log = () => {} } = options;
  const result: SupersessionResult = { checked: 0, superseded: 0, refined: 0, errors: [] };

  try {
    // Find similar memories (cosine > threshold, excluding the new one and already invalidated)
    const allMemories = await getAllMemoriesWithEmbeddings({ excludeInvalidated: true });

    // Score all and take top N similar
    const candidates: Array<{ id: number; content: string; similarity: number }> = [];
    for (const mem of allMemories) {
      if (mem.id === newMemoryId || !mem.embedding) continue;
      const sim = cosineSimilarity(newEmbedding, mem.embedding);
      if (sim >= SIMILARITY_THRESHOLD) {
        candidates.push({ id: mem.id, content: mem.content, similarity: sim });
      }
    }

    candidates.sort((a, b) => b.similarity - a.similarity);
    const topCandidates = candidates.slice(0, MAX_CANDIDATES);

    if (topCandidates.length === 0) return result;

    log(`[supersession] Found ${topCandidates.length} candidates for memory #${newMemoryId}`);

    for (const candidate of topCandidates) {
      result.checked++;
      try {
        const prompt = SUPERSESSION_PROMPT.replace('{old_content}', candidate.content).replace(
          '{new_content}',
          newContent
        );

        const llmResponse = await callLLM(prompt, {
          timeout: 15000,
          useSleepAgent: true,
          maxTokens: 200,
          temperature: 0.1,
        });

        // Parse JSON response
        const jsonMatch = llmResponse.match(/\{[\s\S]*?\}/);
        if (!jsonMatch) {
          result.errors.push(`Memory #${candidate.id}: failed to parse LLM response`);
          continue;
        }

        const classification = JSON.parse(jsonMatch[0]) as {
          relation: string;
          confidence: number;
          reason: string;
        };

        if (
          classification.relation === 'supersedes' &&
          classification.confidence >= CONFIDENCE_THRESHOLD
        ) {
          await invalidateMemory(candidate.id, newMemoryId);
          result.superseded++;
          log(
            `[supersession] Memory #${candidate.id} superseded by #${newMemoryId}: ${classification.reason}`
          );
        } else if (classification.relation === 'refines') {
          result.refined++;
          // Link already created by autoLink — no extra action needed
        }
      } catch (err) {
        result.errors.push(`Memory #${candidate.id}: ${err}`);
      }
    }
  } catch (err) {
    result.errors.push(`Fatal: ${err}`);
  }

  return result;
}
