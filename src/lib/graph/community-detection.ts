/**
 * Community Detection — Label Propagation Algorithm
 *
 * Automatically groups memories into thematic communities
 * based on graph structure. Pure TypeScript, no external deps.
 *
 * Inspired by rahulnyk/knowledge_graph's Girvan-Newman approach,
 * but using Label Propagation which is faster and simpler.
 */

import {
  getAllMemoryLinksForExport,
  getAllMemoriesForExport,
  updateMemoryTags,
} from '../storage/index.js';

import { logWarn } from '../fault-logger.js';
// ============================================================================
// Adjacency List
// ============================================================================

/**
 * Build adjacency list from memory_links table.
 * Returns undirected graph: each edge appears in both directions.
 */
export function buildAdjacencyList(
  links: Array<{ source_id: number; target_id: number; weight: number }>
): Map<number, Array<{ neighbor: number; weight: number }>> {
  const adj = new Map<number, Array<{ neighbor: number; weight: number }>>();

  const addEdge = (from: number, to: number, weight: number) => {
    const neighbors = adj.get(from) ?? [];
    neighbors.push({ neighbor: to, weight });
    adj.set(from, neighbors);
  };

  for (const link of links) {
    addEdge(link.source_id, link.target_id, link.weight);
    addEdge(link.target_id, link.source_id, link.weight);
  }

  return adj;
}

// ============================================================================
// Label Propagation
// ============================================================================

/**
 * Seeded random number generator (Mulberry32).
 * Provides deterministic shuffling for reproducible results.
 */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Shuffle array in-place using Fisher-Yates with seeded RNG.
 */
function shuffleArray<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * Label Propagation Algorithm.
 *
 * 1. Each node gets its own ID as label
 * 2. Iteratively: each node adopts the most frequent weighted label of its neighbors
 * 3. Converges when no labels change
 *
 * @returns Object with labels (nodeId → communityId) and actual iteration count
 */
export function labelPropagation(
  adjacency: Map<number, Array<{ neighbor: number; weight: number }>>,
  maxIterations: number = 100,
  seed: number = 42
): { labels: Map<number, number>; iterations: number } {
  const rng = mulberry32(seed);

  // Initialize: each node is its own community
  const labels = new Map<number, number>();
  const nodes = Array.from(adjacency.keys());
  for (const node of nodes) {
    labels.set(node, node);
  }

  let actualIterations = 0;
  for (let iter = 0; iter < maxIterations; iter++) {
    actualIterations = iter + 1;
    let changed = false;

    // Shuffle nodes for randomized order
    shuffleArray(nodes, rng);

    for (const node of nodes) {
      const neighbors = adjacency.get(node);
      if (!neighbors || neighbors.length === 0) continue;

      // Count weighted labels of neighbors
      const labelWeights = new Map<number, number>();
      for (const { neighbor, weight } of neighbors) {
        const neighborLabel = labels.get(neighbor)!;
        labelWeights.set(neighborLabel, (labelWeights.get(neighborLabel) ?? 0) + weight);
      }

      // Find label with highest weight
      let bestLabel = labels.get(node)!;
      let bestWeight = -1;
      for (const [label, weight] of labelWeights) {
        if (weight > bestWeight || (weight === bestWeight && rng() > 0.5)) {
          bestLabel = label;
          bestWeight = weight;
        }
      }

      if (bestLabel !== labels.get(node)) {
        labels.set(node, bestLabel);
        changed = true;
      }
    }

    // Converged
    if (!changed) break;
  }

  return { labels, iterations: actualIterations };
}

/**
 * Renumber communities from 0..N for clean output.
 */
export function renumberCommunities(labels: Map<number, number>): Map<number, number> {
  const labelToId = new Map<number, number>();
  let nextId = 0;

  const renumbered = new Map<number, number>();
  for (const [node, label] of labels) {
    if (!labelToId.has(label)) {
      labelToId.set(label, nextId++);
    }
    renumbered.set(node, labelToId.get(label)!);
  }

  return renumbered;
}

