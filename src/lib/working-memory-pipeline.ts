/**
 * Working Memory Pipeline
 *
 * Filters and scores memories for session startup context loading.
 * Implements two-phase fetch: pinned memories first, then scored recent.
 *
 * 1. Validity filtering (via isValidAt from temporal.ts)
 * 2. Pinned memories always included (correction_count >= 2 OR is_invariant)
 * 3. Remaining slots filled by priority_score (or effectiveScore fallback)
 * 4. Diversity filter removes near-duplicate embeddings (cosine > 0.85)
 * 5. Fallback to recency if scoring data is missing
 * 6. Telemetry for anomalies
 */

import { isValidAt } from './temporal.js';
import { calculateEffectiveScore } from './retention.js';
import type { MemoryForRetention } from './storage/types.js';
import { logWarn, logInfo } from './fault-logger.js';

const COMPONENT = 'working-memory';

/** Pinning threshold: memories with correction_count >= this are Tier 1 pins */
export const PIN_THRESHOLD = 2;

/** Max similarity allowed between two memories in working set */
export const DIVERSITY_THRESHOLD = 0.85;

// ============================================================================
// Type weights for priority_score formula
// ============================================================================

const TYPE_WEIGHTS: Record<string, number> = {
  decision: 1.0,
  error: 0.9,
  dead_end: 0.85,
  pattern: 0.8,
  learning: 0.7,
  observation: 0.5,
};

const BOOST_TAGS = /^(critical|architecture|security)$/i;

// ============================================================================
// Interfaces
// ============================================================================

/** Minimum fields needed from a raw memory row */
export interface WorkingMemoryCandidate {
  id: number;
  content: string;
  quality_score: number | null;
  access_count: number;
  created_at: string;
  last_accessed: string | null;
  valid_from: string | null;
  valid_until: string | null;
  correction_count: number;
  is_invariant: boolean;
  type?: string | null;
  tags?: string[] | string | null;
  priority_score?: number | null;
}

// ============================================================================
// Error class
// ============================================================================

/** Thrown when attempting to delete or invalidate a pinned (Tier 1) memory */
export class PinnedMemoryError extends Error {
  public readonly memoryId: number;
  constructor(memoryId: number) {
    super(`Memory ${memoryId} is pinned (Tier 1) and cannot be deleted or invalidated`);
    this.name = 'PinnedMemoryError';
    this.memoryId = memoryId;
  }
}

// ============================================================================
// Pure functions
// ============================================================================

/**
 * Detect if memory content contains invariant language (rules, constraints).
 * Used to auto-set is_invariant on new memories.
 * This is the fast sync path — regex only, covers 8 languages.
 */
