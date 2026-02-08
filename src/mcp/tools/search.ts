/**
 * MCP Search tools
 *
 * - succ_search: Hybrid search in brain vault (BM25 + semantic)
 * - succ_search_code: Search indexed source code
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  hybridSearchCode,
  hybridSearchDocs,
  getRecentDocuments,
  closeDb,
} from '../../lib/storage/index.js';
import { isGlobalOnlyMode, getReadinessGateConfig } from '../../lib/config.js';
import { getEmbedding } from '../../lib/embeddings.js';
import { assessReadiness, formatReadinessHeader } from '../../lib/readiness.js';
import { trackTokenSavings, projectPathParam, applyProjectPath } from '../helpers.js';

export function registerSearchTools(server: McpServer) {
  // Tool: succ_search - Hybrid search in brain vault (BM25 + semantic)
  server.tool(
    'succ_search',
    'Search the project knowledge base using hybrid search (BM25 + semantic). Returns relevant chunks from indexed documentation. In projects without .succ/, returns a hint to initialize or use global memory.',
    {
      query: z.string().describe('The search query'),
      limit: z.number().optional().default(5).describe('Maximum number of results (default: 5)'),
      threshold: z.number().optional().default(0.2).describe('Similarity threshold 0-1 (default: 0.2)'),
      project_path: projectPathParam,
    },
    async ({ query, limit, threshold, project_path }) => {
      await applyProjectPath(project_path);
      // Check if project is initialized
      if (isGlobalOnlyMode()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Project not initialized (no .succ/ directory). Run \`succ init\` to enable project-local search.\n\nTip: Use succ_recall for global memories that work across all projects.`,
            },
          ],
        };
      }

      try {
        // Special case: "*" means "show recent documents" (no semantic search)
        const isWildcard = query === '*' || query === '**' || query.trim() === '';

        if (isWildcard) {
          const recentDocs = await getRecentDocuments(limit);
          if (recentDocs.length === 0) {
            return {
              content: [{
                type: 'text' as const,
                text: 'No documents indexed. Run `succ index` to index documentation.',
              }],
            };
          }

          const formatted = recentDocs
            .map((r, i) => {
              return `### ${i + 1}. ${r.file_path}:${r.start_line}-${r.end_line}\n\n${r.content}`;
            })
            .join('\n\n---\n\n');

          return {
            content: [{
              type: 'text' as const,
              text: `Found ${recentDocs.length} recent documents:\n\n${formatted}`,
            }],
          };
        }

        const queryEmbedding = await getEmbedding(query);
        // Use hybrid search for docs
        const results = await hybridSearchDocs(query, queryEmbedding, limit, threshold);

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

        // Track token savings
        await trackTokenSavings('search', query, results);

        const formatted = results
          .map((r, i) => {
            const score = (r.similarity * 100).toFixed(1);
            return `### ${i + 1}. ${r.file_path}:${r.start_line}-${r.end_line} (${score}%)\n\n${r.content}`;
          })
          .join('\n\n---\n\n');

        // Readiness gate: assess result confidence
        const gateConfig = getReadinessGateConfig();
        let readinessHeader = '';
        if (gateConfig.enabled) {
          const assessment = assessReadiness(results, 'docs', gateConfig);
          readinessHeader = formatReadinessHeader(assessment);
          if (readinessHeader) readinessHeader += '\n\n';
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `${readinessHeader}Found ${results.length} results for "${query}":\n\n${formatted}`,
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
      } finally {
        closeDb();
      }
    }
  );

  // Tool: succ_search_code - Search indexed code (hybrid BM25 + vector)
  server.tool(
    'succ_search_code',
    'Search indexed source code using hybrid search (BM25 + semantic). Find functions, classes, and code patterns. Requires project to be initialized with .succ/',
    {
      query: z.string().describe('What to search for (e.g., "useGlobalHooks", "authentication logic")'),
      limit: z.number().optional().default(5).describe('Maximum number of results (default: 5)'),
      threshold: z.number().optional().default(0.25).describe('Similarity threshold 0-1 (default: 0.25)'),
      project_path: projectPathParam,
    },
    async ({ query, limit, threshold, project_path }) => {
      await applyProjectPath(project_path);
      // Check if project is initialized
      if (isGlobalOnlyMode()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Project not initialized (no .succ/ directory). Run \`succ init\` to enable code search.`,
            },
          ],
        };
      }

      try {
        const queryEmbedding = await getEmbedding(query);
        // Hybrid search: BM25 + vector with RRF fusion
        const codeResults = await hybridSearchCode(query, queryEmbedding, limit, threshold);

        if (codeResults.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No code found matching "${query}". Run succ_index_code first to index the codebase.`,
              },
            ],
          };
        }

        // Track token savings
        await trackTokenSavings('search_code', query, codeResults);

        const formatted = codeResults
          .map((r, i) => {
            const score = (r.similarity * 100).toFixed(1);
            // Remove code: prefix for display
            const filePath = r.file_path.replace(/^code:/, '');
            return `### ${i + 1}. ${filePath}:${r.start_line}-${r.end_line} (${score}%)\n\n\`\`\`\n${r.content}\n\`\`\``;
          })
          .join('\n\n---\n\n');

        // Readiness gate: assess result confidence
        const codeGateConfig = getReadinessGateConfig();
        let codeReadinessHeader = '';
        if (codeGateConfig.enabled) {
          const assessment = assessReadiness(codeResults, 'code', codeGateConfig);
          codeReadinessHeader = formatReadinessHeader(assessment);
          if (codeReadinessHeader) codeReadinessHeader += '\n\n';
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `${codeReadinessHeader}Found ${codeResults.length} code matches for "${query}":\n\n${formatted}`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error searching code: ${error.message}`,
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
