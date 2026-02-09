/**
 * MCP Indexing tools
 *
 * - succ_index_file: Index a single documentation file
 * - succ_analyze_file: Analyze a source file and generate documentation
 * - succ_index_code_file: Index a single source code file
 * - succ_reindex: Detect and fix stale/deleted index entries
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { analyzeFile } from '../../commands/analyze.js';
import { projectPathParam, applyProjectPath } from '../helpers.js';

export function registerIndexingTools(server: McpServer) {
  // Tool: succ_index_file - Index a single documentation file
  server.tool(
    'succ_index_file',
    'Index a single file for semantic search. Faster than full reindex for small changes. Embedding modes (configured via config.json): local (Transformers.js, default), openrouter (cloud API), custom (Ollama/LM Studio/llama.cpp).',
    {
      file: z.string().describe('Path to the file to index'),
      force: z.boolean().optional().default(false).describe('Force reindex even if unchanged'),
      project_path: projectPathParam,
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
  server.tool(
    'succ_analyze_file',
    'Analyze a single source file and generate documentation in brain vault. Modes: claude (CLI with Haiku), local (Ollama/LM Studio), openrouter (cloud API). Check succ_status first - if analyze daemon is running, it handles this automatically.',
    {
      file: z.string().describe('Path to the file to analyze'),
      mode: z.enum(['claude', 'local', 'openrouter']).optional().describe('claude = Claude CLI (Haiku), local = Ollama/LM Studio/llama.cpp, openrouter = cloud API (default: from config)'),
      project_path: projectPathParam,
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
  server.tool(
    'succ_index_code_file',
    'Index a single source code file for semantic search. Faster than full index-code for small changes. Embedding modes (configured via config.json): local (Transformers.js, default), openrouter (cloud API), custom (Ollama/LM Studio/llama.cpp).',
    {
      file: z.string().describe('Path to the code file to index'),
      force: z.boolean().optional().default(false).describe('Force reindex even if unchanged'),
      project_path: projectPathParam,
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
  server.tool(
    'succ_reindex',
    'Detect stale (modified) and deleted files in the index, then re-index stale files and clean up deleted entries. Uses mtime + hash comparison for efficient detection.',
    {
      project_path: projectPathParam,
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
            content: [{ type: 'text' as const, text: `All ${result.total} indexed files are up to date.` }],
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
}
