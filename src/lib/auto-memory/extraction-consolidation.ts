/**
 * Extraction Consolidation — intelligent ADD/UPDATE/DELETE decisions
 *
 * After fact extraction (Phase 1), this module runs a consolidation step
 * (Phase 1.5) before saving to storage:
 *
 * For each extracted fact:
 *   1. Embed the fact and search top-5 similar existing memories
 *   2. Remap real IDs to sequential integers (ID remapping trick — prevents LLM UUID hallucination)
 *   3. Call LLM to decide: ADD / UPDATE / DELETE / NONE
 *   4. Execute the decision:
 *      - ADD: save as new memory (normal path)
 *      - UPDATE: invalidate old memory, save new one with updated content
 *      - DELETE: invalidate the contradicted memory, skip the new fact
 *      - NONE: skip (already known)
 *
 * This replaces raw dedup-by-similarity with intelligent consolidation.
 * Gate: config.auto_memory.extraction_consolidation (default: false — opt-in)
 */

import { searchMemories, invalidateMemory, saveMemory, getMemoryById } from '../storage/index.js';
import { getEmbedding } from '../embeddings.js';
import { callLLM } from '../llm.js';
import { logInfo, logWarn } from '../fault-logger.js';
import { getErrorMessage } from '../errors.js';
import { scoreMemory } from '../quality.js';
import { getConfig } from '../config.js';
import type { SourceType, MemoryType, Memory } from '../storage/types.js';

// ============================================================================
// Shared Constants
// ============================================================================

/** Default similarity threshold for finding related memories during consolidation */
export const CONSOLIDATION_SIMILARITY_THRESHOLD = 0.75;
/** Default max similar memories to compare per fact */
export const CONSOLIDATION_TOP_K = 5;
/** Default LLM timeout in ms for consolidation calls */
export const CONSOLIDATION_LLM_TIMEOUT = 30000;

// ============================================================================
// Types
// ============================================================================

/** Decision the LLM makes for each extracted fact */
export type ConsolidationDecision = 'ADD' | 'UPDATE' | 'DELETE' | 'NONE';

/** Result of a single fact's consolidation decision */
export interface FactDecision {
  /** The extracted fact content */
  factContent: string;
  /** LLM decision */
  decision: ConsolidationDecision;
  /** If UPDATE: the existing memory ID that should be replaced */
  existingMemoryId?: number;
  /** LLM reasoning for the decision */
  reason: string;
  /** Updated content (for UPDATE — LLM may merge old + new) */
  mergedContent?: string;
}

/** Result of the full consolidation pass */
export interface ExtractionConsolidationResult {
  /** Facts to save as new memories */
  toAdd: FactToSave[];
  /** Facts that update existing memories */
  toUpdate: FactToUpdate[];
  /** Existing memory IDs to invalidate (contradicted) */
  toDelete: number[];
  /** Facts skipped (already known) */
  skippedNone: number;
  /** Facts where consolidation errored (fall back to ADD) */
  fallbackAdd: FactToSave[];
}

export interface FactToSave {
  content: string;
  type: MemoryType;
  confidence: number;
  tags: string[];
}

export interface FactToUpdate {
  /** Existing memory ID to invalidate */
  existingMemoryId: number;
  /** New content (potentially merged) */
  content: string;
  type: MemoryType;
  confidence: number;
  tags: string[];
}

/** Input fact shape — must match ExtractedFact from session-processor/session-summary */
export interface ExtractedFactInput {
  content: string;
  type: string;
  confidence: number;
  tags: string[];
}

// ============================================================================
// Prompt
// ============================================================================

const CONSOLIDATION_SYSTEM = `You are a memory management system deciding how to handle new facts relative to existing memories.

For each new fact, you will see the existing similar memories (with integer IDs) and must decide:
- ADD: The fact is genuinely new information not captured by any existing memory
- UPDATE: The fact updates/corrects/supersedes an existing memory (specify which ID)
- DELETE: The fact reveals an existing memory is wrong/outdated — remove the old one, don't save the new fact
- NONE: The fact is already captured by existing memories — skip it

Rules:
- Be conservative: prefer NONE over ADD if the information is already captured
- UPDATE means the new fact is a better/more current version of an existing memory
- DELETE is rare — only when the new fact explicitly contradicts an existing memory
- For UPDATE: provide merged content that combines the best of old and new
- Always explain your reasoning briefly`;

function buildConsolidationPrompt(
  fact: string,
  existingMemories: Array<{ seqId: number; content: string; confidence: number | null }>
): string {
  if (existingMemories.length === 0) {
    return `New fact:\n"${fact}"\n\nNo similar existing memories found.\n\nDecide: ADD, UPDATE, DELETE, or NONE.\nRespond as JSON: {"decision": "ADD"|"UPDATE"|"DELETE"|"NONE", "existing_id": null, "reason": "...", "merged_content": null}`;
  }

  const memoriesText = existingMemories
    .map((m) => `  [${m.seqId}] (confidence: ${m.confidence ?? 'unknown'}): "${m.content}"`)
    .join('\n');

  return `New fact:\n"${fact}"\n\nExisting similar memories:\n${memoriesText}\n\nDecide: ADD, UPDATE, DELETE, or NONE.\nIf UPDATE, specify which existing_id and provide merged_content.\nIf DELETE, specify which existing_id to remove.\n\nRespond as JSON: {"decision": "ADD"|"UPDATE"|"DELETE"|"NONE", "existing_id": <number|null>, "reason": "...", "merged_content": "<string|null>"}`;
}