// ============================================================================
// Full Pipeline
// ============================================================================

export interface CommunityResult {
  communities: Array<{ id: number; size: number; members: number[] }>;
  isolated: number;
  iterations: number;
}

/**
 * Detect communities using Label Propagation Algorithm.
 * Updates memory tags with community:N assignments.
 * Exported for testing; prefer `detectCommunities()` which tries Louvain first.
 */
export async function detectCommunitiesLP(
  options: { maxIterations?: number; minCommunitySize?: number; tagPrefix?: string } = {}
): Promise<CommunityResult> {
  const { maxIterations = 100, minCommunitySize = 2, tagPrefix = 'community' } = options;

  // Get all links via storage abstraction
  const links = await getAllMemoryLinksForExport();

  if (links.length === 0) {
    // Clear any stale community tags from a previous run
    await applyCommunityTags([], tagPrefix);
    return { communities: [], isolated: 0, iterations: 0 };
  }

  // Build adjacency list
  const adjacency = buildAdjacencyList(links);

  // Run Label Propagation
  const lpResult = labelPropagation(adjacency, maxIterations);
  const labels = renumberCommunities(lpResult.labels);

  // Group by community
  const communityMap = new Map<number, number[]>();
  for (const [nodeId, communityId] of labels) {
    const members = communityMap.get(communityId) ?? [];
    members.push(nodeId);
    communityMap.set(communityId, members);
  }

  // Build result, filtering by min size
  const communities: Array<{ id: number; size: number; members: number[] }> = [];
  let isolated = 0;

  for (const [id, members] of communityMap) {
    if (members.length < minCommunitySize) {
      isolated += members.length;
    } else {
      communities.push({ id, size: members.length, members: members.sort((a, b) => a - b) });
    }
  }

  communities.sort((a, b) => b.size - a.size);

  // Update memory tags: remove old community tags, add new ones
  const tagPattern = `${tagPrefix}:`;
  const allMemories = await getAllMemoriesForExport();
  const memoryTagMap = new Map<number, string[]>();
  for (const mem of allMemories) {
    const tags = Array.isArray(mem.tags)
      ? mem.tags
      : typeof mem.tags === 'string'
        ? (() => {
            try {
              return JSON.parse(mem.tags);
            } catch (error) {
              logWarn(
                'community-detection',
                'Failed to parse memory tags JSON string for community assignment',
                {
                  error: error instanceof Error ? error.message : String(error),
                }
              );
              return [];
            }
          })()
        : [];
    memoryTagMap.set(mem.id, tags);
  }

  const BATCH_SIZE = 50;
  // Use all memories (not just labels.keys()) so memories that dropped out of the
  // LP graph (no remaining edges or filtered by minCommunitySize) have their old
  // community tags cleared — matching Louvain's behaviour of retagging every memory.
  const memIds = allMemories.map((mem) => mem.id);
  for (let i = 0; i < memIds.length; i += BATCH_SIZE) {
    const batch = memIds.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map((memId) => {
        let tags = memoryTagMap.get(memId) ?? [];

        // Remove old community tags
        tags = tags.filter((t: string) => !t.startsWith(tagPattern));

        // Add new community tag (only if community is large enough)
        const communityId = labels.get(memId);
        if (communityId != null) {
          const members = communityMap.get(communityId);
          if (members && members.length >= minCommunitySize) {
            tags.push(`${tagPrefix}:${communityId}`);
          }
        }

        return updateMemoryTags(memId, tags);
      })
    );
  }

  return { communities, isolated, iterations: lpResult.iterations };
}

/**
 * Detect communities in the memory graph.
 * Tries Louvain modularity optimization first (higher quality); falls back to
 * Label Propagation if graphology is unavailable.
 * Updates memory tags with community:N assignments.
 */
