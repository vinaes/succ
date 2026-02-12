/**
 * Memory Consolidation Module
 *
 * Implements memory consolidation operations for idle-time compute:
 * - Find duplicate/similar memories
 * - Merge or delete duplicates
 * - Update quality scores
 */

import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  Memory,
  deleteMemory,
  invalidateMemory,
  restoreInvalidatedMemory,
  getMemoryById,
  saveMemory,
  getMemoryLinks,
  deleteMemoryLink,
  createMemoryLink,
  LinkRelation,
  getAllMemoriesWithEmbeddings as getAllMemoriesWithEmbeddingsDb,
  deleteMemoryLinksForMemory,
  isPostgresBackend,
} from './storage/index.js';
import { cosineSimilarity, getEmbedding } from './embeddings.js';
import { getIdleReflectionConfig, getConfig, SuccConfig } from './config.js';
import { scanSensitive } from './sensitive-filter.js';
import { callLLM, getLLMConfig, type LLMBackend } from './llm.js';
import { MEMORY_MERGE_PROMPT } from '../prompts/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Worker pool configuration
const WORKER_COUNT = Math.max(1, Math.min(4, (await import('os')).cpus().length - 1));
const MIN_PAIRS_FOR_WORKERS = 1000; // Only use workers if we have enough pairs

/**
 * Candidate pair for consolidation
 */
export interface ConsolidationCandidate {
  memory1: Memory & { embedding: number[] };
  memory2: Memory & { embedding: number[] };
  similarity: number;
  action: 'merge' | 'delete_duplicate' | 'keep_both';
  reason?: string;
}

/**
 * Result of consolidation operation
 */
export interface ConsolidationResult {
  candidatesFound: number;
  merged: number;
  deleted: number;
  kept: number;
  errors: string[];
}

/**
 * Get all memories with embeddings (via dispatcher)
 */
export async function getAllMemoriesWithEmbeddings(): Promise<Array<Memory & { embedding: number[] }>> {
  const rows = await getAllMemoriesWithEmbeddingsDb({ excludeInvalidated: true });

  return rows
    .filter(row => row.embedding !== null)
    .map((row) => ({
      id: row.id,
      content: row.content,
      tags: row.tags,
      source: row.source,
      type: (row.type ?? null) as any,
      quality_score: row.quality_score,
      quality_factors: (row as any).quality_factors ?? null,
      access_count: (row as any).access_count ?? 0,
      last_accessed: (row as any).last_accessed ?? null,
      valid_from: (row as any).valid_from ?? null,
      valid_until: (row as any).valid_until ?? null,
      created_at: row.created_at,
      embedding: row.embedding as number[],
    }));
}

/**
 * Run similarity calculations in worker threads for large datasets
 */
async function runSimilarityWorkers(
  embeddings: number[][],
  pairs: Array<[number, number]>,
  threshold: number
): Promise<Array<{ i: number; j: number; similarity: number }>> {
  // Split pairs among workers
  const chunkSize = Math.ceil(pairs.length / WORKER_COUNT);
  const chunks: Array<Array<[number, number]>> = [];

  for (let i = 0; i < pairs.length; i += chunkSize) {
    chunks.push(pairs.slice(i, i + chunkSize));
  }

  // Worker path - always use compiled JS (workers don't support TS directly)
  // When running from src via tsx, __dirname points to src/lib but we need dist/lib
  const workerPath = __filename.endsWith('.ts')
    ? path.join(__dirname, '../../dist/lib/similarity-worker.js')
    : path.join(__dirname, 'similarity-worker.js');

  // Run workers in parallel
  const workerPromises = chunks.map(
    (chunk) =>
      new Promise<Array<{ i: number; j: number; similarity: number }>>((resolve, reject) => {
        const worker = new Worker(workerPath, {
          workerData: { pairs: chunk, embeddings, threshold },
        });

        worker.on('message', resolve);
        worker.on('error', reject);
        worker.on('exit', (code) => {
          if (code !== 0) {
            reject(new Error(`Worker stopped with exit code ${code}`));
          }
        });
      })
  );

  const results = await Promise.all(workerPromises);
  return results.flat();
}