// ============================================================================
// Core Logic
// ============================================================================

/**
 * Parse LLM response into a ConsolidationDecision.
 * Tolerant of malformed JSON — falls back to ADD on parse failure.
 */
export function parseConsolidationResponse(response: string): {
  decision: ConsolidationDecision;
  existingId: number | null;
  reason: string;
  mergedContent: string | null;
} {
  const fallback = {
    decision: 'ADD' as ConsolidationDecision,
    existingId: null,
    reason: 'parse-fallback',
    mergedContent: null,
  };

  try {
    // Extract JSON from response (LLM may wrap in markdown)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;

    const parsed = JSON.parse(jsonMatch[0]);

    const decision = String(parsed.decision ?? '').toUpperCase();
    if (!['ADD', 'UPDATE', 'DELETE', 'NONE'].includes(decision)) {
      return fallback;
    }

    return {
      decision: decision as ConsolidationDecision,
      existingId: typeof parsed.existing_id === 'number' ? parsed.existing_id : null,
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'no-reason',
      mergedContent: typeof parsed.merged_content === 'string' ? parsed.merged_content : null,
    };
  } catch (err) {
    logWarn(
      'extraction-consolidation',
      `Failed to parse consolidation LLM response: ${getErrorMessage(err)}`
    );
    return fallback;
  }
}

/**
 * Run intelligent consolidation on a batch of extracted facts.
 *
 * For each fact:
 *   1. Embed and find top-5 similar existing memories
 *   2. Remap IDs to sequential integers (ID remapping trick)
 *   3. LLM decides ADD/UPDATE/DELETE/NONE
 *   4. Collect results for the caller to execute
 *
 * @param facts - extracted facts from session
 * @param options - configuration overrides
 * @returns consolidation results partitioned by decision
 */