export function detectInvariant(content: string): boolean {
  const text = content.toLowerCase().replace(/\s+/g, ' ');
  const patterns = [
    // English
    /\b(?:always|never|must|shall)\s+\w/,
    /\b(?:must not|shall not|do not|don't)\s+\w/,
    /\b(?:required|mandatory|forbidden|prohibited)\b/,
    /\b(?:critical|important)\s*:/,
    /\bnever\b.*\bwithout\b/,
    /\balways\b.*\bbefore\b/,
    // Russian
    /(?:всегда|никогда|обязательно|запрещено|нельзя|недопустимо)\s+\S/,
    /(?:нельзя|запрещено|недопустимо)(?:\s|$)/,
    /(?:должен|должна|должно|должны)\s+\S/,
    /(?:ни в коем случае|ни при каких|строго запрещ)/,
    /(?:критично|важно)\s*:/,
    // German
    /\b(?:immer|niemals|nie)\s+\w/,
    /\b(?:muss|müssen|verboten|pflicht)\b/,
    // French
    /\b(?:toujours|jamais)\s+\w/,
    /\b(?:obligatoire|interdit|défendu)\b/,
    // Spanish
    /\b(?:siempre|nunca|jamás)\s+\w/,
    /\b(?:obligatorio|prohibido|requerido)\b/,
    // Chinese
    /(?:必须|绝不|永远不|禁止|始终|一定要|不得|不允许|不可以)/,
    // Japanese
    /(?:必ず|絶対に|禁止|してはいけない|しなければならない|常に)/,
    // Korean
    /(?:반드시|절대로|금지|항상|해서는 안)/,
  ];
  return patterns.some((p) => p.test(text));
}

// ============================================================================
// Embedding-based invariant detection (language-agnostic fallback)
// ============================================================================

/**
 * Canonical invariant phrases for reference embedding similarity.
 * English only — the multilingual embedding model maps semantically similar
 * content in ANY language to nearby vectors.
 */
export const INVARIANT_REFERENCE_PHRASES = [
  'You must always do this without exception',
  'This is strictly forbidden and must never be done',
  'This is a mandatory requirement that cannot be skipped',
  'Critical rule: never violate this under any circumstances',
  'This is permanently required and shall not be changed',
  'Under no circumstances should this be modified or removed',
  'This policy is non-negotiable and applies at all times',
];

const INVARIANT_REF_SET = 'invariant-detection';
const INVARIANT_SIMILARITY_THRESHOLD = 0.55;
let _invariantRefsRegistered = false;

/**
 * Detect invariant content using embedding similarity (language-agnostic).
 * Fallback for when regex detectInvariant() misses non-covered languages.
 * Uses the content embedding that's already computed at save time — zero extra API cost.
 */
export async function detectInvariantWithEmbedding(
  content: string,
  embedding: number[]
): Promise<boolean> {
  if (embedding.length === 0) return false;

  try {
    const { registerReferenceSet, maxSimilarityToReference } =
      await import('./reference-embeddings.js');

    if (!_invariantRefsRegistered) {
      registerReferenceSet(INVARIANT_REF_SET, INVARIANT_REFERENCE_PHRASES);
      _invariantRefsRegistered = true;
    }

    const maxSim = await maxSimilarityToReference(embedding, INVARIANT_REF_SET);
    return maxSim >= INVARIANT_SIMILARITY_THRESHOLD;
  } catch {
    return false;
  }
}

/**
 * Clear cached invariant reference embeddings (for tests).
 */
export function clearInvariantEmbeddingCache(): void {
  _invariantRefsRegistered = false;
  // The actual embeddings are cleared via clearReferenceCache() from reference-embeddings.ts
}

/**
 * Check if a memory is pinned (Tier 1 working memory).
 */
export function isPinned(memory: { is_invariant: boolean; correction_count: number }): boolean {
  return memory.is_invariant || memory.correction_count >= PIN_THRESHOLD;
}

/**
 * Get the weight for a memory type. Higher = more important.
 * Tags like "critical", "architecture", "security" add a +0.1 boost.
 */
export function getTagWeight(type: string | null, tags: string[]): number {
  let weight = TYPE_WEIGHTS[type ?? 'observation'] ?? 0.5;
  if (tags.some((t) => BOOST_TAGS.test(t))) {
    weight = Math.min(weight + 0.1, 1.0);
  }
  return weight;
}

/**
 * Compute confidence-decayed quality score.
 * Quality decays exponentially based on time since last access (half-life 7 days).
 * Floor at 10% of quality_score to prevent total decay.
 */
export function computeConfidenceDecay(
  qualityScore: number | null,
  lastAccessed: string | null,
  createdAt: string,
  now: Date
): number {
  const qs = qualityScore ?? 0.5;
  const ref = lastAccessed ?? createdAt;
  const hoursSince = (now.getTime() - new Date(ref).getTime()) / 3_600_000;
  const halfLife = 168; // 7 days in hours
  const decay = Math.exp((-Math.LN2 / halfLife) * Math.max(hoursSince, 0));
  return qs * Math.max(decay, 0.1);
}

/**
 * Compute the priority_score for a memory.
 * Formula: 0.30*is_invariant + 0.25*confidence_decayed + 0.20*correction_capped
 *        + 0.15*tag_weight + 0.10*access_capped
 */
export function computePriorityScore(
  m: {
    is_invariant: boolean;
    quality_score: number | null;
    correction_count: number;
    type?: string | null;
    tags?: string[] | string | null;
    access_count: number;
    last_accessed: string | null;
    created_at: string;
  },
  now: Date
): number {
  const tags = parseTags(m.tags);
  const isInv = m.is_invariant ? 1 : 0;
  const confidence = computeConfidenceDecay(m.quality_score, m.last_accessed, m.created_at, now);
  const corrCapped = Math.min(m.correction_count, 5) / 5;
  const tagW = getTagWeight(m.type ?? null, tags);
  const accessCapped = Math.min(m.access_count, 20) / 20;
  return 0.3 * isInv + 0.25 * confidence + 0.2 * corrCapped + 0.15 * tagW + 0.1 * accessCapped;
}

/** Parse tags from various formats (string[], JSON string, null) */
function parseTags(tags: string[] | string | null | undefined): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags;
  try {
    return JSON.parse(tags);
  } catch {
    return [];
  }
}

// ============================================================================
// Cosine similarity (local copy — avoids importing embeddings.ts with heavy deps)
// ============================================================================

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ============================================================================
// Main pipeline
// ============================================================================

/**
 * Apply the working memory pipeline with two-phase fetch:
 * Phase 1: Include all pinned memories (correction_count >= 2 OR is_invariant)
 * Phase 2: Fill remaining slots with scored recent memories
 *
 * @param memories - Raw memories from backend (pre-sorted by created_at DESC)
 * @param limit - Max total memories to return
 * @param now - Current time (injectable for testing)
 * @param pinned - Pinned memories from getPinnedMemories() — may overlap with memories
 * @returns Pinned + scored memories, up to `limit`
 */