/**
 * Find consolidation candidates (similar memory pairs)
 * Uses worker threads for large datasets (1000+ pairs)
 */
export async function findConsolidationCandidates(
  threshold?: number,
  maxCandidates?: number,
  options?: { skipGuards?: boolean }
): Promise<ConsolidationCandidate[]> {
  const config = getIdleReflectionConfig();
  const similarityThreshold = threshold ?? config.thresholds?.similarity_for_merge ?? 0.92;
  const limit = maxCandidates ?? config.max_memories_to_process ?? 50;
  const guards = config.consolidation_guards;

  const allMemories = await getAllMemoriesWithEmbeddings();

  // Fix 4: Minimum corpus size guard
  if (!options?.skipGuards && guards?.min_corpus_size && allMemories.length < guards.min_corpus_size) {
    return []; // Not enough memories to safely consolidate
  }

  // Fix 3: Filter out recent memories (protect young memories from consolidation)
  const minAgeDays = guards?.min_memory_age_days ?? 7;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - minAgeDays);
  const cutoffMs = cutoffDate.getTime();

  const memories = options?.skipGuards
    ? allMemories
    : allMemories.filter(m => new Date(m.created_at).getTime() < cutoffMs);

  if (memories.length < 2) {
    return []; // Need at least 2 eligible memories
  }

  // Generate all pairs
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      pairs.push([i, j]);
    }
  }

  // Decide whether to use workers or process sequentially
  let similarPairs: Array<{ i: number; j: number; similarity: number }>;

  if (pairs.length >= MIN_PAIRS_FOR_WORKERS && WORKER_COUNT > 1) {
    // Use worker threads for large datasets
    const embeddings = memories.map((m) => m.embedding);
    similarPairs = await runSimilarityWorkers(embeddings, pairs, similarityThreshold);
  } else {
    // Process sequentially for small datasets (faster due to no worker overhead)
    similarPairs = [];
    for (const [i, j] of pairs) {
      const similarity = cosineSimilarity(memories[i].embedding, memories[j].embedding);
      if (similarity >= similarityThreshold) {
        similarPairs.push({ i, j, similarity });
      }
    }
  }

  // Sort by similarity descending and take top candidates
  similarPairs.sort((a, b) => b.similarity - a.similarity);
  const topPairs = similarPairs.slice(0, limit);

  // Build candidates with action determination
  const candidates: ConsolidationCandidate[] = topPairs.map(({ i, j, similarity }) => {
    const m1 = memories[i];
    const m2 = memories[j];
    const action = determineAction(m1, m2, similarity);

    return {
      memory1: m1,
      memory2: m2,
      similarity,
      ...action,
    };
  });

  return candidates;
}

/**
 * Sequential version for backwards compatibility (no worker threads)
 * Note: now async since storage dispatcher is async.
 */
export async function findConsolidationCandidatesSync(
  threshold?: number,
  maxCandidates?: number,
  options?: { skipGuards?: boolean }
): Promise<ConsolidationCandidate[]> {
  const config = getIdleReflectionConfig();
  const similarityThreshold = threshold ?? config.thresholds?.similarity_for_merge ?? 0.92;
  const limit = maxCandidates ?? config.max_memories_to_process ?? 50;
  const guards = config.consolidation_guards;

  const allMemories = await getAllMemoriesWithEmbeddings();

  // Same guards as async version
  if (!options?.skipGuards && guards?.min_corpus_size && allMemories.length < guards.min_corpus_size) {
    return [];
  }

  const minAgeDays = guards?.min_memory_age_days ?? 7;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - minAgeDays);
  const cutoffMs = cutoffDate.getTime();

  const memories = options?.skipGuards
    ? allMemories
    : allMemories.filter(m => new Date(m.created_at).getTime() < cutoffMs);

  if (memories.length < 2) return [];

  const candidates: ConsolidationCandidate[] = [];

  for (let i = 0; i < memories.length && candidates.length < limit; i++) {
    for (let j = i + 1; j < memories.length && candidates.length < limit; j++) {
      const m1 = memories[i];
      const m2 = memories[j];

      const similarity = cosineSimilarity(m1.embedding, m2.embedding);

      if (similarity >= similarityThreshold) {
        const action = determineAction(m1, m2, similarity);
        candidates.push({
          memory1: m1,
          memory2: m2,
          similarity,
          ...action,
        });
      }
    }
  }

  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates;
}

