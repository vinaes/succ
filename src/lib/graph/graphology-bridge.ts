/**
 * graphology integration for advanced graph algorithms.
 *
 * Provides: Personalized PageRank, Louvain communities, Dijkstra shortest path,
 * articulation points, betweenness centrality, and PageRank.
 *
 * Loads memory links from StorageBackend into an in-memory graphology graph,
 * runs algorithms, and returns results. Graph is cached and invalidated
 * when links change.
 */

import Graph, { DirectedGraph } from 'graphology';
import louvain from 'graphology-communities-louvain';
import pagerank from 'graphology-metrics/centrality/pagerank.js';
import betweennessCentrality from 'graphology-metrics/centrality/betweenness.js';
import { bidirectional as dijkstraBidirectional } from 'graphology-shortest-path/dijkstra.js';
import { getAllMemoryLinksForExport, getAllMemoriesForExport } from '../storage/index.js';
import { getProjectRoot } from '../config.js';
import { logInfo, logWarn } from '../fault-logger.js';

// ============================================================================
// Graph Cache
// ============================================================================

interface GraphCacheEntry {
  graph: Graph;
  timestamp: number;
}

// Cache keyed by project root path so different projects never share a cached graph.
const graphCache = new Map<string, GraphCacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Safe project key — falls back to '__default__' when no project is configured. */
function safeProjectKey(): string {
  try {
    return getProjectRoot();
  } catch (error) {
    logWarn('graphology', 'getProjectRoot() failed, using default cache key', {
      error: error instanceof Error ? error.message : String(error),
    });
    return '__default__';
  }
}

/**
 * Get or build the in-memory graphology graph from storage.
 * Caches the graph per-project for CACHE_TTL_MS to avoid repeated DB reads.
 */
export async function getGraph(forceRefresh = false): Promise<Graph> {
  const projectKey = safeProjectKey();
  const now = Date.now();
  const cached = graphCache.get(projectKey);
  if (cached && !forceRefresh && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.graph;
  }

  // Evict stale entries from other projects to prevent unbounded cache growth
  for (const [key, entry] of graphCache) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      graphCache.delete(key);
    }
  }

  // Use DirectedGraph so that directional relationships (A→B vs B→A) and
  // multi-relational edges between the same pair of memories are preserved.
  // All graph algorithms used here (PageRank, betweenness, Louvain, Dijkstra)
  // support directed graphs.
  const graph = new DirectedGraph();

  // Load all links
  const links = await getAllMemoryLinksForExport();
  const memories = await getAllMemoriesForExport();

  // Add all memory nodes (even isolated ones)
  for (const mem of memories) {
    if (!graph.hasNode(String(mem.id))) {
      graph.addNode(String(mem.id), {
        memoryId: mem.id,
        content: mem.content?.slice(0, 200),
        type: mem.type,
      });
    }
  }

  // Add edges
  for (const link of links) {
    const sourceKey = String(link.source_id);
    const targetKey = String(link.target_id);

    // Ensure nodes exist
    if (!graph.hasNode(sourceKey)) {
      graph.addNode(sourceKey, { memoryId: link.source_id });
    }
    if (!graph.hasNode(targetKey)) {
      graph.addNode(targetKey, { memoryId: link.target_id });
    }

    // Add directed edge; skip if an edge with the same source, target, and relation
    // already exists to avoid inflating weights. DirectedGraph only supports one edge
    // per (source, target) pair, so multi-relational A→B edges (same pair, different
    // relation) are deduplicated here — the first-encountered relation wins.
    if (!graph.hasDirectedEdge(sourceKey, targetKey)) {
      graph.addDirectedEdge(sourceKey, targetKey, {
        weight: link.weight ?? 1.0,
        relation: link.relation ?? 'related',
      });
    }
  }

  graphCache.set(projectKey, { graph, timestamp: now });

  logInfo('graphology', `Graph loaded: ${graph.order} nodes, ${graph.size} edges`);

  return graph;
}

/**
 * Invalidate the graph cache for the current project (call after link mutations).
 */
export function invalidateGraphCache(): void {
  const projectKey = safeProjectKey();
  graphCache.delete(projectKey);
}

// ============================================================================
// Personalized PageRank (PPR)
// ============================================================================

/**
 * Run Personalized PageRank from seed nodes.
 *
 * PPR biases the random walk to restart at seed nodes, making it
 * discover nodes that are structurally relevant to the seeds.
 * This is effective for graph-enhanced retrieval via biased random walks.
 *
 * @param seedNodeIds - Memory IDs to seed from (e.g., top-k search results)
 * @param topK - Number of top PPR-scored nodes to return
 * @param alpha - Restart probability (default: 0.85 — standard PageRank value)
 * @returns Sorted array of { memoryId, score } pairs
 */
