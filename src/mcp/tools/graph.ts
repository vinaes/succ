/**
 * MCP Knowledge Graph tools
 *
 * - succ_link: Create/manage memory links (knowledge graph)
 * - succ_explore: Explore connected memories
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
import { projectPathParam, applyProjectPath } from '../helpers.js';

export function registerGraphTools(server: McpServer) {
  // Tool: succ_link - Create/manage memory links (knowledge graph)
  server.tool(
    'succ_link',
    'Create or manage links between memories to build a knowledge graph. Links help track relationships between decisions, learnings, and context.\n\nExamples:\n- Link memories: succ_link(action="create", source_id=1, target_id=2, relation="caused_by")\n- View connections: succ_link(action="show", source_id=42)\n- Auto-link similar: succ_link(action="auto", threshold=0.8)\n- Full maintenance: succ_link(action="cleanup")',
    {
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
        ])
        .describe(
          'Action: create (new link), delete (remove link), show (memory with links), graph (stats), auto (auto-link similar), enrich (LLM classify relations), proximity (co-occurrence links), communities (detect clusters), centrality (compute scores), export (Obsidian/JSON graph export), cleanup (prune weak links, enrich, connect orphans, rebuild communities + centrality)'
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
      project_path: projectPathParam,
    },
    async ({ action, source_id, target_id, relation, threshold, project_path }) => {
      await applyProjectPath(project_path);
      try {
        switch (action) {
          case 'create': {
            if (!source_id || !target_id) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Both source_id and target_id are required to create a link.',
                  },
                ],
              };
            }

            const result = await createMemoryLink(source_id, target_id, relation || 'related');

            return {
              content: [
                {
                  type: 'text' as const,
                  text: result.created
                    ? `Created link: memory #${source_id} --[${relation || 'related'}]--> memory #${target_id}`
                    : `Link already exists (id: ${result.id})`,
                },
              ],
            };
          }

          case 'delete': {
            if (!source_id || !target_id) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Both source_id and target_id are required to delete a link.',
                  },
                ],
              };
            }

            const deleted = await deleteMemoryLink(source_id, target_id, relation);

            return {
              content: [
                {
                  type: 'text' as const,
                  text: deleted
                    ? `Deleted link between memory #${source_id} and #${target_id}`
                    : 'No matching link found.',
                },
              ],
            };
          }

          case 'show': {
            if (!source_id) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'source_id is required to show a memory with its links.',
                  },
                ],
              };
            }

            const memory = await getMemoryWithLinks(source_id);
            if (!memory) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Memory #${source_id} not found.`,
                  },
                ],
              };
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

            return {
              content: [{ type: 'text' as const, text }],
            };
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

            return {
              content: [{ type: 'text' as const, text }],
            };
          }

          case 'auto': {
            const th = threshold || 0.75;
            const created = await autoLinkSimilarMemories(th, 3);

            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Auto-linked similar memories (threshold: ${th}). Created ${created} new links.`,
                },
              ],
            };
          }

          case 'enrich': {
            const { enrichExistingLinks } = await import('../../lib/graph/llm-relations.js');
            const result = await enrichExistingLinks({ batchSize: 5 });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `LLM relation enrichment: ${result.enriched} enriched, ${result.failed} failed, ${result.skipped} skipped.`,
                },
              ],
            };
          }

          case 'proximity': {
            const { createProximityLinks } =
              await import('../../lib/graph/contextual-proximity.js');
            const result = await createProximityLinks({ minCooccurrence: 2 });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Contextual proximity: ${result.created} links created, ${result.skipped} skipped (${result.total_pairs} pairs found).`,
                },
              ],
            };
          }

          case 'communities': {
            const { detectCommunities } = await import('../../lib/graph/community-detection.js');
            const result = await detectCommunities();
            const summary = result.communities
              .map((c) => `  Community ${c.id}: ${c.size} members`)
              .join('\n');
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Detected ${result.communities.length} communities, ${result.isolated} isolated nodes.\n${summary}`,
                },
              ],
            };
          }

          case 'centrality': {
            const { updateCentralityCache } = await import('../../lib/graph/centrality.js');
            const result = await updateCentralityCache();
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Updated centrality scores for ${result.updated} memories.`,
                },
              ],
            };
          }

          case 'export': {
            const { exportGraphSilent } = await import('../../lib/graph-export.js');
            const result = await exportGraphSilent('obsidian');
            if (result.memoriesExported === 0) {
              return {
                content: [{ type: 'text' as const, text: 'No memories to export.' }],
              };
            }
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Exported ${result.memoriesExported} memories and ${result.linksExported} links to Obsidian brain vault.`,
                },
              ],
            };
          }

          case 'cleanup': {
            const { graphCleanup } = await import('../../lib/graph/cleanup.js');
            const result = await graphCleanup({
              pruneThreshold: threshold,
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Graph cleanup complete:\n  Pruned: ${result.pruned}\n  Enriched: ${result.enriched}\n  Orphans connected: ${result.orphansConnected}\n  Communities: ${result.communitiesDetected}\n  Centrality updated: ${result.centralityUpdated}`,
                },
              ],
            };
          }

          default:
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Unknown action. Use: create, delete, show, graph, auto, enrich, proximity, communities, centrality, export, or cleanup.',
                },
              ],
            };
        }
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error.message}`,
            },
          ],
          isError: true,
        };
      } finally {
        closeDb();
      }
    }
  );

  // Tool: succ_explore - Explore connected memories
  server.tool(
    'succ_explore',
    'Explore the knowledge graph starting from a memory. Find connected memories through links.\n\nExamples:\n- Explore connections: succ_explore(memory_id=42, depth=3)',
    {
      memory_id: z.number().describe('Starting memory ID'),
      depth: z.number().optional().default(2).describe('Max traversal depth (default: 2)'),
      project_path: projectPathParam,
    },
    async ({ memory_id, depth, project_path }) => {
      await applyProjectPath(project_path);
      try {
        const connected = await findConnectedMemories(memory_id, depth);

        if (connected.length === 0) {
          const memory = await getMemoryById(memory_id);
          if (!memory) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Memory #${memory_id} not found.`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `Memory #${memory_id} has no connections within ${depth} hops.\n\nContent: ${memory.content.substring(0, 200)}...`,
              },
            ],
          };
        }

        const formatted = connected
          .map(({ memory, depth: d, path: memPath }) => {
            const pathStr = memPath.map((id: number) => `#${id}`).join(' → ');
            return `[Depth ${d}] Memory #${memory.id} (${pathStr})
  ${memory.content.substring(0, 150)}${memory.content.length > 150 ? '...' : ''}
  Tags: ${memory.tags.join(', ') || '(none)'}`;
          })
          .join('\n\n');

        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${connected.length} connected memories from #${memory_id} (max depth: ${depth}):\n\n${formatted}`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error exploring: ${error.message}`,
            },
          ],
          isError: true,
        };
      } finally {
        closeDb();
      }
    }
  );
}