/**
 * Determine consolidation action for a pair of memories
 */
function determineAction(
  m1: Memory & { embedding: number[] },
  m2: Memory & { embedding: number[] },
  similarity: number
): { action: 'merge' | 'delete_duplicate' | 'keep_both'; reason: string } {
  // Very high similarity (>0.95) = likely exact duplicate
  if (similarity > 0.95) {
    // Keep the one with higher quality score, or newer if scores equal
    const q1 = m1.quality_score ?? 0.5;
    const q2 = m2.quality_score ?? 0.5;

    if (Math.abs(q1 - q2) > 0.1) {
      return {
        action: 'delete_duplicate',
        reason: q1 > q2 ? `Keep #${m1.id} (quality ${q1.toFixed(2)} > ${q2.toFixed(2)})` : `Keep #${m2.id} (quality ${q2.toFixed(2)} > ${q1.toFixed(2)})`,
      };
    }

    // Same quality - keep newer
    const d1 = new Date(m1.created_at).getTime();
    const d2 = new Date(m2.created_at).getTime();
    return {
      action: 'delete_duplicate',
      reason: d1 > d2 ? `Keep #${m1.id} (newer)` : `Keep #${m2.id} (newer)`,
    };
  }

  // High similarity (0.85-0.95) = candidates for merge
  if (similarity > 0.85) {
    // Check if one is a subset of the other
    const content1Lower = m1.content.toLowerCase();
    const content2Lower = m2.content.toLowerCase();

    if (content1Lower.includes(content2Lower) || content2Lower.includes(content1Lower)) {
      // One contains the other - keep the longer one
      return {
        action: 'delete_duplicate',
        reason: m1.content.length > m2.content.length
          ? `Keep #${m1.id} (more detailed)`
          : `Keep #${m2.id} (more detailed)`,
      };
    }

    // Both have unique content - merge
    return {
      action: 'merge',
      reason: 'Both have unique information',
    };
  }

  // Lower similarity - keep both but maybe link them
  return {
    action: 'keep_both',
    reason: 'Different enough to keep separate',
  };
}

/**
 * Execute consolidation on candidates
 * Returns summary of actions taken
 */
export async function executeConsolidation(
  candidates: ConsolidationCandidate[],
  options: {
    dryRun?: boolean;
    mergeWithLLM?: boolean;
    llmOptions?: LLMMergeOptions;
    onProgress?: (current: number, total: number, action: string) => void;
  } = {}
): Promise<ConsolidationResult> {
  const { dryRun = false, mergeWithLLM = false, llmOptions, onProgress } = options;

  const result: ConsolidationResult = {
    candidatesFound: candidates.length,
    merged: 0,
    deleted: 0,
    kept: 0,
    errors: [],
  };

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];

    try {
      onProgress?.(i + 1, candidates.length, candidate.action);

      if (candidate.action === 'delete_duplicate') {
        if (!dryRun) {
          // Determine which to invalidate
          const keepId = candidate.reason?.includes(`#${candidate.memory1.id}`)
            ? candidate.memory1.id
            : candidate.memory2.id;
          const invalidateId = keepId === candidate.memory1.id
            ? candidate.memory2.id
            : candidate.memory1.id;

          // Transfer links before invalidation
          await transferLinks(invalidateId, keepId);

          // Create supersedes link for revision tracking
          try {
            createMemoryLink(keepId, invalidateId, 'supersedes', 1.0);
          } catch {
            // Link may already exist
          }

          // Soft-invalidate instead of hard delete
          invalidateMemory(invalidateId, keepId);
        }
        result.deleted++;
      } else if (candidate.action === 'merge') {
        if (!dryRun) {
          const mergeResult = await mergeMemories(candidate.memory1, candidate.memory2, mergeWithLLM, llmOptions);
          if (mergeResult === null) {
            // Merge was skipped (no LLM or LLM failed) — kept both with link
            result.kept++;
            continue;
          }
        }
        result.merged++;
      } else {
        // keep_both - optionally create a link between them
        if (!dryRun) {
          createMemoryLink(
            candidate.memory1.id,
            candidate.memory2.id,
            'similar_to',
            candidate.similarity
          );
        }
        result.kept++;
      }
    } catch (error) {
      result.errors.push(
        `Error processing pair (${candidate.memory1.id}, ${candidate.memory2.id}): ${error}`
      );
    }
  }

  return result;
}