export async function personalizedPageRank(
  seedNodeIds: number[],
  topK: number = 20,
  alpha: number = 0.85
): Promise<Array<{ memoryId: number; score: number }>> {
  const graph = await getGraph();

  if (graph.order === 0) return [];

  // Build personalization vector: uniform over seed nodes
  const validSeeds = seedNodeIds.filter((id) => graph.hasNode(String(id)));
  if (validSeeds.length === 0) return [];

  // graphology's pagerank doesn't natively support personalization vector,
  // so we implement PPR using power iteration manually
  const pprScores = computePPR(graph, validSeeds.map(String), alpha, 50);

  // Convert to sorted array
  const results: Array<{ memoryId: number; score: number }> = [];
  for (const [nodeKey, score] of pprScores.entries()) {
    const memId = parseInt(nodeKey, 10);
    if (!isNaN(memId)) {
      results.push({ memoryId: memId, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

/**
 * Power iteration for Personalized PageRank.
 *
 * PPR(v) = (1-alpha) * personalization(v) + alpha * sum(PPR(u) * w(u,v) / deg(u))
 */
function computePPR(
  graph: Graph,
  seedNodes: string[],
  alpha: number,
  maxIterations: number
): Map<string, number> {
  const n = graph.order;
  if (n === 0) return new Map();

  // Initialize personalization vector
  const personalization = new Map<string, number>();
  const seedWeight = 1.0 / seedNodes.length;
  for (const seed of seedNodes) {
    if (graph.hasNode(seed)) {
      personalization.set(seed, seedWeight);
    }
  }

  // Initialize scores uniformly
  let scores = new Map<string, number>();
  const initScore = 1.0 / n;
  graph.forEachNode((node) => {
    scores.set(node, initScore);
  });

  // Precompute weighted out-degrees for all nodes (O(E) total, done once).
  // In a directed graph, a node distributes its score along its OUT-edges,
  // so we sum weights over outgoing edges only.
  const weightedDegrees = new Map<string, number>();
  graph.forEachNode((node) => {
    let wDeg = 0;
    (graph as DirectedGraph).forEachOutEdge(node, (_edge, attr) => {
      wDeg += (attr.weight as number) ?? 1.0;
    });
    weightedDegrees.set(node, wDeg);
  });

  // Identify dangling nodes (zero weighted degree) — their mass must be redistributed
  // to prevent score mass from collapsing each iteration.
  const danglingNodes: string[] = [];
  graph.forEachNode((node) => {
    if ((weightedDegrees.get(node) ?? 0) === 0) {
      danglingNodes.push(node);
    }
  });

  // Power iteration
  for (let iter = 0; iter < maxIterations; iter++) {
    const newScores = new Map<string, number>();
    let diff = 0;

    // Collect dangling mass — redistribute uniformly across all nodes
    let danglingMass = 0;
    for (const d of danglingNodes) {
      danglingMass += scores.get(d) ?? 0;
    }
    const danglingShare = (alpha * danglingMass) / n;

    graph.forEachNode((node) => {
      // Contribution from in-neighbors (nodes that have an out-edge pointing TO this node).
      // PPR formula: score(v) ← sum over u where u→v exists of: score(u) * w(u,v) / outDeg(u)
      let neighborContrib = 0;
      (graph as DirectedGraph).forEachInNeighbor(node, (neighbor) => {
        const wDeg = weightedDegrees.get(neighbor) ?? 0;
        if (wDeg > 0) {
          // Edge runs neighbor → node (confirmed by forEachInNeighbor)
          const edgeWeight = (graph as DirectedGraph).hasDirectedEdge(neighbor, node)
            ? (graph.getEdgeAttribute(
                (graph as DirectedGraph).directedEdge(neighbor, node)!,
                'weight'
              ) ?? 1.0)
            : 1.0;
          neighborContrib += ((scores.get(neighbor) ?? 0) * edgeWeight) / wDeg;
        }
      });

      // PPR formula: (1-alpha) * personalization + alpha * neighbor_contrib + dangling_share
      const p = personalization.get(node) ?? 0;
      const newScore = (1 - alpha) * p + alpha * neighborContrib + danglingShare;
      newScores.set(node, newScore);
      diff += Math.abs(newScore - (scores.get(node) ?? 0));
    });

    scores = newScores;

    // Early convergence
    if (diff < 1e-8) break;
  }

  return scores;
}

// ============================================================================
// Louvain Community Detection
// ============================================================================

export interface LouvainCommunity {
  id: number;
  size: number;
  members: number[];
}

/**
 * Detect communities using Louvain modularity optimization.
 * Superior to Label Propagation — produces higher-quality communities.
 *
 * @returns Communities sorted by size (largest first)
 */
export async function detectLouvainCommunities(
  minSize: number = 2
): Promise<{ communities: LouvainCommunity[]; modularity: number; isolated: number }> {
  const graph = await getGraph();

  if (graph.order === 0) {
    return { communities: [], modularity: 0, isolated: 0 };
  }

  // Run Louvain with detailed output (includes modularity)
  const detailed = louvain.detailed(graph, {
    getEdgeWeight: 'weight',
    resolution: 1.0,
  });
  const communities = detailed.communities;
  const modularity = detailed.modularity;

  // Group by community
  const communityMap = new Map<number, number[]>();
  for (const [nodeKey, communityId] of Object.entries(communities)) {
    const memId = parseInt(nodeKey, 10);
    if (isNaN(memId)) continue;
    const members = communityMap.get(communityId) ?? [];
    members.push(memId);
    communityMap.set(communityId, members);
  }

  // Build result
  const result: LouvainCommunity[] = [];
  let isolated = 0;
  let nextId = 0;

  for (const [, members] of communityMap) {
    if (members.length < minSize) {
      isolated += members.length;
    } else {
      result.push({
        id: nextId++,
        size: members.length,
        members: members.sort((a, b) => a - b),
      });
    }
  }

  result.sort((a, b) => b.size - a.size);

  return { communities: result, modularity, isolated };
}

// ============================================================================
// Shortest Path (Dijkstra)
// ============================================================================

/**
 * Convert edge similarity weight (higher = stronger relation) to distance
 * cost (lower = closer) for Dijkstra. Avoids zero/negative/non-finite costs.
 *
 * Only guards the lower bound and non-finite values — weights above 1.0 are
 * intentionally preserved so that Dijkstra and betweenness centrality can
 * distinguish between links of different strengths. Clamping to 1.0 would
 * collapse all high-weight edges to an identical cost of 1.0 and lose ordering.
 */
function similarityToDistance(_edge: string, attr: Record<string, unknown>): number {
  const raw = typeof attr.weight === 'number' ? attr.weight : 1.0;
  const safe = Number.isFinite(raw) && raw > 0 ? raw : 0.01;
  return 1.0 / safe;
}

/**
 * Find shortest path between two memories using Dijkstra.
 * Edge weights in the graph represent similarity/strength (higher = stronger).
 * Dijkstra needs cost/distance (lower = closer), so weights are inverted
 * via 1/weight before path-finding.
 *
 * @returns Path as array of memory IDs, or null if no path exists
 */
export async function shortestPath(
  fromId: number,
  toId: number
): Promise<{ path: number[]; weight: number } | null> {
  const graph = await getGraph();
  const fromKey = String(fromId);
  const toKey = String(toId);

  if (!graph.hasNode(fromKey) || !graph.hasNode(toKey)) {
    return null;
  }

  const pathNodes = dijkstraBidirectional(graph, fromKey, toKey, similarityToDistance);
  if (!pathNodes || pathNodes.length === 0) return null;

  // Calculate total original weight (similarity, not distance)
  let totalWeight = 0;
  for (let i = 0; i < pathNodes.length - 1; i++) {
    const edge = graph.edge(pathNodes[i], pathNodes[i + 1]);
    if (edge) {
      totalWeight += graph.getEdgeAttribute(edge, 'weight') ?? 1.0;
    }
  }

  return {
    path: pathNodes.map((n) => parseInt(n, 10)),
    weight: totalWeight,
  };
}

// ============================================================================
// Articulation Points (Critical Nodes)
// ============================================================================

/**
 * Find articulation points — nodes whose removal disconnects the graph.
 * These are "load-bearing" memories, architectural bottlenecks.
 *
 * Uses Tarjan's algorithm (O(V+E)).
 *
 * @returns Array of memory IDs that are articulation points
 */
export async function getArticulationPoints(): Promise<number[]> {
  const graph = await getGraph();

  if (graph.order < 3) return [];

  return findArticulationPointsTarjan(graph)
    .map((n: string) => parseInt(n, 10))
    .filter((id: number) => !isNaN(id));
}

/**
 * Tarjan's algorithm for finding articulation points in an undirected graph.
 * A node is an articulation point if:
 * 1. It is the root of the DFS tree and has 2+ children, OR
 * 2. It is not root and has a child with no back-edge above it (low[child] >= disc[node])
 */
function findArticulationPointsTarjan(graph: Graph): string[] {
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const childCount = new Map<string, number>();
  const ap = new Set<string>();
  let time = 0;

  // Iterative DFS to avoid stack overflow on large graphs
  function dfsIterative(root: string): void {
    // Stack stores: [node, neighborIndex, neighbors[]]
    type Frame = { node: string; idx: number; neighbors: string[] };
    const stack: Frame[] = [];

    disc.set(root, time);
    low.set(root, time);
    time++;
    childCount.set(root, 0);

    const rootNeighbors = graph.neighbors(root);
    stack.push({ node: root, idx: 0, neighbors: rootNeighbors });

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const u = frame.node;

      if (frame.idx < frame.neighbors.length) {
        const v = frame.neighbors[frame.idx];
        frame.idx++;

        if (!disc.has(v)) {
          // Tree edge
          parent.set(v, u);
          childCount.set(u, (childCount.get(u) ?? 0) + 1);
          disc.set(v, time);
          low.set(v, time);
          time++;
          childCount.set(v, 0);

          const vNeighbors = graph.neighbors(v);
          stack.push({ node: v, idx: 0, neighbors: vNeighbors });
        } else if (v !== parent.get(u)) {
          // Back edge
          low.set(u, Math.min(low.get(u)!, disc.get(v)!));
        }
      } else {
        // All neighbors processed — pop and update parent
        stack.pop();

        if (stack.length > 0) {
          const parentFrame = stack[stack.length - 1];
          const pu = parentFrame.node;

          low.set(pu, Math.min(low.get(pu)!, low.get(u)!));

          // Root with 2+ children
          if (parent.get(pu) === null && (childCount.get(pu) ?? 0) > 1) {
            ap.add(pu);
          }
          // Non-root with child that can't reach above
          if (parent.get(pu) !== null && low.get(u)! >= disc.get(pu)!) {
            ap.add(pu);
          }
        }
      }
    }
  }

  graph.forEachNode((node: string) => {
    if (!disc.has(node)) {
      parent.set(node, null);
      dfsIterative(node);
    }
  });

  return [...ap];
}

// ============================================================================
// PageRank (Global Importance)
// ============================================================================

/**
 * Compute global PageRank for all nodes.
 * Higher-ranked memories are more "important" (more connections, central position).
 *
 * @returns Map of memoryId → PageRank score (0-1)
 */
export async function computePageRank(): Promise<Map<number, number>> {
  const graph = await getGraph();

  if (graph.order === 0) return new Map();

  const scores = pagerank(graph, {
    alpha: 0.85,
    maxIterations: 100,
    tolerance: 1e-6,
    getEdgeWeight: 'weight',
  });

  const result = new Map<number, number>();
  graph.forEachNode((node) => {
    const memId = parseInt(node, 10);
    if (!isNaN(memId)) {
      result.set(memId, scores[node] ?? 0);
    }
  });

  return result;
}

// ============================================================================
// Betweenness Centrality
// ============================================================================

/**
 * Compute betweenness centrality for all nodes.
 * Nodes with high betweenness sit on many shortest paths — they're "bridges"
 * between different parts of the knowledge graph.
 *
 * @returns Map of memoryId → betweenness score (0-1 normalized)
 */
export async function computeBetweennessCentrality(): Promise<Map<number, number>> {
  const graph = await getGraph();

  if (graph.order === 0) return new Map();

  const scores = betweennessCentrality(graph, {
    getEdgeWeight: similarityToDistance,
    normalized: true,
  });

  const result = new Map<number, number>();
  graph.forEachNode((node) => {
    const memId = parseInt(node, 10);
    if (!isNaN(memId)) {
      result.set(memId, scores[node] ?? 0);
    }
  });

  return result;
}

// ============================================================================
// Why Related (Explain Path)
// ============================================================================

/**
 * Explain why two memories are related by finding the shortest path
 * and returning the relationship chain with edge types.
 */
export async function whyRelated(
  fromId: number,
  toId: number
): Promise<{
  connected: boolean;
  path: Array<{ memoryId: number; relation?: string }>;
  distance: number;
} | null> {
  const graph = await getGraph();
  const fromKey = String(fromId);
  const toKey = String(toId);

  if (!graph.hasNode(fromKey) || !graph.hasNode(toKey)) {
    return null;
  }

  const pathNodes = dijkstraBidirectional(graph, fromKey, toKey, similarityToDistance);
  if (!pathNodes || pathNodes.length === 0) {
    return { connected: false, path: [], distance: Number.MAX_SAFE_INTEGER };
  }

  const path: Array<{ memoryId: number; relation?: string }> = [];
  let totalWeight = 0;
  for (let i = 0; i < pathNodes.length; i++) {
    const memId = parseInt(pathNodes[i], 10);
    let relation: string | undefined;

    if (i < pathNodes.length - 1) {
      const edge = graph.edge(pathNodes[i], pathNodes[i + 1]);
      if (edge) {
        relation = graph.getEdgeAttribute(edge, 'relation');
        const w = graph.getEdgeAttribute(edge, 'weight') as number;
        totalWeight += Number.isFinite(w) ? w : 1.0;
      }
    }

    path.push({ memoryId: memId, relation });
  }

  return {
    connected: true,
    path,
    distance: totalWeight, // Cumulative edge similarity (higher = stronger connection)
  };
}
