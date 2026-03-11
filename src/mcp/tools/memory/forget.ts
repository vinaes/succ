import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getMemoryById,
  deleteMemory,
  deleteMemoriesOlderThan,
  deleteMemoriesByTag,
  setMemoryInvariant,
  closeDb,
} from '../../../lib/storage/index.js';
import { parseRelativeDate, projectPathParam, applyProjectPath } from '../../helpers.js';

export function registerForgetTool(server: McpServer): void {
  server.registerTool(
    'succ_forget',
    {
      description:
        'Delete memories. Use to clean up old or irrelevant information.\n\nExamples:\n- By ID: succ_forget(id=42)\n- Old memories: succ_forget(older_than="90d")\n- By tag: succ_forget(tag="temp")',
      inputSchema: {
        id: z.number().optional().describe('Delete memory by ID'),
        older_than: z
          .string()
          .optional()
          .describe('Delete memories older than (e.g., "30d", "1w", "3m", "1y")'),
        tag: z.string().optional().describe('Delete all memories with this tag'),
        force: z
          .boolean()
          .optional()
          .describe('Force-delete pinned (Tier 1) memories. Unpins the memory before deleting.'),
        project_path: projectPathParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, older_than, tag, force, project_path }) => {
      await applyProjectPath(project_path);
      try {
        // Delete by ID
        if (id !== undefined) {
          const memory = await getMemoryById(id);
          if (!memory) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Memory with id ${id} not found.`,
                },
              ],
            };
          }

          try {
            const deleted = await deleteMemory(id);

            if (deleted) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Forgot memory ${id}: "${memory.content.substring(0, 100)}${memory.content.length > 100 ? '...' : ''}"`,
                  },
                ],
              };
            }
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to delete memory ${id}`,
                },
              ],
              isError: true,
            };
          } catch (err) {
            if (err instanceof Error && err.name === 'PinnedMemoryError') {
              if (force) {
                // Unpin and retry deletion; restore pin if retry fails
                await setMemoryInvariant(id, false);
                try {
                  const retryDeleted = await deleteMemory(id);
                  if (retryDeleted) {
                    return {
                      content: [
                        {
                          type: 'text' as const,
                          text: `Force-deleted pinned memory ${id}: "${memory.content.substring(0, 100)}${memory.content.length > 100 ? '...' : ''}"`,
                        },
                      ],
                    };
                  }
                } catch (retryErr) {
                  await setMemoryInvariant(id, true);
                  throw retryErr;
                }
                await setMemoryInvariant(id, true);
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: `Failed to delete pinned memory ${id}; pin was restored`,
                    },
                  ],
                  isError: true,
                };
              }
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Cannot delete memory ${id}: it is pinned (Tier 1). Use force=true to unpin and delete.`,
                  },
                ],
                isError: true,
              };
            }
            throw err;
          }
        }

        // Delete older than date
        if (older_than) {
          const date = parseRelativeDate(older_than);
          if (!date) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid date format: ${older_than}. Use "30d", "1w", "3m", "1y", or ISO date.`,
                },
              ],
              isError: true,
            };
          }

          const count = await deleteMemoriesOlderThan(date);

          return {
            content: [
              {
                type: 'text' as const,
                text: `✓ Forgot ${count} memories older than ${date.toLocaleDateString()}`,
              },
            ],
          };
        }

        // Delete by tag
        if (tag) {
          const count = await deleteMemoriesByTag(tag);

          return {
            content: [
              {
                type: 'text' as const,
                text: `✓ Forgot ${count} memories with tag "${tag}"`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: 'Specify what to forget: id (number), older_than (e.g., "30d"), or tag (string)',
            },
          ],
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error forgetting: ${errorMsg}`,
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