/**
 * Transfer links from one memory to another before deletion
 */
async function transferLinks(fromId: number, toId: number): Promise<void> {
  const links = await getMemoryLinks(fromId);

  // Transfer outgoing links
  for (const link of links.outgoing) {
    if (link.target_id !== toId) {
      try {
        createMemoryLink(toId, link.target_id, link.relation as LinkRelation, link.weight);
      } catch {
        // Link may already exist
      }
    }
  }

  // Transfer incoming links
  for (const link of links.incoming) {
    if (link.source_id !== toId) {
      try {
        createMemoryLink(link.source_id, toId, link.relation as LinkRelation, link.weight);
      } catch {
        // Link may already exist
      }
    }
  }
}

/**
 * Undo a consolidation operation by restoring original memories
 * and removing the merged result.
 */
export async function undoConsolidation(mergedMemoryId: number): Promise<{
  restored: number[];
  deletedMerge: boolean;
  errors: string[];
}> {
  const errors: string[] = [];
  const restored: number[] = [];

  // Find superseded links via dispatcher's getMemoryLinks
  const links = await getMemoryLinks(mergedMemoryId);
  const supersededLinks = links.outgoing.filter((l: any) => l.relation === 'supersedes');

  if (supersededLinks.length === 0) {
    return { restored: [], deletedMerge: false, errors: ['No supersedes links found — not a consolidation result'] };
  }

  let deletedMerge = false;

  // 1. Restore each original memory
  for (const { target_id } of supersededLinks) {
    const success = await restoreInvalidatedMemory(target_id);
    if (success) {
      restored.push(target_id);
    } else {
      errors.push(`Failed to restore memory #${target_id} (may not be invalidated)`);
    }
  }

  // 2. Remove supersedes links
  for (const { target_id } of supersededLinks) {
    await deleteMemoryLink(mergedMemoryId, target_id, 'supersedes');
  }

  // 3. If the merged memory was synthetic (created by consolidation), hard-delete it
  const merged = await getMemoryById(mergedMemoryId);
  if (merged?.source === 'consolidation-llm') {
    await deleteMemory(mergedMemoryId);
    deletedMerge = true;
  }
  // If source != 'consolidation-llm', this was a keep-one-invalidate-other (delete_duplicate),
  // so we keep the "winner" memory alive

  return { restored, deletedMerge, errors };
}

// ============================================================================
// LLM-based Memory Merge
// ============================================================================

/**
 * LLM merge configuration options
 */
