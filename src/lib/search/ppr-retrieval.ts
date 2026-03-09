/**
 * PPR-Enhanced Retrieval — Graph-backed search using Personalized PageRank.
 *
 * Pipeline (HippoRAG2/ProPEX-RAG inspired):
 * 1. Embed query → find top-k semantically similar nodes
 * 2. Run PPR from those seed nodes across knowledge graph
 * 3. Expand result set with high-PPR-score neighbors
 * 4. Re-rank: (embedding_similarity * 0.5) + (ppr_score * 0.3) + (centrality * 0.2)
 * 5. Return merged, re-ranked results with rank_explain metadata
 */

import { personalizedPageRank, computePageRank } from '../graph/graphology-bridge.js';
import { getBoostFactors } from '../retrieval-feedback.js';
import { logWarn } from '../fault-logger.js';

// ============================================================================
// Types
// ============================================================================

export interface PPRSearchResult {
  memoryId: number;
  /** Combined score from all signals */
  score: number;
  /** Individual score components */
  components: {
    semantic: number;
    ppr: number;
    centrality: number;
    feedback: number;
  };
  /** Human-readable explanation of ranking */
  rankExplain: string;
}

export interface PPRSearchOptions {
  /** Weight for semantic similarity (default: 0.5) */
  semanticWeight?: number;
  /** Weight for PPR score (default: 0.3) */
  pprWeight?: number;
  /** Weight for centrality (default: 0.1) */
  centralityWeight?: number;
  /** Weight for feedback boost (default: 0.1) */
  feedbackWeight?: number;
  /** PPR damping factor (default: 0.85) */
  alpha?: number;
  /** Max results (default: 20) */
  limit?: number;
}

// ============================================================================
// PPR-Enhanced Search
// ============================================================================

/**
 * Re-rank search results using PPR, centrality, and feedback signals.
 *
 * @param semanticResults - Initial search results with memory IDs and similarity scores
 * @param options - Tuning parameters
 */
export async function pprEnhancedRerank(
  semanticResults: Array<{ memoryId: number; similarity: number }>,
  options?: PPRSearchOptions
): Promise<PPRSearchResult[]> {
  const {
    semanticWeight = 0.5,
    pprWeight = 0.3,
    centralityWeight = 0.1,
    feedbackWeight = 0.1,
    alpha = 0.85,
    limit = 20,
  } = options ?? {};

  if (semanticResults.length === 0) return [];

  // Step 1: Get PPR scores seeded from semantic results
  const seedIds = semanticResults.map((r) => r.memoryId);
  const pprScores: Map<number, number> = new Map();
  try {
    const pprResults = await personalizedPageRank(seedIds, limit * 2, alpha);
    for (const { memoryId, score } of pprResults) {
      pprScores.set(memoryId, score);
    }
  } catch (error) {
    logWarn('ppr-retrieval', 'PPR failed, using semantic-only ranking', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Step 2: Get global PageRank (centrality)
  let centralityScores: Map<number, number> = new Map();
  try {
    centralityScores = await computePageRank();
  } catch (error) {
    logWarn('ppr-retrieval', 'PageRank failed, skipping centrality', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Step 3: Get feedback boost factors
  const allIds = new Set([...seedIds, ...pprScores.keys()]);
  let feedbackFactors: Map<number, number> = new Map();
  try {
    feedbackFactors = getBoostFactors([...allIds]);
  } catch (error) {
    logWarn('ppr-retrieval', 'Feedback boost failed, skipping', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Step 4: Normalize scores (avoid spread for large maps — stack overflow risk)
  let maxSemantic = 0.001;
  for (const r of semanticResults) {
    if (r.similarity > maxSemantic) maxSemantic = r.similarity;
  }
  let maxPPR = 0.001;
  for (const v of pprScores.values()) {
    if (v > maxPPR) maxPPR = v;
  }
  let maxCentrality = 0.001;
  for (const v of centralityScores.values()) {
    if (v > maxCentrality) maxCentrality = v;
  }

  // Step 5: Merge all candidates (semantic + PPR-discovered)
  const semanticMap = new Map(semanticResults.map((r) => [r.memoryId, r.similarity]));
  const candidates = new Set([...semanticMap.keys(), ...pprScores.keys()]);

  const results: PPRSearchResult[] = [];

  for (const memoryId of candidates) {
    const semantic = (semanticMap.get(memoryId) ?? 0) / maxSemantic;
    const ppr = (pprScores.get(memoryId) ?? 0) / maxPPR;
    const centrality = (centralityScores.get(memoryId) ?? 0) / maxCentrality;
    const feedback = feedbackFactors.get(memoryId) ?? 1.0;

    // Combine scores (weights: semantic + ppr + centrality = linear blend)
    // feedbackWeight controls the strength of the multiplicative feedback modifier
    const baseScore = semantic * semanticWeight + ppr * pprWeight + centrality * centralityWeight;

    // Apply feedback as multiplicative modifier scaled by feedbackWeight
    // feedback=1.3 with feedbackWeight=0.1 → 1.0 + 0.1*(1.3-1.0) = 1.03x boost
    const feedbackModifier = feedbackWeight > 0 ? 1.0 + feedbackWeight * (feedback - 1.0) : 1.0;
    const score = baseScore * feedbackModifier;

    // Build explanation
    const parts: string[] = [];
    if (semantic > 0) parts.push(`semantic:${(semantic * semanticWeight).toFixed(3)}`);
    if (ppr > 0) parts.push(`ppr:${(ppr * pprWeight).toFixed(3)}`);
    if (centrality > 0) parts.push(`centrality:${(centrality * centralityWeight).toFixed(3)}`);
    if (feedback !== 1.0) parts.push(`feedback:${feedback.toFixed(2)}x`);

    results.push({
      memoryId,
      score,
      components: { semantic, ppr, centrality, feedback },
      rankExplain: parts.join(' + '),
    });
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit);
}
