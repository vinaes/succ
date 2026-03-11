/**
 * MCP Knowledge Graph tools
 *
 * - succ_link: Create/manage memory links (knowledge graph)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  createMemoryLink,
  deleteMemoryLink,
  getMemoryWithLinks,
  findConnectedMemories,
  autoLinkSimilarMemories,
  getGraphStats,
  getMemoryById,
  LINK_RELATIONS,
  closeDb,
} from '../../lib/storage/index.js';
import {
  invalidateGraphCache,
  shortestPath,
  whyRelated,
  getArticulationPoints,
  computePageRank,
  computeBetweennessCentrality,
  detectLouvainCommunities,
} from '../../lib/graph/graphology-bridge.js';
import { logWarn } from '../../lib/fault-logger.js';
import {
  projectPathParam,
  applyProjectPath,
  createToolResponse,
  createErrorResponse,
} from '../helpers.js';

export function registerGraphTools(server: McpServer) {
  // Tool: succ_link - Create/manage memory links (knowledge graph)
  server.registerTool(
    'succ_link',
    {
      description:
        'Create or manage links between memories to build a knowledge graph. Links help track relationships between decisions, learnings, and context.\n\nExamples:\n- Link memories: succ_link(action="create", source_id=1, target_id=2, relation="caused_by")\n- View connections: succ_link(action="show", source_id=42)\n- Auto-link similar: succ_link(action="auto", threshold=0.8)\n- Full maintenance: succ_link(action="cleanup")\n- Explore connections: succ_link(action="explore", source_id=42, depth=3)',
      inputSchema: {
        action: z
          .enum([
            'create',
            'delete',
            'show',
            'graph',
            'auto',
            'enrich',
            'proximity',
            'communities',
            'centrality',
            'export',
            'cleanup',
            'explore',
            'shortest_path',
            'why_related',
            'critical_nodes',
            'pagerank',
            'summarize',
            'co_change',
            'bridge',
          ])
          .describe(
            'Action: create, delete, show, graph, auto, enrich, proximity, communities, centrality, export, cleanup, explore, shortest_path, why_related, critical_nodes, pagerank, summarize (GraphRAG community summaries), co_change (git co-change analysis), bridge (auto-create code↔knowledge edges, or find memories for a code path via file_path)'
          ),
        source_id: z.number().optional().describe('Source memory ID (for create/delete/show)'),
        target_id: z.number().optional().describe('Target memory ID (for create/delete)'),
        relation: z
          .enum(LINK_RELATIONS)
          .optional()
          .describe(
            'Relation type: related, caused_by, leads_to, similar_to, contradicts, implements, supersedes, references'
          ),
        threshold: z
          .number()
          .optional()
          .describe('Similarity threshold for auto-linking (default: 0.75)'),
        depth: z
          .number()
          .optional()
          .default(2)
          .describe('Max traversal depth (for explore, default: 2)'),
        memory_id: z.number().optional().describe('Alias for source_id (for explore)'),
        file_path: z.string().optional().describe('File path (for co_change or bridge actions)'),
        project_path: projectPathParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      action,
      source_id,
      target_id,
      relation,
      threshold,
      depth,
      memory_id,
      file_path,
      project_path,
    }) => {
      try {
        await applyProjectPath(project_path);
        const trimmedFilePath = file_path?.trim() || undefined;
        switch (action) {
          case 'create': {
            if (source_id == null || target_id == null) {
              return createToolResponse(
                'Both source_id and target_id are required to create a link.'
              );
            }

            const result = await createMemoryLink(source_id, target_id, relation || 'related');
            invalidateGraphCache();

            return createToolResponse(
              result.created
                ? `Created link: memory #${source_id} --[${relation || 'related'}]--> memory #${target_id}`
                : `Link already exists (id: ${result.id})`
            );
          }

          case 'delete': {
            if (source_id == null || target_id == null) {
              return createToolResponse(
                'Both source_id and target_id are required to delete a link.'
              );
            }

            const deleted = await deleteMemoryLink(source_id, target_id, relation);
            invalidateGraphCache();

            return createToolResponse(
              deleted
                ? `Deleted link between memory #${source_id} and #${target_id}`
                : 'No matching link found.'
            );
          }

          case 'show': {
            if (source_id == null) {
              return createToolResponse('source_id is required to show a memory with its links.');
            }

            const memory = await getMemoryWithLinks(source_id);
            if (!memory) {
              return createToolResponse(`Memory #${source_id} not found.`);
            }

            const outLinks =
              memory.outgoing_links.length > 0
                ? memory.outgoing_links
                    .map((l: any) => `  → #${l.target_id} (${l.relation})`)
                    .join('\n')
                : '  (none)';
            const inLinks =
              memory.incoming_links.length > 0
                ? memory.incoming_links
                    .map((l: any) => `  ← #${l.source_id} (${l.relation})`)
                    .join('\n')
                : '  (none)';

            const text = `Memory #${memory.id}:
${memory.content.substring(0, 200)}${memory.content.length > 200 ? '...' : ''}

Tags: ${memory.tags.length > 0 ? memory.tags.join(', ') : '(none)'}
Created: ${new Date(memory.created_at).toLocaleString()}

Outgoing links:
${outLinks}

Incoming links:
${inLinks}`;

            return createToolResponse(text);
          }

          case 'graph': {
            const stats = await getGraphStats();

            const relationStats =
              Object.entries(stats.relations)
                .map(([r, c]) => `  ${r}: ${c}`)
                .join('\n') || '  (no links)';

            const text = `Knowledge Graph Statistics:

Memories: ${stats.total_memories}
Links: ${stats.total_links}
Avg links/memory: ${stats.avg_links_per_memory.toFixed(2)}
Isolated (no links): ${stats.isolated_memories}

Links by relation:
${relationStats}`;

            return createToolResponse(text);
          }

          case 'auto': {
            const th = threshold || 0.75;
            const created = await autoLinkSimilarMemories(th, 3);
            invalidateGraphCache();

            return createToolResponse(
              `Auto-linked similar memories (threshold: ${th}). Created ${created} new links.`
            );
          }

          case 'enrich': {
            const { enrichExistingLinks } = await import('../../lib/graph/llm-relations.js');
            const result = await enrichExistingLinks({ batchSize: 5 });
            invalidateGraphCache();
            return createToolResponse(
              `LLM relation enrichment: ${result.enriched} enriched, ${result.failed} failed, ${result.skipped} skipped.`
            );
          }

          case 'proximity': {
            const { createProximityLinks } =
              await import('../../lib/graph/contextual-proximity.js');
            const result = await createProximityLinks({ minCooccurrence: 2 });
            invalidateGraphCache();
            return createToolResponse(
              `Contextual proximity: ${result.created} links created, ${result.skipped} skipped (${result.total_pairs} pairs found).`
            );
          }

          case 'communities': {
            const result = await detectLouvainCommunities();
            const summary = result.communities
              .map((c) => `  Community ${c.id}: ${c.size} members`)
              .join('\n');
            return createToolResponse(
              `Louvain community detection: ${result.communities.length} communities, ${result.isolated} isolated nodes (modularity: ${result.modularity.toFixed(4)}).\n${summary}`
            );
          }

          case 'centrality': {
            const prScores = await computePageRank();
            const bcScores = await computeBetweennessCentrality();

            // Also update the storage-level centrality cache
            const { updateCentralityCache } = await import('../../lib/graph/centrality.js');
            const cacheResult = await updateCentralityCache();

            // Show top 10 by PageRank
            const top10 = [...prScores.entries()]
              .sort(([, a], [, b]) => b - a)
              .slice(0, 10)
              .map(([id, pr]) => {
                const bc = bcScores.get(id) ?? 0;
                return `  #${id}: PageRank=${pr.toFixed(6)}, Betweenness=${bc.toFixed(6)}`;
              })
              .join('\n');

            return createToolResponse(
              `Centrality scores computed for ${prScores.size} memories (cache updated: ${cacheResult.updated}).\n\nTop 10 by PageRank:\n${top10 || '  (no nodes)'}`
            );
          }

          case 'export': {
            const { exportGraphSilent } = await import('../../lib/graph-export.js');
            const result = await exportGraphSilent('obsidian');
            if (result.memoriesExported === 0) {
              return createToolResponse('No memories to export.');
            }
            return createToolResponse(
              `Exported ${result.memoriesExported} memories and ${result.linksExported} links to Obsidian brain vault.`
            );
          }

          case 'cleanup': {
            const { graphCleanup } = await import('../../lib/graph/cleanup.js');
            const result = await graphCleanup({
              pruneThreshold: threshold,
            });
            invalidateGraphCache();
            return createToolResponse(
              `Graph cleanup complete:\n  Pruned: ${result.pruned}\n  Enriched: ${result.enriched}\n  Orphans connected: ${result.orphansConnected}\n  Communities: ${result.communitiesDetected}\n  Centrality updated: ${result.centralityUpdated}`
            );
          }

          case 'explore': {
            const startId = source_id || memory_id;
            if (!startId) {
              return createToolResponse('source_id (or memory_id) is required for explore.');
            }

            const connected = await findConnectedMemories(startId, depth);

            if (connected.length === 0) {
              const memory = await getMemoryById(startId);
              if (!memory) {
                return createToolResponse(`Memory #${startId} not found.`);
              }
              return createToolResponse(
                `Memory #${startId} has no connections within ${depth} hops.\n\nContent: ${memory.content.substring(0, 200)}...`
              );
            }

            const formatted = connected
              .map(({ memory, depth: d, path: memPath }) => {
                const pathStr = memPath.map((id: number) => `#${id}`).join(' → ');
                return `[Depth ${d}] Memory #${memory.id} (${pathStr})
  ${memory.content.substring(0, 150)}${memory.content.length > 150 ? '...' : ''}
  Tags: ${memory.tags.join(', ') || '(none)'}`;
              })
              .join('\n\n');

            return createToolResponse(
              `Found ${connected.length} connected memories from #${startId} (max depth: ${depth}):\n\n${formatted}`
            );
          }

          case 'shortest_path': {
            if (source_id == null || target_id == null) {
              return createToolResponse(
                'Both source_id and target_id are required for shortest_path.'
              );
            }

            const spResult = await shortestPath(source_id, target_id);
            if (!spResult) {
              return createToolResponse(
                `No path found between memory #${source_id} and #${target_id}.`
              );
            }

            const pathStr = spResult.path.map((id) => `#${id}`).join(' → ');
            return createToolResponse(
              `Shortest path (${spResult.path.length - 1} hops, weight: ${spResult.weight.toFixed(2)}):\n${pathStr}`
            );
          }

          case 'why_related': {
            if (source_id == null || target_id == null) {
              return createToolResponse(
                'Both source_id and target_id are required for why_related.'
              );
            }

            const wrResult = await whyRelated(source_id, target_id);
            if (!wrResult) {
              return createToolResponse(
                `One or both memories (#${source_id}, #${target_id}) not found in graph.`
              );
            }

            if (!wrResult.connected) {
              return createToolResponse(
                `Memories #${source_id} and #${target_id} are not connected in the knowledge graph.`
              );
            }

            const chain = wrResult.path
              .map((step, i) => {
                if (i < wrResult.path.length - 1) {
                  return `#${step.memoryId} --[${step.relation || 'related'}]-->`;
                }
                return `#${step.memoryId}`;
              })
              .join(' ');

            return createToolResponse(
              `Relationship chain (${wrResult.path.length - 1} hops, distance ${wrResult.distance.toFixed(2)}):\n${chain}`
            );
          }

          case 'critical_nodes': {
            const points = await getArticulationPoints();

            if (points.length === 0) {
              return createToolResponse(
                'No articulation points found. The graph has no single points of failure.'
              );
            }

            // Enrich with memory content snippets
            const enriched = await Promise.all(
              points.slice(0, 20).map(async (id) => {
                const mem = await getMemoryById(id);
                const snippet = mem ? mem.content.substring(0, 100) : '(unknown)';
                return `  #${id}: ${snippet}${mem && mem.content.length > 100 ? '...' : ''}`;
              })
            );

            return createToolResponse(
              `Found ${points.length} critical nodes (articulation points):\n${enriched.join('\n')}${points.length > 20 ? `\n  ... and ${points.length - 20} more` : ''}`
            );
          }

          case 'pagerank': {
            const prMap = await computePageRank();

            if (prMap.size === 0) {
              return createToolResponse('No nodes in graph.');
            }

            const topN = 15;
            const sorted = [...prMap.entries()].sort(([, a], [, b]) => b - a).slice(0, topN);

            const lines = await Promise.all(
              sorted.map(async ([id, score]) => {
                const mem = await getMemoryById(id);
                const snippet = mem ? mem.content.substring(0, 80) : '(unknown)';
                return `  #${id} (${score.toFixed(6)}): ${snippet}${mem && mem.content.length > 80 ? '...' : ''}`;
              })
            );

            return createToolResponse(
              `PageRank — Top ${Math.min(topN, sorted.length)} of ${prMap.size} memories:\n${lines.join('\n')}`
            );
          }

          case 'summarize': {
            const { generateCommunitySummaries } =
              await import('../../lib/graph/community-summaries.js');
            const summResult = await generateCommunitySummaries();
            invalidateGraphCache();
            return createToolResponse(
              `Community summaries: ${summResult.summariesCreated} created, ${summResult.summariesFailed} failed, ${summResult.oldSummariesRemoved} old summaries removed (${summResult.communitiesProcessed} communities processed).`
            );
          }

          case 'co_change': {
            const { getCoChangesForFile, analyzeCoChanges } =
              await import('../../lib/git/co-change.js');

            if (trimmedFilePath) {
              const result = await getCoChangesForFile(trimmedFilePath);
              if (result.cochanges.length === 0) {
                return createToolResponse(
                  `No co-change patterns found for "${trimmedFilePath}". The file may have few commits or mostly changes alone.`
                );
              }

              const lines = result.cochanges.map(
                (c) => `  ${c.path} (${c.count} times, score: ${c.score.toFixed(2)})`
              );
              return createToolResponse(
                `Co-change analysis for "${trimmedFilePath}":\n\nFiles that frequently change together:\n${lines.join('\n')}`
              );
            }

            // No file_path — show overall top co-change pairs
            const result = await analyzeCoChanges();
            const topPairs = result.pairs.slice(0, 15);
            const lines = topPairs.map(
              (p) => `  ${p.fileA} ↔ ${p.fileB} (${p.count} times, score: ${p.score.toFixed(2)})`
            );

            return createToolResponse(
              `Git co-change analysis (${result.totalCommits} commits, ${result.totalFiles} files):\n\nTop co-change pairs:\n${lines.join('\n') || '  (no co-change patterns found)'}`
            );
          }

          case 'bridge': {
            const { findMemoriesForCode, autoBridgeRecentMemories } =
              await import('../../lib/graph/bridge-edges.js');

            if (trimmedFilePath) {
              // Find memories linked to a specific code path
              const results = await findMemoriesForCode(trimmedFilePath);
              if (results.length === 0) {
                return createToolResponse(`No memories found referencing "${trimmedFilePath}".`);
              }

              const lines = results.map(
                (r) =>
                  `  #${r.memoryId} [${r.relation}] (score: ${r.score.toFixed(3)}): ${r.content.substring(0, 120)}${r.content.length > 120 ? '...' : ''}`
              );
              return createToolResponse(
                `Memories referencing "${trimmedFilePath}":\n\n${lines.join('\n')}`
              );
            }

            // No trimmedFilePath — run auto-bridge scan
            const result = await autoBridgeRecentMemories();
            invalidateGraphCache();
            return createToolResponse(
              `Bridge edge scan: ${result.created} edges created, ${result.skipped} skipped, ${result.errors} errors.`
            );
          }

          default:
            return createToolResponse(
              'Unknown action. Use: create, delete, show, graph, auto, enrich, proximity, communities, centrality, export, cleanup, explore, shortest_path, why_related, critical_nodes, pagerank, summarize, co_change, or bridge.'
            );
        }
      } catch (error) {
        logWarn('graph', `Graph tool error in action=${action}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        return createErrorResponse(
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        closeDb();
      }
    }
  );
}
