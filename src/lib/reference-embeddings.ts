/**
 * Reference Embedding Cache — shared infrastructure for embedding-based classification.
 *
 * Registers named sets of reference phrases, lazily computes their embeddings on first use,
 * and provides max-similarity queries against cached reference sets.
 * Used by detectInvariantWithEmbedding() and estimateSpecificityByEmbedding().
 */

import { getEmbeddings, cosineSimilarity } from './embeddings.js';

export interface ReferenceSet {
  phrases: string[];
  embeddings: number[][] | null; // null until lazily computed
}

const referenceSets = new Map<string, ReferenceSet>();

/**
 * Register a named set of reference phrases.
 * Embeddings are NOT computed here — they're lazily computed on first query.
 */
export function registerReferenceSet(name: string, phrases: string[]): void {
  referenceSets.set(name, { phrases, embeddings: null });
}

/**
 * Get (or lazily compute) embeddings for a reference set.
 */
export async function getReferenceEmbeddings(name: string): Promise<number[][]> {
  const set = referenceSets.get(name);
  if (!set) throw new Error(`Reference set "${name}" not registered`);

  if (set.embeddings === null) {
    set.embeddings = await getEmbeddings(set.phrases);
  }

  return set.embeddings;
}

/**
 * Compute max cosine similarity between a content embedding and all embeddings in a reference set.
 * Returns 0 if the reference set is empty or embeddings can't be computed.
 */
export async function maxSimilarityToReference(
  embedding: number[],
  setName: string
): Promise<number> {
  try {
    const refEmbeddings = await getReferenceEmbeddings(setName);
    if (refEmbeddings.length === 0) return 0;

    let maxSim = -1;
    for (const ref of refEmbeddings) {
      try {
        const sim = cosineSimilarity(embedding, ref);
        if (sim > maxSim) maxSim = sim;
      } catch {
        // Dimension mismatch — skip this reference
      }
    }

    return maxSim > 0 ? maxSim : 0;
  } catch {
    return 0;
  }
}

/**
 * Compute average cosine similarity between a content embedding and all embeddings in a reference set.
 */
export async function avgSimilarityToReference(
  embedding: number[],
  setName: string
): Promise<number> {
  try {
    const refEmbeddings = await getReferenceEmbeddings(setName);
    if (refEmbeddings.length === 0) return 0;

    let sum = 0;
    let count = 0;
    for (const ref of refEmbeddings) {
      try {
        sum += cosineSimilarity(embedding, ref);
        count++;
      } catch {
        // Dimension mismatch — skip
      }
    }

    return count > 0 ? sum / count : 0;
  } catch {
    return 0;
  }
}

/**
 * Clear all cached reference embeddings (for tests).
 * Keeps the registered phrases — only clears computed embeddings.
 */
export function clearReferenceCache(): void {
  for (const set of referenceSets.values()) {
    set.embeddings = null;
  }
}

/**
 * Fully reset all reference sets (for tests).
 */
export function resetReferenceSets(): void {
  referenceSets.clear();
}
