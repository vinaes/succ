/**
 * MCP Indexing tools
 *
 * - succ_index_file: Index a single documentation file
 * - succ_analyze_file: Analyze a source file and generate documentation
 * - succ_index_code_file: Index a single source code file
 * - succ_reindex: Detect and fix stale/deleted index entries
 * - succ_symbols: Extract AST symbols from a source file
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { analyzeFile } from '../../commands/analyze.js';
import { projectPathParam, applyProjectPath } from '../helpers.js';

export function registerIndexingTools(server: McpServer) {
  // Tool: succ_index_file - Index a single documentation file
  server.registerTool(
    'succ_index_file',
    {
      description:
        'Index a single file for semantic search. Faster than full reindex for small changes. Embedding modes (configured via config.json): local (Transformers.js, default), openrouter (cloud API), custom (Ollama/LM Studio/llama.cpp).\n\nExamples:\n- succ_index_file(file="docs/api.md")\n- Force: succ_index_file(file=".succ/brain/architecture.md", force=true)',
      inputSchema: {
        file: z.string().describe('Path to the file to index'),
        force: z.boolean().optional().default(false).describe('Force reindex even if unchanged'),
        project_path: projectPathParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ file, force, project_path }) => {
      await applyProjectPath(project_path);
      try {
        const { indexDocFile } = await import('../../commands/index.js');
        const result = await indexDocFile(file, { force });

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
  );

  // Tool: succ_analyze_file - Analyze a single file and generate documentation
  server.registerTool(
    'succ_analyze_file',
    {
      description:
        'Analyze a single source file and generate documentation in brain vault. Modes: claude (CLI with Haiku), local (Ollama/LM Studio), openrouter (cloud API). Check succ_status first - if analyze daemon is running, it handles this automatically.\n\nExamples:\n- succ_analyze_file(file="src/auth.ts")\n- Use API: succ_analyze_file(file="src/server.ts", mode="api")',
      inputSchema: {
        file: z.string().describe('Path to the file to analyze'),
        mode: z
          .enum(['claude', 'api'])
          .optional()
          .describe(
            'claude = Claude CLI (Haiku), api = any OpenAI-compatible endpoint (default: from config)'
          ),
        project_path: projectPathParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ file, mode, project_path }) => {
      await applyProjectPath(project_path);
      try {
        const result = await analyzeFile(file, { mode });

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
  );

  // Tool: succ_index_code_file - Index a single code file
  server.registerTool(
    'succ_index_code_file',
    {
      description:
        'Index a single source code file for semantic search. Faster than full index-code for small changes. Embedding modes (configured via config.json): local (Transformers.js, default), openrouter (cloud API), custom (Ollama/LM Studio/llama.cpp).\n\nExamples:\n- succ_index_code_file(file="src/lib/auth.ts")\n- Force: succ_index_code_file(file="src/lib/storage/index.ts", force=true)',
      inputSchema: {
        file: z.string().describe('Path to the code file to index'),
        force: z.boolean().optional().default(false).describe('Force reindex even if unchanged'),
        project_path: projectPathParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ file, force, project_path }) => {
      await applyProjectPath(project_path);
      try {
        const { indexCodeFile } = await import('../../commands/index-code.js');
        const result = await indexCodeFile(file, { force });

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
  );

  // Tool: succ_reindex - Detect and fix stale/deleted index entries
  server.registerTool(
    'succ_reindex',
    {
      description:
        'Detect stale (modified) and deleted files in the index, then re-index stale files and clean up deleted entries. Uses mtime + hash comparison for efficient detection.',
      inputSchema: {
        project_path: projectPathParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project_path }) => {
      await applyProjectPath(project_path);
      try {
        const { getProjectRoot } = await import('../../lib/config.js');
        const { reindexFiles } = await import('../../commands/reindex.js');
        const projectRoot = getProjectRoot();
        const result = await reindexFiles(projectRoot);

        if (result.reindexed === 0 && result.cleaned === 0 && result.errors === 0) {
          return {
            content: [
              { type: 'text' as const, text: `All ${result.total} indexed files are up to date.` },
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
  );

  // Tool: succ_symbols - Extract AST symbols from a source file using tree-sitter
  server.registerTool(
    'succ_symbols',
    {
      description:
        'Extract functions, classes, interfaces, and type definitions from a source file using tree-sitter AST parsing. Returns symbol names, types, signatures, and line numbers. Supports 13 languages: TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, C, C++, C#, PHP, Ruby, Swift.\n\nExamples:\n- All symbols: succ_symbols(file="src/auth.ts")\n- Functions only: succ_symbols(file="src/server.ts", type="function")',
      inputSchema: {
        file: z.string().describe('Path to the source file to extract symbols from'),
        type: z
          .enum(['all', 'function', 'method', 'class', 'interface', 'type_alias'])
          .optional()
          .default('all')
          .describe('Filter by symbol type (default: all)'),
        project_path: projectPathParam,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ file, type, project_path }) => {
      await applyProjectPath(project_path);
      try {
        const fs = await import('fs');
        const path = await import('path');

        const absolutePath = path.default.resolve(file);
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
          content: [{ type: 'text' as const, text: `Error extracting symbols: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
