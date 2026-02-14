/**
 * Maximal Marginal Relevance (MMR) diversity reranking.
 *
 * Re-ranks search results to balance relevance and diversity,
 * reducing near-duplicate results in recall output.
 *
 * Formula: MMR(d) = λ * sim(q, d) - (1 - λ) * max(sim(d, d_selected))
 *
 * λ = 1.0: pure relevance (no diversity penalty)
 * λ = 0.0: pure diversity (maximum distance from selected)
 * λ = 0.8: conservative default — relevance dominates, mild diversity
 */

/**
 * Cosine similarity between two vectors.
 * Returns value in [-1, 1], typically [0, 1] for normalized embeddings.
 */
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

export interface MMRItem {
  id: number;
  similarity: number;
  embedding?: number[] | null;
  [key: string]: unknown;
}

/**
 * Apply MMR reranking to search results.
 *
 * @param results - Search results with similarity scores and optional embeddings
 * @param queryEmbedding - The query embedding vector
 * @param lambda - Balance between relevance (1.0) and diversity (0.0). Default: 0.8
 * @param limit - Max results to return. Default: results.length
 * @returns Reranked results with updated similarity scores
 */
export function applyMMR<T extends MMRItem>(
  results: T[],
  queryEmbedding: number[],
  lambda: number = 0.8,
  limit?: number
): T[] {
  // Nothing to rerank
  if (results.length <= 1) return results;

  // Filter to results that have embeddings — skip those without
  const withEmbedding = results.filter((r) => r.embedding && r.embedding.length > 0);
  const withoutEmbedding = results.filter((r) => !r.embedding || r.embedding.length === 0);

  if (withEmbedding.length === 0) return results;

  const maxResults = limit ?? results.length;
  const selected: T[] = [];
  const candidates = [...withEmbedding];

  // Greedily select items using MMR criterion
  while (selected.length < maxResults && candidates.length > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const relevance = candidate.similarity;

      // Max similarity to any already-selected item
      let maxSimToSelected = 0;
      if (selected.length > 0 && candidate.embedding) {
        for (const sel of selected) {
          if (sel.embedding) {
            const sim = cosineSimilarity(candidate.embedding, sel.embedding);
            if (sim > maxSimToSelected) maxSimToSelected = sim;
          }
        }
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSimToSelected;

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      const item = candidates.splice(bestIdx, 1)[0];
      // Update similarity to reflect MMR score for consistent sorting downstream
      selected.push({ ...item, similarity: bestScore });
    } else {
      break;
    }
  }

  // Append items without embeddings at the end (they couldn't be MMR-ranked)
  const result = [...selected, ...withoutEmbedding].slice(0, maxResults);
  return result;
}
