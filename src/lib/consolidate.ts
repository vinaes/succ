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
  getDb,
  Memory,
  deleteMemory,
  getMemoryById,
  saveMemory,
  getMemoryLinks,
  deleteMemoryLink,
  createMemoryLink,
  LinkRelation,
} from './db.js';
import { cosineSimilarity } from './embeddings.js';
import { getIdleReflectionConfig, getConfig } from './config.js';
import { scanSensitive } from './sensitive-filter.js';

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
 * Get all memories with embeddings
 */
export function getAllMemoriesWithEmbeddings(): Array<Memory & { embedding: number[] }> {
  const database = getDb();

  const rows = database
    .prepare(
      `SELECT id, content, tags, source, quality_score, quality_factors, access_count, last_accessed, valid_from, valid_until, created_at, embedding
       FROM memories`
    )
    .all() as Array<{
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    quality_score: number | null;
    quality_factors: string | null;
    access_count: number | null;
    last_accessed: string | null;
    valid_from: string | null;
    valid_until: string | null;
    created_at: string;
    embedding: Buffer;
  }>;

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    tags: row.tags ? JSON.parse(row.tags) : [],
    source: row.source,
    quality_score: row.quality_score,
    quality_factors: row.quality_factors ? JSON.parse(row.quality_factors) : null,
    access_count: row.access_count ?? 0,
    last_accessed: row.last_accessed,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    created_at: row.created_at,
    embedding: bufferToFloatArray(row.embedding),
  }));
}

/**
 * Convert Buffer to number array (Float32)
 */
function bufferToFloatArray(buffer: Buffer): number[] {
  const aligned = Buffer.from(buffer);
  const floatArray = new Float32Array(
    aligned.buffer,
    aligned.byteOffset,
    aligned.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
  return Array.from(floatArray);
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
  maxCandidates?: number
): Promise<ConsolidationCandidate[]> {
  const config = getIdleReflectionConfig();
  const similarityThreshold = threshold ?? config.thresholds?.similarity_for_merge ?? 0.85;
  const limit = maxCandidates ?? config.max_memories_to_process ?? 50;

  const memories = getAllMemoriesWithEmbeddings();

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
 * Sync version for backwards compatibility (uses sequential processing)
 */
export function findConsolidationCandidatesSync(
  threshold?: number,
  maxCandidates?: number
): ConsolidationCandidate[] {
  const config = getIdleReflectionConfig();
  const similarityThreshold = threshold ?? config.thresholds?.similarity_for_merge ?? 0.85;
  const limit = maxCandidates ?? config.max_memories_to_process ?? 50;

  const memories = getAllMemoriesWithEmbeddings();
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
    onProgress?: (current: number, total: number, action: string) => void;
  } = {}
): Promise<ConsolidationResult> {
  const { dryRun = false, mergeWithLLM = false, onProgress } = options;

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
          // Determine which to delete
          const keepId = candidate.reason?.includes(`#${candidate.memory1.id}`)
            ? candidate.memory1.id
            : candidate.memory2.id;
          const deleteId = keepId === candidate.memory1.id
            ? candidate.memory2.id
            : candidate.memory1.id;

          // Transfer links before deletion
          transferLinks(deleteId, keepId);

          // Delete the duplicate
          deleteMemory(deleteId);
        }
        result.deleted++;
      } else if (candidate.action === 'merge') {
        if (!dryRun) {
          if (mergeWithLLM) {
            // TODO: Use LLM to merge content intelligently
            // For now, just concatenate
            await mergeMemories(candidate.memory1, candidate.memory2);
          } else {
            // Simple merge: keep higher quality, delete other
            const q1 = candidate.memory1.quality_score ?? 0.5;
            const q2 = candidate.memory2.quality_score ?? 0.5;
            const keepId = q1 >= q2 ? candidate.memory1.id : candidate.memory2.id;
            const deleteId = q1 >= q2 ? candidate.memory2.id : candidate.memory1.id;

            transferLinks(deleteId, keepId);
            deleteMemory(deleteId);
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
function transferLinks(fromId: number, toId: number): void {
  const links = getMemoryLinks(fromId);

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
 * Merge two memories into one (simple concatenation)
 * TODO: Add LLM-based intelligent merging
 * NOTE: When implementing LLM merge, use scanSensitive() to check merged content
 *       before saving. If sensitive_auto_redact is true, redact; otherwise skip.
 */
async function mergeMemories(
  m1: Memory & { embedding: number[] },
  m2: Memory & { embedding: number[] }
): Promise<number> {
  // Simple strategy: keep the one with higher quality, delete the other
  // No new content is created, so sensitive filter not needed here
  const q1 = m1.quality_score ?? 0.5;
  const q2 = m2.quality_score ?? 0.5;

  const keep = q1 >= q2 ? m1 : m2;
  const merge = q1 >= q2 ? m2 : m1;

  // For now, just transfer links and delete the lower quality one
  transferLinks(merge.id, keep.id);
  deleteMemory(merge.id);

  return keep.id;
}

/**
 * Run consolidation with default settings
 */
export async function consolidateMemories(options: {
  dryRun?: boolean;
  threshold?: number;
  maxCandidates?: number;
  verbose?: boolean;
}): Promise<ConsolidationResult> {
  const { dryRun = false, threshold, maxCandidates, verbose = false } = options;

  if (verbose) {
    console.log('Finding consolidation candidates...');
  }

  const candidates = await findConsolidationCandidates(threshold, maxCandidates);

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
  }

  const result = await executeConsolidation(candidates, {
    dryRun,
    onProgress: verbose
      ? (current, total, action) => {
          process.stdout.write(`\rProcessing ${current}/${total}: ${action}...`);
        }
      : undefined,
  });

  if (verbose) {
    console.log('\n\nConsolidation complete:');
    console.log(`  Candidates found: ${result.candidatesFound}`);
    console.log(`  Merged: ${result.merged}`);
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
  const memories = getAllMemoriesWithEmbeddings();
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
