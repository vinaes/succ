/**
 * Graph Centrality — degree centrality computation and recall boost
 *
 * Calculates how connected each memory is in the knowledge graph.
 * More-connected memories get boosted in recall results.
 */

import type { GraphCentralityConfig } from '../config.js';
import {
  getAllMemoryLinksForExport,
  upsertCentralityScore,
  getCentralityScores,
} from '../storage/index.js';

// ============================================================================
// Degree Centrality
// ============================================================================

/**
 * Calculate degree centrality for all memories from link data.
 * Degree = count of outgoing links + count of incoming links.
 */
export function calculateDegreeCentrality(
  links: Array<{ source_id: number; target_id: number }>
): Map<number, number> {
  const degrees = new Map<number, number>();

  for (const link of links) {
    degrees.set(link.source_id, (degrees.get(link.source_id) ?? 0) + 1);
    degrees.set(link.target_id, (degrees.get(link.target_id) ?? 0) + 1);
  }

  return degrees;
}

/**
 * Normalize centrality scores to 0-1 range.
 */
export function normalizeCentrality(raw: Map<number, number>): Map<number, number> {
  if (raw.size === 0) return new Map();

  let maxDegree = 0;
  for (const deg of raw.values()) {
    if (deg > maxDegree) maxDegree = deg;
  }

  if (maxDegree === 0) return new Map();

  const normalized = new Map<number, number>();
  for (const [id, deg] of raw) {
    normalized.set(id, deg / maxDegree);
  }
  return normalized;
}

/**
 * Compute and cache centrality scores via storage dispatcher.
 */
export async function updateCentralityCache(): Promise<{ updated: number }> {
  const links = await getAllMemoryLinksForExport();
  const raw = calculateDegreeCentrality(links);
  const normalized = normalizeCentrality(raw);

  let count = 0;
  for (const [memId, deg] of raw) {
    const norm = normalized.get(memId) ?? 0;
    await upsertCentralityScore(memId, deg, norm);
    count++;
  }

  return { updated: count };
}

/**
 * Apply centrality boost to recall results.
 * Adds boostWeight * normalized_degree to similarity score.
 */
export async function applyCentralityBoost<T extends { id?: number; similarity: number }>(
  results: T[],
  config: GraphCentralityConfig
): Promise<T[]> {
  if (!config.enabled || results.length === 0) return results;

  const boostWeight = config.boost_weight ?? 0.1;
  const memoryIds = results.filter(r => r.id != null).map(r => r.id!);
  const centralities = await getCentralityScores(memoryIds);

  const boosted = results.map(r => {
    if (r.id == null) return r;
    const c = centralities.get(r.id) ?? 0;
    return { ...r, similarity: Math.min(1.0, r.similarity + c * boostWeight) };
  });

  boosted.sort((a, b) => b.similarity - a.similarity);
  return boosted;
}
