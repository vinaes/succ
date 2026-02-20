/**
 * MCP Indexing tool — succ_index with actions: doc, code, analyze, refresh, symbols
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { analyzeFile } from '../../commands/analyze.js';
import { projectPathParam, applyProjectPath } from '../helpers.js';

export function registerIndexingTools(server: McpServer) {
  server.registerTool(
    'succ_index',
    {
      description:
        'Index files, analyze source code, refresh stale indexes, or extract AST symbols.\n\nExamples:\n- Index doc: succ_index(action="doc", file="docs/api.md")\n- Index code: succ_index(action="code", file="src/auth.ts")\n- Analyze: succ_index(action="analyze", file="src/server.ts")\n- Refresh stale: succ_index(action="refresh")\n- Symbols: succ_index(action="symbols", file="src/auth.ts", type="function")',
      inputSchema: {
        action: z
          .enum(['doc', 'code', 'analyze', 'refresh', 'symbols'])
          .describe(
            'doc = index documentation file, code = index source code file, analyze = generate brain vault docs, refresh = reindex stale/deleted files, symbols = extract AST symbols'
          ),
        file: z
          .string()
          .optional()
          .describe('File path (required for doc, code, analyze, symbols)'),
        force: z
          .boolean()
          .optional()
          .default(false)
          .describe('Force reindex even if unchanged (for doc, code)'),
        mode: z
          .enum(['claude', 'api'])
          .optional()
          .describe('Analysis mode: claude = Claude CLI, api = OpenAI-compatible (for analyze)'),
        type: z
          .enum(['all', 'function', 'method', 'class', 'interface', 'type_alias'])
          .optional()
          .default('all')
          .describe('Symbol type filter (for symbols)'),
        project_path: projectPathParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ action, file, force, mode, type, project_path }) => {
      await applyProjectPath(project_path);

      if (['doc', 'code', 'analyze', 'symbols'].includes(action) && !file) {
        return {
          content: [{ type: 'text' as const, text: `"file" is required for action="${action}"` }],
          isError: true,
        };
      }

      switch (action) {
        case 'doc': {
          try {
            const { indexDocFile } = await import('../../commands/index.js');
            const result = await indexDocFile(file!, { force });

            if (!result.success) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: result.error || 'Failed to index file',
                  },
                ],
                isError: true,
              };
            }

            if (result.skipped) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Skipped: ${result.reason}`,
                  },
                ],
              };
            }

            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Indexed: ${file} (${result.chunks} chunks)`,
                },
              ],
            };
          } catch (error: any) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error indexing file: ${error.message}`,
                },
              ],
              isError: true,
            };
          }
        }

        case 'code': {
          try {
            const { indexCodeFile } = await import('../../commands/index-code.js');
            const result = await indexCodeFile(file!, { force });

            if (!result.success) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: result.error || 'Failed to index file',
                  },
                ],
                isError: true,
              };
            }

            if (result.skipped) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Skipped: ${result.reason}`,
                  },
                ],
              };
            }

            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Indexed: ${file} (${result.chunks} chunks)`,
                },
              ],
            };
          } catch (error: any) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error indexing code file: ${error.message}`,
                },
              ],
              isError: true,
            };
          }
        }

        case 'analyze': {
          try {
            const result = await analyzeFile(file!, { mode });

            if (result.success) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Analyzed: ${file}\nOutput: ${result.outputPath}`,
                  },
                ],
              };
            } else {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Error analyzing file: ${result.error}`,
                  },
                ],
                isError: true,
              };
            }
          } catch (error: any) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error analyzing file: ${error.message}`,
                },
              ],
              isError: true,
            };
          }
        }

        case 'refresh': {
          try {
            const { getProjectRoot } = await import('../../lib/config.js');
            const { reindexFiles } = await import('../../commands/reindex.js');
            const projectRoot = getProjectRoot();
            const result = await reindexFiles(projectRoot);

            if (result.reindexed === 0 && result.cleaned === 0 && result.errors === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `All ${result.total} indexed files are up to date.`,
                  },
                ],
              };
            }

            const lines = [...result.details];
            if (result.reindexed > 0) lines.push(`Reindexed: ${result.reindexed}`);
            if (result.cleaned > 0) lines.push(`Cleaned: ${result.cleaned} deleted entries`);
            if (result.errors > 0) lines.push(`Errors: ${result.errors}`);

            return {
              content: [{ type: 'text' as const, text: lines.join('\n') }],
            };
          } catch (error: any) {
            return {
              content: [{ type: 'text' as const, text: `Error during reindex: ${error.message}` }],
              isError: true,
            };
          }
        }

        case 'symbols': {
          try {
            const fs = await import('fs');
            const path = await import('path');

            const absolutePath = path.default.resolve(file!);
            if (!fs.default.existsSync(absolutePath)) {
              return {
                content: [{ type: 'text' as const, text: `File not found: ${file}` }],
                isError: true,
              };
            }

            const content = fs.default.readFileSync(absolutePath, 'utf-8');
            const { parseCode } = await import('../../lib/tree-sitter/parser.js');
            const { extractSymbols } = await import('../../lib/tree-sitter/extractor.js');
            const { getLanguageForExtension } = await import('../../lib/tree-sitter/types.js');

            const ext = absolutePath.split('.').pop() || '';
            const language = getLanguageForExtension(ext);
            if (!language) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Unsupported language for extension .${ext}. Supported: ts, js, py, go, rs, java, kt, c, cpp, cs, php, rb, swift`,
                  },
                ],
              };
            }

            const tree = await parseCode(content, language);
            if (!tree) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Failed to parse ${file} — tree-sitter grammar not available for ${language}`,
                  },
                ],
                isError: true,
              };
            }

            try {
              let symbols = await extractSymbols(tree, content, language);

              if (type !== 'all') {
                symbols = symbols.filter((s) => s.type === type);
              }

              if (symbols.length === 0) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: `No ${type === 'all' ? '' : type + ' '}symbols found in ${file}`,
                    },
                  ],
                };
              }

              const lines = symbols.map((s) => {
                const sig = s.signature ? `: ${s.signature}` : '';
                const doc = s.docComment ? ` — ${s.docComment.split('\n')[0]}` : '';
                return `  ${s.type} **${s.name}**${sig} (L${s.startRow + 1}-${s.endRow + 1})${doc}`;
              });

              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `${symbols.length} symbols in ${file} (${language}):\n\n${lines.join('\n')}`,
                  },
                ],
              };
            } finally {
              tree.delete();
            }
          } catch (error: any) {
            return {
              content: [
                { type: 'text' as const, text: `Error extracting symbols: ${error.message}` },
              ],
              isError: true,
            };
          }
        }

        default:
          return {
            content: [{ type: 'text' as const, text: `Unknown action: ${action}` }],
            isError: true,
          };
      }
    }
  );
}