export async function consolidateExtractedFacts(
  facts: ExtractedFactInput[],
  options?: {
    /** Similarity threshold for finding related memories (default: 0.75) */
    similarityThreshold?: number;
    /** Max similar memories to compare per fact (default: 5) */
    topK?: number;
    /** LLM timeout in ms (default: 30000) */
    llmTimeout?: number;
    /** Skip LLM and return all as ADD (for testing) */
    dryRun?: boolean;
  }
): Promise<ExtractionConsolidationResult> {
  const threshold = options?.similarityThreshold ?? CONSOLIDATION_SIMILARITY_THRESHOLD;
  const topK = options?.topK ?? CONSOLIDATION_TOP_K;
  const llmTimeout = options?.llmTimeout ?? CONSOLIDATION_LLM_TIMEOUT;
  const dryRun = options?.dryRun ?? false;

  const result: ExtractionConsolidationResult = {
    toAdd: [],
    toUpdate: [],
    toDelete: [],
    skippedNone: 0,
    fallbackAdd: [],
  };

  if (facts.length === 0) return result;

  // Process each fact sequentially (LLM calls are the bottleneck, not parallelism)
  for (const fact of facts) {
    try {
      // Step 1: Embed the fact and search for similar existing memories
      const embedding = await getEmbedding(fact.content);
      const similarMemories = await searchMemories(embedding, topK, threshold);

      // If no similar memories found or dry run, just ADD
      if (similarMemories.length === 0 || dryRun) {
        result.toAdd.push({
          content: fact.content,
          type: fact.type as MemoryType,
          confidence: fact.confidence,
          tags: fact.tags,
        });
        continue;
      }

      // Step 2: Remap real IDs to sequential integers (ID remapping trick)
      // This prevents the LLM from hallucinating UUIDs or confusing large integer IDs
      const idMap = new Map<number, number>(); // seqId -> realId
      const mappedMemories = similarMemories.map(
        (mem: Memory & { similarity?: number }, idx: number) => {
          const seqId = idx + 1;
          idMap.set(seqId, mem.id);
          return {
            seqId,
            content: mem.content,
            confidence: mem.confidence,
          };
        }
      );

      // Step 3: Call LLM to decide
      const prompt = buildConsolidationPrompt(fact.content, mappedMemories);
      let llmResponse: string;
      try {
        llmResponse = await callLLM(prompt, {
          timeout: llmTimeout,
          maxTokens: 500,
          useSleepAgent: true,
          systemPrompt: CONSOLIDATION_SYSTEM,
        });
      } catch (llmErr) {
        // LLM failure: fall back to ADD (don't lose the fact)
        logWarn(
          'extraction-consolidation',
          `LLM call failed for fact consolidation, falling back to ADD: ${getErrorMessage(llmErr)}`
        );
        result.fallbackAdd.push({
          content: fact.content,
          type: fact.type as MemoryType,
          confidence: fact.confidence,
          tags: fact.tags,
        });
        continue;
      }

      // Step 4: Parse and execute decision
      const parsed = parseConsolidationResponse(llmResponse);

      // Resolve sequential ID back to real ID
      const realExistingId =
        parsed.existingId !== null ? (idMap.get(parsed.existingId) ?? null) : null;

      switch (parsed.decision) {
        case 'ADD':
          result.toAdd.push({
            content: fact.content,
            type: fact.type as MemoryType,
            confidence: fact.confidence,
            tags: fact.tags,
          });
          break;

        case 'UPDATE':
          if (realExistingId !== null) {
            result.toUpdate.push({
              existingMemoryId: realExistingId,
              content: parsed.mergedContent || fact.content,
              type: fact.type as MemoryType,
              confidence: Math.min(fact.confidence + 0.1, 0.95), // Slight confidence boost for updates
              tags: fact.tags,
            });
          } else {
            // No valid existing ID — fall back to ADD
            logWarn(
              'extraction-consolidation',
              `UPDATE decision but no valid existing_id, falling back to ADD`
            );
            result.toAdd.push({
              content: fact.content,
              type: fact.type as MemoryType,
              confidence: fact.confidence,
              tags: fact.tags,
            });
          }
          break;

        case 'DELETE':
          if (realExistingId !== null) {
            result.toDelete.push(realExistingId);
          }
          // Don't save the new fact either — the DELETE means the topic is resolved
          break;

        case 'NONE':
          result.skippedNone++;
          break;

        default:
          // Unexpected — fall back to ADD
          result.toAdd.push({
            content: fact.content,
            type: fact.type as MemoryType,
            confidence: fact.confidence,
            tags: fact.tags,
          });
      }

      logInfo(
        'extraction-consolidation',
        `Fact "${fact.content.slice(0, 60)}..." → ${parsed.decision}${realExistingId ? ` (mem #${realExistingId})` : ''}: ${parsed.reason}`
      );
    } catch (err) {
      // Unexpected error for this fact — fall back to ADD so we don't lose it
      logWarn(
        'extraction-consolidation',
        `Error consolidating fact, falling back to ADD: ${getErrorMessage(err)}`
      );
      result.fallbackAdd.push({
        content: fact.content,
        type: fact.type as MemoryType,
        confidence: fact.confidence,
        tags: fact.tags,
      });
    }
  }

  logInfo(
    'extraction-consolidation',
    `Consolidation complete: ${result.toAdd.length} ADD, ${result.toUpdate.length} UPDATE, ${result.toDelete.length} DELETE, ${result.skippedNone} NONE, ${result.fallbackAdd.length} fallback`
  );

  return result;
}

/**
 * Execute UPDATE decisions: invalidate old memory, save new one.
 * Returns the number of successfully executed updates.
 */
export async function executeUpdates(
  updates: FactToUpdate[],
  sourceType: SourceType = 'auto_extracted'
): Promise<number> {
  let executed = 0;

  for (const update of updates) {
    try {
      // Get quality score for the new content
      const qualityResult = await scoreMemory(update.content);
      const embedding = await getEmbedding(update.content);

      // Save new memory first
      const saveResult = await saveMemory(
        update.content,
        embedding,
        [...new Set([...update.tags, 'auto_extracted', 'updated'])],
        undefined,
        {
          type: update.type,
          confidence: Math.min(update.confidence, 0.9), // Cap auto-extracted updates at 0.9
          sourceType,
          qualityScore: { score: qualityResult.score, factors: qualityResult.factors },
        }
      );

      // Invalidate the old memory (mark as superseded by the new one)
      if (!saveResult.isDuplicate) {
        await invalidateMemory(update.existingMemoryId, saveResult.id, 'extraction');
        executed++;
      }
    } catch (err) {
      logWarn(
        'extraction-consolidation',
        `Failed to execute UPDATE for memory #${update.existingMemoryId}: ${getErrorMessage(err)}`
      );
    }
  }

  return executed;
}

/**
 * Execute DELETE decisions: invalidate contradicted memories.
 * Uses a synthetic superseder ID of 0 since there's no replacement.
 * Returns the number of successfully executed deletes.
 */
export async function executeDeletes(memoryIds: number[]): Promise<number> {
  let executed = 0;

  for (const memoryId of memoryIds) {
    try {
      // Verify the memory still exists before invalidating
      const existing = await getMemoryById(memoryId);
      if (existing) {
        // Invalidate with supersededById=0 as a sentinel for "contradicted, no replacement"
        await invalidateMemory(memoryId, 0, 'extraction');
        executed++;
      }
    } catch (err) {
      logWarn(
        'extraction-consolidation',
        `Failed to execute DELETE for memory #${memoryId}: ${getErrorMessage(err)}`
      );
    }
  }

  return executed;
}

/**
 * Check if extraction consolidation is enabled in config.
 */
export function isExtractionConsolidationEnabled(): boolean {
  try {
    const config = getConfig();
    return config.auto_memory?.extraction_consolidation === true;
  } catch (err) {
    logWarn(
      'extraction-consolidation',
      `Failed to check consolidation config: ${getErrorMessage(err)}`
    );
    return false;
  }
}
