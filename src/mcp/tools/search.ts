/**
 * MCP Search tools
 *
 * - succ_search: Hybrid search in brain vault (BM25 + semantic)
 * - succ_search_code: Search indexed source code
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { minimatch } from 'minimatch';
import {
  hybridSearchCode,
  hybridSearchDocs,
  getRecentDocuments,
  closeDb,
} from '../../lib/storage/index.js';
import { isGlobalOnlyMode, getReadinessGateConfig } from '../../lib/config.js';
import { getEmbedding } from '../../lib/embeddings.js';
import { assessReadiness, formatReadinessHeader } from '../../lib/readiness.js';
import {
  trackTokenSavings,
  projectPathParam,
  applyProjectPath,
  extractAnswerFromResults,
} from '../helpers.js';
import { logWarn } from '../../lib/fault-logger.js';
import { getErrorMessage, isSuccError } from '../../lib/errors.js';
import { searchPatternInContent, formatPatternResults } from '../../lib/search/ast-grep-search.js';

/**
 * Filter search results by include/exclude path glob patterns.
 *
 * @param results - Search results with file_path field
 * @param includePaths - Only include results matching these globs (OR logic)
 * @param excludePaths - Exclude results matching these globs (OR logic)
 * @returns Filtered results
 */
function filterByPaths<T extends { file_path: string }>(
  results: T[],
  includePaths?: string[],
  excludePaths?: string[]
): T[] {
  // Precompute normalized patterns — minimatch treats \ as escape, not path separator.
  const normalizedInclude = includePaths?.map((p) => p.replace(/\\/g, '/'));
  const normalizedExclude = excludePaths?.map((p) => p.replace(/\\/g, '/'));

  return results.filter((r) => {
    // Strip storage prefix (e.g. "code:", "doc:") and normalize path separators.
    // Use an explicit prefix list to avoid accidentally stripping Windows drive letters (e.g. "c:").
    const filePath = r.file_path.replace(/^(?:code|doc|memory):/, '').replace(/\\/g, '/');

    // Check include patterns (OR: match any)
    if (normalizedInclude && normalizedInclude.length > 0) {
      const matches = normalizedInclude.some((pattern) =>
        minimatch(filePath, pattern, { dot: true, matchBase: true })
      );
      if (!matches) return false;
    }

    // Check exclude patterns (OR: exclude if any match)
    if (normalizedExclude && normalizedExclude.length > 0) {
      const excluded = normalizedExclude.some((pattern) =>
        minimatch(filePath, pattern, { dot: true, matchBase: true })
      );
      if (excluded) return false;
    }

    return true;
  });
}