export async function detectCommunities(
  options: { maxIterations?: number; minCommunitySize?: number; tagPrefix?: string } = {}
): Promise<CommunityResult> {
  const { minCommunitySize = 2, tagPrefix = 'community' } = options;

  let detectLouvain: (typeof import('./graphology-bridge.js'))['detectLouvainCommunities'];
  try {
    ({ detectLouvainCommunities: detectLouvain } = await import('./graphology-bridge.js'));
  } catch (err) {
    logWarn('community-detection', 'Louvain unavailable, falling back to Label Propagation', {
      error: err instanceof Error ? err.message : String(err),
    });
    return detectCommunitiesLP(options);
  }

  const louvainResult = await detectLouvain(minCommunitySize);

  // Apply community tags (same as LP path) so Louvain results are persisted
  await applyCommunityTags(louvainResult.communities, tagPrefix);

  // Map LouvainCommunity[] to CommunityResult format
  return {
    communities: louvainResult.communities.map((c) => ({
      id: c.id,
      size: c.size,
      members: c.members,
    })),
    isolated: louvainResult.isolated,
    iterations: 1, // Louvain converges internally; report 1 pass
  };
}

/**
 * Apply community tags to memories based on detection results.
 * Removes old tags with the given prefix and adds new ones.
 */
async function applyCommunityTags(
  communities: Array<{ id: number; members: number[] }>,
  tagPrefix: string
): Promise<void> {
  const tagPattern = `${tagPrefix}:`;
  const allMemories = await getAllMemoriesForExport();

  // Build a member→community lookup
  const memberToCommunity = new Map<number, number>();
  for (const c of communities) {
    for (const memId of c.members) {
      memberToCommunity.set(memId, c.id);
    }
  }

  const BATCH_SIZE = 50;
  for (let i = 0; i < allMemories.length; i += BATCH_SIZE) {
    const batch = allMemories.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map((mem) => {
        const communityId = memberToCommunity.get(mem.id);
        let tags = Array.isArray(mem.tags)
          ? mem.tags
          : typeof mem.tags === 'string'
            ? (() => {
                try {
                  return JSON.parse(mem.tags);
                } catch (error) {
                  logWarn(
                    'community-detection',
                    'Failed to parse memory tags in applyCommunityTags',
                    {
                      error: error instanceof Error ? error.message : String(error),
                    }
                  );
                  return [];
                }
              })()
            : [];

        // Remove old community tags
        const oldLen = tags.length;
        tags = tags.filter((t: string) => !t.startsWith(tagPattern));

        // Add new community tag if assigned
        if (communityId != null) {
          tags.push(`${tagPrefix}:${communityId}`);
        }

        // Only write if tags actually changed
        if (tags.length !== oldLen || communityId != null) {
          return updateMemoryTags(mem.id, tags);
        }
        return Promise.resolve();
      })
    );
  }
}

/**
 * Get community assignment for a specific memory from its tags.
 */
export async function getMemoryCommunity(
  memoryId: number,
  tagPrefix: string = 'community'
): Promise<number | null> {
  const { getMemoryById } = await import('../storage/index.js');
  const mem = await getMemoryById(memoryId);
  if (!mem) return null;

  const tags: string[] = Array.isArray(mem.tags)
    ? mem.tags
    : typeof mem.tags === 'string'
      ? (() => {
          try {
            return JSON.parse(mem.tags as string);
          } catch (error) {
            logWarn(
              'community-detection',
              'Failed to parse memory tags JSON string for community lookup',
              {
                error: error instanceof Error ? error.message : String(error),
              }
            );
            return [];
          }
        })()
      : [];

  const prefix = `${tagPrefix}:`;
  const communityTag = tags.find((t: string) => t.startsWith(prefix));
  if (!communityTag) return null;
  return parseInt(communityTag.slice(prefix.length), 10);
}