export interface LLMMergeOptions {
  mode: 'claude' | 'local' | 'openrouter';
  model?: string;
  apiUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * Merge two memory contents using LLM
 * Uses the shared LLM module for backend flexibility.
 */
export async function llmMergeContent(
  content1: string,
  content2: string,
  options: LLMMergeOptions
): Promise<string | null> {
  const prompt = MEMORY_MERGE_PROMPT.replace('{memory1}', content1).replace('{memory2}', content2);

  // Map legacy mode to new backend
  const backend: LLMBackend = options.mode;

  // Build config override
  const configOverride: Parameters<typeof callLLM>[2] = { backend };

  if (options.model) {
    if (backend === 'claude') {
      configOverride.model = options.model;
    } else if (backend === 'openrouter') {
      configOverride.openrouterModel = options.model;
    } else if (backend === 'local') {
      configOverride.model = options.model;
    }
  }

  if (options.apiUrl) {
    configOverride.localEndpoint = options.apiUrl;
  }

  try {
    // Use sleep agent for background consolidation if enabled
    const result = await callLLM(
      prompt,
      { timeout: options.timeoutMs || 30000, maxTokens: 500, useSleepAgent: true },
      configOverride
    );
    return result?.trim() || null;
  } catch (error) {
    console.warn(`[consolidate] LLM merge failed (${backend}):`, error);
    return null;
  }
}

/**
 * Get LLM merge options from config
 */
export function getLLMMergeOptionsFromConfig(): LLMMergeOptions {
  const config = getConfig();
  const reflectionConfig = getIdleReflectionConfig();

  // Check if sleep agent is configured for memory consolidation
  const sleepAgent = reflectionConfig.sleep_agent;
  if (sleepAgent?.enabled && sleepAgent.handle_operations?.memory_consolidation) {
    if (sleepAgent.mode === 'local' && sleepAgent.api_url && sleepAgent.model) {
      return {
        mode: 'local',
        model: sleepAgent.model,
        apiUrl: sleepAgent.api_url,
      };
    } else if (sleepAgent.mode === 'openrouter') {
      return {
        mode: 'openrouter',
        model: sleepAgent.model || 'anthropic/claude-3-haiku',
        apiKey: sleepAgent.api_key || config.openrouter_api_key,
      };
    }
  }

  // Check analyze mode settings
  if (config.analyze_mode === 'local' && config.analyze_api_url && config.analyze_model) {
    return {
      mode: 'local',
      model: config.analyze_model,
      apiUrl: config.analyze_api_url,
    };
  } else if (config.analyze_mode === 'openrouter' && config.openrouter_api_key) {
    return {
      mode: 'openrouter',
      model: config.analyze_model || 'anthropic/claude-3-haiku',
      apiKey: config.openrouter_api_key,
    };
  }

  // Default to Claude CLI with haiku
  return {
    mode: 'claude',
    model: reflectionConfig.agent_model || 'haiku',
  };
}

/**
 * Merge two memories into one
 * Supports simple merge (keep best) or LLM-based intelligent merge
 */
async function mergeMemories(
  m1: Memory & { embedding: number[] },
  m2: Memory & { embedding: number[] },
  useLLM: boolean = false,
  llmOptions?: LLMMergeOptions
): Promise<number | null> {
  const q1 = m1.quality_score ?? 0.5;
  const q2 = m2.quality_score ?? 0.5;

  if (!useLLM) {
    // Without LLM, we can't safely merge — just link them and keep both
    // This prevents silent information loss
    try {
      createMemoryLink(m1.id, m2.id, 'similar_to', 1.0);
    } catch {
      // Link may already exist
    }
    return null; // Signal: no merge happened, kept both
  }

  // LLM-based merge
  const options = llmOptions || getLLMMergeOptionsFromConfig();
  const mergedContent = await llmMergeContent(m1.content, m2.content, options);

  if (!mergedContent) {
    // LLM failed — don't delete anything, just link them
    try {
      createMemoryLink(m1.id, m2.id, 'similar_to', 1.0);
    } catch {
      // Link may already exist
    }
    return null; // Signal: no merge happened
  }

  // Check for sensitive info in merged content
  const config = getConfig();
  let finalContent = mergedContent;

  if (config.sensitive_filter_enabled !== false) {
    const scanResult = scanSensitive(mergedContent);
    if (scanResult.hasSensitive) {
      if (config.sensitive_auto_redact) {
        finalContent = scanResult.redactedText;
      } else {
        // Skip LLM merge if it contains sensitive info and auto-redact is off
        // Don't delete — just link them
        try {
          createMemoryLink(m1.id, m2.id, 'similar_to', 1.0);
        } catch {
          // Link may already exist
        }
        return null;
      }
    }
  }

  // Generate new embedding for merged content
  const newEmbedding = await getEmbedding(finalContent);

  // Merge tags from both memories
  const combinedTags = [...new Set([...m1.tags, ...m2.tags])];

  // Save new memory and soft-invalidate originals
  // Save new memory with merged content
  const saved = await saveMemory(finalContent, newEmbedding, combinedTags, 'consolidation-llm', {
    deduplicate: false, // We're consolidating, not deduping
    autoLink: true,
    qualityScore: {
      score: (q1 + q2) / 2, // Average, not max — prevent score inflation
      factors: { merged_from: 2, original_score_1: q1, original_score_2: q2 },
    },
  });

  // Transfer links from both memories to the new one
  await transferLinks(m1.id, saved.id);
  await transferLinks(m2.id, saved.id);

  // Create supersedes links for revision tracking
  try { await createMemoryLink(saved.id, m1.id, 'supersedes', 1.0); } catch { /* exists */ }
  try { await createMemoryLink(saved.id, m2.id, 'supersedes', 1.0); } catch { /* exists */ }

  // Soft-invalidate originals instead of hard delete
  await invalidateMemory(m1.id, saved.id);
  await invalidateMemory(m2.id, saved.id);

  return saved.id;
}

/**
 * Run consolidation with default settings
 */
export async function consolidateMemories(options: {
  dryRun?: boolean;
  threshold?: number;
  maxCandidates?: number;
  verbose?: boolean;
  useLLM?: boolean;
  llmOptions?: LLMMergeOptions;
  skipGuards?: boolean;
}): Promise<ConsolidationResult> {
  const { dryRun = false, threshold, maxCandidates, verbose = false, useLLM = false, llmOptions, skipGuards = false } = options;

  if (verbose) {
    console.log('Finding consolidation candidates...');
    if (!skipGuards) {
      const config = getIdleReflectionConfig();
      const guards = config.consolidation_guards;
      console.log(`Safety guards: min age ${guards?.min_memory_age_days ?? 7}d, min corpus ${guards?.min_corpus_size ?? 20}, require LLM: ${guards?.require_llm_merge ?? true}`);
    }
  }

  const candidates = await findConsolidationCandidates(threshold, maxCandidates, { skipGuards });

  if (verbose) {
    console.log(`Found ${candidates.length} candidate pairs`);

    if (candidates.length > 0) {
      console.log('\nTop candidates:');
      for (const c of candidates.slice(0, 5)) {
        console.log(
          `  [${c.action}] #${c.memory1.id} ↔ #${c.memory2.id} (similarity: ${c.similarity.toFixed(3)})`
        );
        console.log(`    ${c.reason}`);
      }
    }

    if (useLLM) {
      const mergeOpts = llmOptions || getLLMMergeOptionsFromConfig();
      console.log(`\nLLM merge enabled: ${mergeOpts.mode} (${mergeOpts.model || 'default'})`);
    }
  }

  const result = await executeConsolidation(candidates, {
    dryRun,
    mergeWithLLM: useLLM,
    llmOptions: llmOptions || (useLLM ? getLLMMergeOptionsFromConfig() : undefined),
    onProgress: verbose
      ? (current, total, action) => {
          process.stdout.write(`\rProcessing ${current}/${total}: ${action}...`);
        }
      : undefined,
  });

  if (verbose) {
    console.log('\n\nConsolidation complete:');
    console.log(`  Candidates found: ${result.candidatesFound}`);
    console.log(`  Merged: ${result.merged}${useLLM ? ' (LLM)' : ''}`);
    console.log(`  Deleted: ${result.deleted}`);
    console.log(`  Kept (linked): ${result.kept}`);
    if (result.errors.length > 0) {
      console.log(`  Errors: ${result.errors.length}`);
    }
  }

  return result;
}

/**
 * Get consolidation statistics without making changes
 */
export async function getConsolidationStats(threshold?: number): Promise<{
  totalMemories: number;
  duplicatePairs: number;
  mergeCandidates: number;
  potentialReduction: number;
}> {
  const memories = await getAllMemoriesWithEmbeddings();
  const candidates = await findConsolidationCandidates(threshold, 1000);

  const duplicates = candidates.filter((c) => c.action === 'delete_duplicate').length;
  const merges = candidates.filter((c) => c.action === 'merge').length;

  return {
    totalMemories: memories.length,
    duplicatePairs: duplicates,
    mergeCandidates: merges,
    potentialReduction: duplicates + merges,
  };
}