export function registerSearchTools(server: McpServer) {
  // Tool: succ_search - Hybrid search in brain vault (BM25 + semantic)
  server.registerTool(
    'succ_search',
    {
      description:
        'Search the project knowledge base using hybrid search (BM25 + semantic). Returns relevant chunks from indexed documentation. Output modes: full (default), lean (file+lines only, saves tokens). In projects without .succ/, returns a hint to initialize or use global memory.\n\nExamples:\n- Search docs: succ_search(query="API authentication", limit=3)\n- Token-efficient: succ_search(query="config system", output="lean")',
      inputSchema: {
        query: z.string().describe('The search query'),
        limit: z.number().optional().default(5).describe('Maximum number of results (default: 5)'),
        threshold: z
          .number()
          .optional()
          .default(0.2)
          .describe('Similarity threshold 0-1 (default: 0.2)'),
        include_paths: z
          .array(z.string())
          .optional()
          .describe(
            'Only include results from these path patterns (glob: **/*.ts, src/auth/*). Narrows search to specific directories or file types.'
          ),
        exclude_paths: z
          .array(z.string())
          .optional()
          .describe(
            'Exclude results matching these path patterns (glob: **/test/**, **/*.test.ts). Filters out irrelevant directories.'
          ),
        output: z
          .enum(['full', 'lean'])
          .optional()
          .default('full')
          .describe('Output mode: full (content blocks), lean (file+lines only, saves tokens)'),
        extract: z
          .string()
          .optional()
          .describe(
            'Extract a specific answer from results using LLM. Instead of returning raw results, returns a concise answer to this question. Adds latency but saves 50-80% output tokens.'
          ),
        project_path: projectPathParam,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      query,
      limit,
      threshold,
      include_paths,
      exclude_paths,
      output,
      extract,
      project_path,
    }) => {
      try {
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

        // Special case: "*" means "show recent documents" (no semantic search)
        const isWildcard = query === '*' || query === '**' || query.trim() === '';

        if (isWildcard) {
          // Overfetch when path filters are present so we can filter and still hit limit
          const hasPathFilters =
            (include_paths && include_paths.length > 0) ||
            (exclude_paths && exclude_paths.length > 0);
          const fetchLimit = hasPathFilters ? Math.min(limit * 5, 100) : limit;
          let recentDocs = await getRecentDocuments(fetchLimit);

          // Apply path filters
          if (hasPathFilters) {
            recentDocs = filterByPaths(recentDocs, include_paths, exclude_paths).slice(0, limit);
          }

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
        // Use hybrid search for docs — overfetch if path filters are applied
        const hasPathFilters =
          (include_paths && include_paths.length > 0) ||
          (exclude_paths && exclude_paths.length > 0);
        const fetchLimit = hasPathFilters ? Math.min(limit * 5, 100) : limit;
        let results = await hybridSearchDocs(query, queryEmbedding, fetchLimit, threshold);

        // Apply path filters
        if (hasPathFilters) {
          results = filterByPaths(results, include_paths, exclude_paths).slice(0, limit);
        }

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

        // Smart Result Compression: extract specific answer via LLM
        if (extract && results.length > 0) {
          const answer = await extractAnswerFromResults(formatted, extract, 'succ_search');
          return {
            content: [
              {
                type: 'text' as const,
                text: `Found ${results.length} results for "${query}" (extracted):\n\n${answer}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `${readinessHeader}Found ${results.length} results for "${query}"${modeLabel}:\n\n${formatted}`,
            },
          ],
        };
      } catch (error) {
        const msg = getErrorMessage(error);
        logWarn('search', 'Error searching documents', { error: msg });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error searching: ${msg}`,
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
  server.registerTool(
    'succ_search_code',
    {
      description:
        'Search indexed source code using hybrid search (BM25 + semantic). Find functions, classes, and code patterns. Supports regex pre-filter, symbol_type filter, and structural pattern matching via ast-grep (20 languages). Output modes: full (default), lean (file+lines only), signatures (symbol names+signatures).\n\nExamples:\n- Find functions: succ_search_code(query="handleAuth", symbol_type="function")\n- Regex filter: succ_search_code(query="error handling", regex="catch\\\\s*\\\\(")\n- Structural pattern: succ_search_code(query="error handling", pattern="try { $$$BODY } catch ($ERR) { $$$HANDLER }")\n- Find all console.log calls: succ_search_code(query="logging", pattern="console.log($$$ARGS)")\n- Quick overview: succ_search_code(query="storage", output="signatures", limit=10)',
      inputSchema: {
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
        include_paths: z
          .array(z.string())
          .optional()
          .describe(
            'Only include results from these path patterns (glob: **/*.ts, src/auth/*). Narrows search scope.'
          ),
        exclude_paths: z
          .array(z.string())
          .optional()
          .describe(
            'Exclude results matching these path patterns (glob: **/test/**, node_modules/**). Filters out irrelevant files.'
          ),
        output: z
          .enum(['full', 'lean', 'signatures'])
          .optional()
          .default('full')
          .describe(
            'Output mode: full (code blocks), lean (file+lines, saves tokens), signatures (symbol info only)'
          ),
        pattern: z
          .string()
          .optional()
          .describe(
            'Structural pattern for ast-grep matching (20 languages). Uses metavariables: $VAR (single node), $$VAR (optional), $$$VAR (multiple). Example: "try { $$$BODY } catch ($ERR) { $$$HANDLER }"'
          ),
        extract: z
          .string()
          .optional()
          .describe(
            'Extract a specific answer from results using LLM. Instead of returning raw results, returns a concise answer to this question. Adds latency but saves 50-80% output tokens.'
          ),
        project_path: projectPathParam,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      query,
      limit,
      threshold,
      regex,
      symbol_type,
      include_paths,
      exclude_paths,
      output,
      pattern,
      extract,
      project_path,
    }) => {
      try {
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

        const queryEmbedding = await getEmbedding(query);
        // Build filters from optional params
        const filters = regex || symbol_type ? { regex, symbolType: symbol_type } : undefined;
        // Overfetch if path filters or pattern matching are applied
        const hasPathFilters =
          (include_paths && include_paths.length > 0) ||
          (exclude_paths && exclude_paths.length > 0);
        const fetchLimit = hasPathFilters || pattern ? Math.min(limit * 5, 100) : limit;
        // Hybrid search: BM25 + vector with RRF fusion
        let codeResults = await hybridSearchCode(
          query,
          queryEmbedding,
          fetchLimit,
          threshold,
          undefined,
          filters
        );

        // Apply path filters
        if (hasPathFilters) {
          codeResults = filterByPaths(codeResults, include_paths, exclude_paths).slice(0, limit);
        }

        // Structural pattern matching via ast-grep
        if (pattern && codeResults.length > 0) {
          const patternMatches = [];
          let patternError: string | null = null;
          let failedFilesCount = 0;
          for (const result of codeResults) {
            const filePath = result.file_path.replace(/^code:/, '');
            try {
              const matches = await searchPatternInContent(result.content, filePath, pattern);
              for (const m of matches) {
                // Adjust line numbers from chunk-relative to file-absolute
                patternMatches.push({
                  ...m,
                  start_line: m.start_line + result.start_line - 1,
                  end_line: m.end_line + result.start_line - 1,
                });
                if (patternMatches.length >= limit) break;
              }
            } catch (err) {
              failedFilesCount++;
              if (isSuccError(err)) {
                patternError = err.message;
              } else {
                patternError = getErrorMessage(err);
              }
              logWarn('search', `Pattern search failed for ${filePath}: ${patternError}`);
            }
            if (patternMatches.length >= limit) break;
          }

          // If all files failed with no matches, report the error
          if (patternMatches.length === 0 && patternError) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Structural pattern search failed: ${patternError}`,
                },
              ],
              isError: true,
            };
          }

          if (patternMatches.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `No structural matches for pattern "${pattern}" in ${codeResults.length} candidate results for "${query}".`,
                },
              ],
            };
          }

          const patternFormatted = formatPatternResults(patternMatches, output);
          const failedNote =
            failedFilesCount > 0 ? ` (${failedFilesCount} file(s) failed to parse)` : '';

          // Support extract parameter for pattern results
          if (extract) {
            const answer = await extractAnswerFromResults(
              patternFormatted,
              extract,
              'succ_search_code'
            );
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Found ${patternMatches.length} structural matches for pattern "${pattern}" (from ${codeResults.length} candidates for "${query}", extracted)${failedNote}:\n\n${answer}`,
                },
              ],
            };
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: `Found ${patternMatches.length} structural matches for pattern "${pattern}" (from ${codeResults.length} candidates for "${query}")${failedNote}:

${patternFormatted}`,
              },
            ],
          };
        }

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

        // Smart Result Compression: extract specific answer via LLM
        if (extract && codeResults.length > 0) {
          const answer = await extractAnswerFromResults(formatted, extract, 'succ_search_code');
          return {
            content: [
              {
                type: 'text' as const,
                text: `Found ${codeResults.length} code matches for "${query}" (extracted):\n\n${answer}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `${codeReadinessHeader}Found ${codeResults.length} code matches for "${query}"${modeLabel}:\n\n${formatted}`,
            },
          ],
        };
      } catch (error) {
        const msg = getErrorMessage(error);
        logWarn('search', 'Error searching code', { error: msg });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error searching code: ${msg}`,
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
