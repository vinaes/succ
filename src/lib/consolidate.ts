/**
 * Memory Consolidation Module
 *
 * Implements memory consolidation operations for idle-time compute:
 * - Find duplicate/similar memories
 * - Merge or delete duplicates
 * - Update quality scores
 */

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
      `SELECT id, content, tags, source, quality_score, quality_factors, created_at, embedding
       FROM memories`
    )
    .all() as Array<{
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    quality_score: number | null;
    quality_factors: string | null;
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
 * Find consolidation candidates (similar memory pairs)
 */
export function findConsolidationCandidates(
  threshold?: number,
  maxCandidates?: number
): ConsolidationCandidate[] {
  const config = getIdleReflectionConfig();
  const similarityThreshold = threshold ?? config.thresholds?.similarity_for_merge ?? 0.85;
  const limit = maxCandidates ?? config.max_memories_to_process ?? 50;

  const memories = getAllMemoriesWithEmbeddings();
  const candidates: ConsolidationCandidate[] = [];
  const processed = new Set<string>();

  for (let i = 0; i < memories.length && candidates.length < limit; i++) {
    for (let j = i + 1; j < memories.length && candidates.length < limit; j++) {
      const m1 = memories[i];
      const m2 = memories[j];

      // Skip if already processed this pair
      const pairKey = `${Math.min(m1.id, m2.id)}-${Math.max(m1.id, m2.id)}`;
      if (processed.has(pairKey)) continue;
      processed.add(pairKey);

      const similarity = cosineSimilarity(m1.embedding, m2.embedding);

      if (similarity >= similarityThreshold) {
        // Determine action based on content and quality
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

  // Sort by similarity descending (most similar first)
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

  const candidates = findConsolidationCandidates(threshold, maxCandidates);

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
export function getConsolidationStats(threshold?: number): {
  totalMemories: number;
  duplicatePairs: number;
  mergeCandidates: number;
  potentialReduction: number;
} {
  const memories = getAllMemoriesWithEmbeddings();
  const candidates = findConsolidationCandidates(threshold, 1000);

  const duplicates = candidates.filter((c) => c.action === 'delete_duplicate').length;
  const merges = candidates.filter((c) => c.action === 'merge').length;

  return {
    totalMemories: memories.length,
    duplicatePairs: duplicates,
    mergeCandidates: merges,
    potentialReduction: duplicates + merges,
  };
}
