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
} from '../../lib/db/index.js';

export function registerGraphTools(server: McpServer) {
  // Tool: succ_link - Create/manage memory links (knowledge graph)
  server.tool(
    'succ_link',
    'Create or manage links between memories to build a knowledge graph. Links help track relationships between decisions, learnings, and context.',
    {
      action: z.enum(['create', 'delete', 'show', 'graph', 'auto']).describe(
        'Action: create (new link), delete (remove link), show (memory with links), graph (stats), auto (auto-link similar)'
      ),
      source_id: z.number().optional().describe('Source memory ID (for create/delete/show)'),
      target_id: z.number().optional().describe('Target memory ID (for create/delete)'),
      relation: z.enum(LINK_RELATIONS).optional().describe(
        'Relation type: related, caused_by, leads_to, similar_to, contradicts, implements, supersedes, references'
      ),
      threshold: z.number().optional().describe('Similarity threshold for auto-linking (default: 0.75)'),
    },
    async ({ action, source_id, target_id, relation, threshold }) => {
      try {
        switch (action) {
          case 'create': {
            if (!source_id || !target_id) {
              return {
                content: [{
                  type: 'text' as const,
                  text: 'Both source_id and target_id are required to create a link.',
                }],
              };
            }

            const result = createMemoryLink(source_id, target_id, relation || 'related');

            return {
              content: [{
                type: 'text' as const,
                text: result.created
                  ? `Created link: memory #${source_id} --[${relation || 'related'}]--> memory #${target_id}`
                  : `Link already exists (id: ${result.id})`,
              }],
            };
          }

          case 'delete': {
            if (!source_id || !target_id) {
              return {
                content: [{
                  type: 'text' as const,
                  text: 'Both source_id and target_id are required to delete a link.',
                }],
              };
            }

            const deleted = deleteMemoryLink(source_id, target_id, relation);

            return {
              content: [{
                type: 'text' as const,
                text: deleted
                  ? `Deleted link between memory #${source_id} and #${target_id}`
                  : 'No matching link found.',
              }],
            };
          }

          case 'show': {
            if (!source_id) {
              return {
                content: [{
                  type: 'text' as const,
                  text: 'source_id is required to show a memory with its links.',
                }],
              };
            }

            const memory = getMemoryWithLinks(source_id);
            if (!memory) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `Memory #${source_id} not found.`,
                }],
              };
            }

            const outLinks = memory.outgoing_links.length > 0
              ? memory.outgoing_links.map(l => `  → #${l.target_id} (${l.relation})`).join('\n')
              : '  (none)';
            const inLinks = memory.incoming_links.length > 0
              ? memory.incoming_links.map(l => `  ← #${l.source_id} (${l.relation})`).join('\n')
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
            const stats = getGraphStats();

            const relationStats = Object.entries(stats.relations)
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
            const created = autoLinkSimilarMemories(th, 3);

            return {
              content: [{
                type: 'text' as const,
                text: `Auto-linked similar memories (threshold: ${th}). Created ${created} new links.`,
              }],
            };
          }

          default:
            return {
              content: [{
                type: 'text' as const,
                text: 'Unknown action. Use: create, delete, show, graph, or auto.',
              }],
            };
        }
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error: ${error.message}`,
          }],
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
    'Explore the knowledge graph starting from a memory. Find connected memories through links.',
    {
      memory_id: z.number().describe('Starting memory ID'),
      depth: z.number().optional().default(2).describe('Max traversal depth (default: 2)'),
    },
    async ({ memory_id, depth }) => {
      try {
        const connected = findConnectedMemories(memory_id, depth);

        if (connected.length === 0) {
          const memory = getMemoryById(memory_id);
          if (!memory) {
            return {
              content: [{
                type: 'text' as const,
                text: `Memory #${memory_id} not found.`,
              }],
            };
          }
          return {
            content: [{
              type: 'text' as const,
              text: `Memory #${memory_id} has no connections within ${depth} hops.\n\nContent: ${memory.content.substring(0, 200)}...`,
            }],
          };
        }

        const formatted = connected.map(({ memory, depth: d, path: memPath }) => {
          const pathStr = memPath.map(id => `#${id}`).join(' → ');
          return `[Depth ${d}] Memory #${memory.id} (${pathStr})
  ${memory.content.substring(0, 150)}${memory.content.length > 150 ? '...' : ''}
  Tags: ${memory.tags.join(', ') || '(none)'}`;
        }).join('\n\n');

        return {
          content: [{
            type: 'text' as const,
            text: `Found ${connected.length} connected memories from #${memory_id} (max depth: ${depth}):\n\n${formatted}`,
          }],
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error exploring: ${error.message}`,
          }],
          isError: true,
        };
      } finally {
        closeDb();
      }
    }
  );
}
