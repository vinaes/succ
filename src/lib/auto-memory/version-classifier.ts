/**
 * Memory Version Classifier — detect relationships between new and existing memories.
 *
 * At save time, finds similar existing memories and classifies the relationship:
 * - updates: new memory replaces old (set old is_latest=false)
 * - extends: new memory adds detail (both stay is_latest=true)
 * - derives: new memory is inferred from old (informational link)
 * - none: unrelated or too different
 *
 * Config-gated: auto_memory.version_detection: true (default: false)
 * Costs 1 LLM call per save when triggered (only if similar memory found > 0.85).
 */

import { callLLM } from '../llm.js';
import { logWarn, logInfo } from '../fault-logger.js';

export type VersionRelation = 'updates' | 'extends' | 'derives' | 'none';

export interface VersionClassification {
  relation: VersionRelation;
  existingMemoryId: number;
  existingContent: string;
  similarity: number;
}

const VERSION_SYSTEM =
  'You classify the relationship between a new memory and an existing one. ' +
  'Respond with exactly one word: updates, extends, derives, or none.\n\n' +
  '- updates: new memory replaces/corrects the existing one (same topic, newer info)\n' +
  '- extends: new memory adds detail to the existing one (complementary)\n' +
  '- derives: new memory is inferred or follows from the existing one\n' +
  '- none: unrelated or too different to link';

const VERSION_PROMPT = `Existing memory (ID 1):
{existing}

New memory:
{new}

Relationship:`;

/**
 * Classify the relationship between a new memory and similar existing ones.
 * Returns null if no LLM call needed (no similar memories found or below threshold).
 */
export async function classifyVersionRelation(
  newContent: string,
  existingMemory: { id: number; content: string; similarity: number }
): Promise<VersionClassification | null> {
  try {
    const prompt = VERSION_PROMPT.replace(
      '{existing}',
      existingMemory.content.slice(0, 500)
    ).replace('{new}', newContent.slice(0, 500));

    const response = await callLLM(prompt, {
      maxTokens: 10,
      temperature: 0.1,
      systemPrompt: VERSION_SYSTEM,
      timeout: 5000,
    });

    const relation = response.trim().toLowerCase() as VersionRelation;
    if (!['updates', 'extends', 'derives', 'none'].includes(relation)) {
      return null;
    }

    if (relation === 'none') return null;

    logInfo(
      'version-classifier',
      `Memory #${existingMemory.id} → ${relation} (sim=${existingMemory.similarity.toFixed(2)})`
    );

    return {
      relation,
      existingMemoryId: existingMemory.id,
      existingContent: existingMemory.content,
      similarity: existingMemory.similarity,
    };
  } catch (error) {
    logWarn('version-classifier', 'LLM classification failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
