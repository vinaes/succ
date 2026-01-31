#!/usr/bin/env node
/**
 * succ MCP Server
 *
 * Exposes succ functionality as MCP tools that Claude can call directly:
 * - succ_search: Semantic search in brain vault
 * - succ_index: Index/reindex files
 * - succ_status: Get index status
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { searchDocuments, getStats, closeDb } from './lib/db.js';
import { getEmbedding } from './lib/embeddings.js';
import { index } from './commands/index.js';

// Create MCP server
const server = new McpServer({
  name: 'succ',
  version: '0.1.0',
});

// Tool: succ_search - Semantic search in brain vault
server.tool(
  'succ_search',
  'Search the project knowledge base semantically. Returns relevant chunks from indexed documentation.',
  {
    query: z.string().describe('The search query'),
    limit: z.number().optional().default(5).describe('Maximum number of results (default: 5)'),
    threshold: z.number().optional().default(0.2).describe('Similarity threshold 0-1 (default: 0.2)'),
  },
  async ({ query, limit, threshold }) => {
    try {
      const queryEmbedding = await getEmbedding(query);
      const results = searchDocuments(queryEmbedding, limit, threshold);
      closeDb();

      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No results found for "${query}" (threshold: ${threshold})`,
            },
          ],
        };
      }

      const formatted = results
        .map((r, i) => {
          const similarity = (r.similarity * 100).toFixed(1);
          return `### ${i + 1}. ${r.file_path}:${r.start_line}-${r.end_line} (${similarity}%)\n\n${r.content}`;
        })
        .join('\n\n---\n\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: `Found ${results.length} results for "${query}":\n\n${formatted}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error searching: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: succ_index - Index or reindex files
server.tool(
  'succ_index',
  'Index files for semantic search. Run after adding or modifying documentation.',
  {
    path: z.string().optional().describe('Path to index (default: .claude/brain)'),
    force: z.boolean().optional().default(false).describe('Force reindex all files'),
  },
  async ({ path, force }) => {
    try {
      // Capture console output
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      await index(path, { force });

      console.log = originalLog;

      return {
        content: [
          {
            type: 'text' as const,
            text: logs.join('\n'),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error indexing: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: succ_status - Get index status
server.tool(
  'succ_status',
  'Get the current status of the succ index (files indexed, chunks, last update).',
  {},
  async () => {
    try {
      const stats = getStats();
      closeDb();

      const status = [
        `Total files indexed: ${stats.total_files}`,
        `Total chunks: ${stats.total_documents}`,
        `Last indexed: ${stats.last_indexed || 'Never'}`,
      ].join('\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: status,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error getting status: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Start server with stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Use stderr for logging (stdout is for MCP protocol)
  console.error('succ MCP server started');
}

main().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