export function applyWorkingMemoryPipeline<T extends WorkingMemoryCandidate>(
  memories: T[],
  limit: number,
  now: Date = new Date(),
  pinned?: T[]
): T[] {
  const totalBefore = memories.length + (pinned?.length ?? 0);

  // Step 1: Collect and deduplicate pinned memories
  const pinnedIds = new Set<number>();
  const pinnedValid: T[] = [];

  if (pinned && pinned.length > 0) {
    for (const m of pinned) {
      if (isValidAt(m.valid_from, m.valid_until, now) && !pinnedIds.has(m.id)) {
        pinnedIds.add(m.id);
        pinnedValid.push(m);
      }
    }
  }

  // Also check memories array for any that are pinned (in case no separate fetch)
  for (const m of memories) {
    if (isPinned(m) && isValidAt(m.valid_from, m.valid_until, now) && !pinnedIds.has(m.id)) {
      pinnedIds.add(m.id);
      pinnedValid.push(m);
    }
  }

  if (pinnedValid.length > 0) {
    logInfo(COMPONENT, `${pinnedValid.length} pinned memories included (Tier 1)`, {
      pinned: pinnedValid.length,
      invariant: pinnedValid.filter((m) => m.is_invariant).length,
      corrected: pinnedValid.filter((m) => m.correction_count >= PIN_THRESHOLD).length,
    });
  }

  // If pinned already fills limit, just return them
  if (pinnedValid.length >= limit) {
    return pinnedValid.slice(0, limit);
  }

  // Step 2: Filter remaining memories by validity, excluding already-pinned
  const remainingSlots = limit - pinnedValid.length;
  const candidates = memories.filter(
    (m) => !pinnedIds.has(m.id) && isValidAt(m.valid_from, m.valid_until, now)
  );

  const pinnedFromMemories = memories.filter((m) => pinnedIds.has(m.id)).length;
  const filteredOut = memories.length - candidates.length - pinnedFromMemories;
  const filteredPercent = memories.length > 0 ? (filteredOut / memories.length) * 100 : 0;

  if (filteredPercent > 10) {
    logInfo(
      COMPONENT,
      `Validity filter removed ${filteredOut}/${memories.length} candidates (${filteredPercent.toFixed(1)}%)`,
      { total: memories.length, filtered: filteredOut }
    );
  }

  if (candidates.length === 0) {
    if (pinnedValid.length > 0) return pinnedValid;
    if (totalBefore > 0) {
      logWarn(COMPONENT, 'Pipeline returned 0 memories from non-empty input', {
        totalBefore,
        afterValidity: 0,
      });
    }
    return [];
  }

  // Step 3: Score and rank remaining candidates
  // Use priority_score if available, otherwise fall back to effectiveScore
  const hasAnyScore = candidates.some((m) => m.priority_score != null || m.quality_score !== null);

  if (!hasAnyScore) {
    logWarn(COMPONENT, 'All candidates lack quality_score — falling back to recency order', {
      count: candidates.length,
    });
    return [...pinnedValid, ...candidates.slice(0, remainingSlots)];
  }

  const scored = candidates.map((m) => {
    // Prefer precomputed priority_score
    if (m.priority_score != null) {
      return { memory: m, score: m.priority_score };
    }
    // Fallback to calculateEffectiveScore
    const retentionInput: MemoryForRetention = {
      id: m.id,
      content: m.content,
      quality_score: m.quality_score,
      access_count: m.access_count,
      created_at: m.created_at,
      last_accessed: m.last_accessed,
    };
    try {
      const result = calculateEffectiveScore(retentionInput);
      return { memory: m, score: result.effectiveScore };
    } catch {
      return { memory: m, score: 0 };
    }
  });

  scored.sort((a, b) => b.score - a.score);

  return [...pinnedValid, ...scored.slice(0, remainingSlots).map((s) => s.memory)];
}

// ============================================================================
// Diversity filter (async — uses embeddings)
// ============================================================================

/**
 * Remove near-duplicate memories based on embedding cosine similarity.
 * Greedy: iterate in order, skip if too similar to any already-selected.
 *
 * @param memories - Scored memories (order matters — higher priority first)
 * @param getEmbeddings - Async function to fetch embeddings by IDs
 * @param maxSimilarity - Threshold above which items are considered duplicates
 * @returns Deduplicated list preserving original order
 */
export async function applyDiversityFilter<T extends { id: number }>(
  memories: T[],
  getEmbeddings: (ids: number[]) => Promise<Map<number, number[]>>,
  maxSimilarity: number = DIVERSITY_THRESHOLD
): Promise<T[]> {
  if (memories.length <= 1) return memories;

  const embeddings = await getEmbeddings(memories.map((m) => m.id));
  if (embeddings.size === 0) return memories;

  const selected: T[] = [];
  const selectedEmbeddings: number[][] = [];

  for (const m of memories) {
    const emb = embeddings.get(m.id);
    if (!emb) {
      // Keep items without embeddings (can't compare)
      selected.push(m);
      continue;
    }

    const tooSimilar = selectedEmbeddings.some(
      (sEmb) => cosineSimilarity(emb, sEmb) > maxSimilarity
    );

    if (!tooSimilar) {
      selected.push(m);
      selectedEmbeddings.push(emb);
    }
  }

  return selected;
}
