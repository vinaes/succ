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
    'Search the project knowledge base using hybrid search (BM25 + semantic). Returns relevant chunks from indexed documentation. Output modes: full (default), lean (file+lines only, saves tokens). In projects without .succ/, returns a hint to initialize or use global memory.',
    {
      query: z.string().describe('The search query'),
      limit: z.number().optional().default(5).describe('Maximum number of results (default: 5)'),
      threshold: z
        .number()
        .optional()
        .default(0.2)
        .describe('Similarity threshold 0-1 (default: 0.2)'),
      output: z
        .enum(['full', 'lean'])
        .optional()
        .default('full')
        .describe('Output mode: full (content blocks), lean (file+lines only, saves tokens)'),
      project_path: projectPathParam,
    },
    async ({ query, limit, threshold, output, project_path }) => {
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
              content: [
                {
                  type: 'text' as const,
                  text: 'No documents indexed. Run `succ index` to index documentation.',
                },
              ],
            };
          }

          const formatted = recentDocs
            .map((r, i) => {
              return `### ${i + 1}. ${r.file_path}:${r.start_line}-${r.end_line}\n\n${r.content}`;
            })
            .join('\n\n---\n\n');

          return {
            content: [
              {
                type: 'text' as const,
                text: `Found ${recentDocs.length} recent documents:\n\n${formatted}`,
              },
            ],
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

        let formatted: string;
        if (output === 'lean') {
          formatted = results
            .map((r, i) => {
              const score = (r.similarity * 100).toFixed(1);
              return `${i + 1}. ${r.file_path}:${r.start_line}-${r.end_line} (${score}%)`;
            })
            .join('\n');
        } else {
          formatted = results
            .map((r, i) => {
              const score = (r.similarity * 100).toFixed(1);
              return `### ${i + 1}. ${r.file_path}:${r.start_line}-${r.end_line} (${score}%)\n\n${r.content}`;
            })
            .join('\n\n---\n\n');
        }

        // Readiness gate: assess result confidence
        const gateConfig = getReadinessGateConfig();
        let readinessHeader = '';
        if (gateConfig.enabled) {
          const assessment = assessReadiness(results, 'docs', gateConfig);
          readinessHeader = formatReadinessHeader(assessment);
          if (readinessHeader) readinessHeader += '\n\n';
        }

        const modeLabel = output !== 'full' ? ` [${output}]` : '';
        return {
          content: [
            {
              type: 'text' as const,
              text: `${readinessHeader}Found ${results.length} results for "${query}"${modeLabel}:\n\n${formatted}`,
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
    'Search indexed source code using hybrid search (BM25 + semantic). Find functions, classes, and code patterns. Supports regex pre-filter and symbol_type filter. Output modes: full (default), lean (file+lines only), signatures (symbol names+signatures).',
    {
      query: z
        .string()
        .describe('What to search for (e.g., "useGlobalHooks", "authentication logic")'),
      limit: z.number().optional().default(5).describe('Maximum number of results (default: 5)'),
      threshold: z
        .number()
        .optional()
        .default(0.25)
        .describe('Similarity threshold 0-1 (default: 0.25)'),
      regex: z
        .string()
        .optional()
        .describe('Regex filter — only return results whose content matches this pattern'),
      symbol_type: z
        .enum(['function', 'method', 'class', 'interface', 'type_alias'])
        .optional()
        .describe('Filter by AST symbol type (e.g., "function", "class")'),
      output: z
        .enum(['full', 'lean', 'signatures'])
        .optional()
        .default('full')
        .describe(
          'Output mode: full (code blocks), lean (file+lines, saves tokens), signatures (symbol info only)'
        ),
      project_path: projectPathParam,
    },
    async ({ query, limit, threshold, regex, symbol_type, output, project_path }) => {
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
        // Build filters from optional params
        const filters = regex || symbol_type ? { regex, symbolType: symbol_type } : undefined;
        // Hybrid search: BM25 + vector with RRF fusion
        const codeResults = await hybridSearchCode(
          query,
          queryEmbedding,
          limit,
          threshold,
          undefined,
          filters
        );

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

        let formatted: string;
        if (output === 'lean') {
          // Lean mode: file paths + line ranges + symbol info (saves tokens)
          formatted = codeResults
            .map((r, i) => {
              const score = (r.similarity * 100).toFixed(1);
              const filePath = r.file_path.replace(/^code:/, '');
              const sym = r.symbol_name ? ` [${r.symbol_type ?? 'symbol'}: ${r.symbol_name}]` : '';
              return `${i + 1}. ${filePath}:${r.start_line}-${r.end_line} (${score}%)${sym}`;
            })
            .join('\n');
        } else if (output === 'signatures') {
          // Signatures mode: symbol metadata (minimal tokens)
          formatted = codeResults
            .map((r, i) => {
              const score = (r.similarity * 100).toFixed(1);
              const filePath = r.file_path.replace(/^code:/, '');
              let sym: string;
              if (r.symbol_name) {
                sym = `${r.symbol_type ?? 'symbol'} ${r.symbol_name}`;
              } else {
                // Fallback: find first meaningful line (skip doc comments, blank lines)
                const firstLine =
                  r.content
                    .split('\n')
                    .map((l: string) => l.trim())
                    .find(
                      (l: string) =>
                        l &&
                        !l.startsWith('/**') &&
                        !l.startsWith('*') &&
                        !l.startsWith('*/') &&
                        !l.startsWith('//')
                    ) ?? r.content.split('\n')[0].trim();
                sym = firstLine;
              }
              return `${i + 1}. ${filePath}:${r.start_line} (${score}%) — ${sym}`;
            })
            .join('\n');
        } else {
          // Full mode: code blocks with symbol header (default)
          formatted = codeResults
            .map((r, i) => {
              const score = (r.similarity * 100).toFixed(1);
              const filePath = r.file_path.replace(/^code:/, '');
              const sym = r.symbol_name
                ? ` — ${r.symbol_type ?? 'symbol'} \`${r.symbol_name}\``
                : '';
              return `### ${i + 1}. ${filePath}:${r.start_line}-${r.end_line} (${score}%)${sym}\n\n\`\`\`\n${r.content}\n\`\`\``;
            })
            .join('\n\n---\n\n');
        }

        // Readiness gate: assess result confidence
        const codeGateConfig = getReadinessGateConfig();
        let codeReadinessHeader = '';
        if (codeGateConfig.enabled) {
          const assessment = assessReadiness(codeResults, 'code', codeGateConfig);
          codeReadinessHeader = formatReadinessHeader(assessment);
          if (codeReadinessHeader) codeReadinessHeader += '\n\n';
        }

        const modeLabel = output !== 'full' ? ` [${output}]` : '';
        return {
          content: [
            {
              type: 'text' as const,
              text: `${codeReadinessHeader}Found ${codeResults.length} code matches for "${query}"${modeLabel}:\n\n${formatted}`,
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
