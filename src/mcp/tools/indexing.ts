/**
 * MCP Indexing tool — succ_index with actions: doc, code, analyze, refresh, symbols, scan
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { analyzeFile } from '../../commands/analyze.js';
import {
  projectPathParam,
  applyProjectPath,
  createToolResponse,
  createErrorResponse,
} from '../helpers.js';
import { logWarn } from '../../lib/fault-logger.js';
import { getErrorMessage } from '../../lib/errors.js';

export function registerIndexingTools(server: McpServer) {
  server.registerTool(
    'succ_index',
    {
      description:
        'Index files, analyze source code, refresh stale indexes, extract AST symbols, or scan all project code.\n\nExamples:\n- Index doc: succ_index(action="doc", file="docs/api.md")\n- Index code: succ_index(action="code", file="src/auth.ts")\n- Analyze: succ_index(action="analyze", file="src/server.ts")\n- Refresh stale: succ_index(action="refresh")\n- Symbols: succ_index(action="symbols", file="src/auth.ts", type="function")\n- Scan all code: succ_index(action="scan")\n- Scan subdir: succ_index(action="scan", path="src/features")',
      inputSchema: {
        action: z
          .enum(['doc', 'code', 'analyze', 'refresh', 'symbols', 'scan'])
          .describe(
            'doc = index documentation file, code = index source code file, analyze = generate brain vault docs, refresh = reindex stale/deleted files, symbols = extract AST symbols, scan = discover and index all project code files'
          ),
        file: z
          .string()
          .optional()
          .describe('File path (required for doc, code, analyze, symbols)'),
        path: z
          .string()
          .optional()
          .describe('Subdirectory to scope scan (for scan action, e.g. "src/features")'),
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
    async ({ action, file, force, mode, type, path: scanPath, project_path }) => {
      await applyProjectPath(project_path);

      if (['doc', 'code', 'analyze', 'symbols'].includes(action) && !file) {
        return createErrorResponse(`"file" is required for action="${action}"`);
      }

      switch (action) {
        case 'doc': {
          try {
            const { indexDocFile } = await import('../../commands/index.js');
            const result = await indexDocFile(file!, { force });

            if (!result.success) {
              return createErrorResponse(result.error || 'Failed to index file');
            }

            if (result.skipped) {
              return createToolResponse(`Skipped: ${result.reason}`);
            }

            return createToolResponse(`Indexed: ${file} (${result.chunks} chunks)`);
          } catch (error) {
            const msg = getErrorMessage(error);
            logWarn('indexing', 'Error indexing doc file', { error: msg });
            return createErrorResponse(`Error indexing file: ${msg}`);
          }
        }

        case 'code': {
          try {
            const { indexCodeFile } = await import('../../commands/index-code.js');
            const result = await indexCodeFile(file!, { force });

            if (!result.success) {
              return createErrorResponse(result.error || 'Failed to index file');
            }

            if (result.skipped) {
              return createToolResponse(`Skipped: ${result.reason}`);
            }

            return createToolResponse(`Indexed: ${file} (${result.chunks} chunks)`);
          } catch (error) {
            const msg = getErrorMessage(error);
            logWarn('indexing', 'Error indexing code file', { error: msg });
            return createErrorResponse(`Error indexing code file: ${msg}`);
          }
        }

        case 'analyze': {
          try {
            const result = await analyzeFile(file!, { mode });

            if (result.success) {
              return createToolResponse(`Analyzed: ${file}\nOutput: ${result.outputPath}`);
            } else {
              return createErrorResponse(`Error analyzing file: ${result.error}`);
            }
          } catch (error) {
            const msg = getErrorMessage(error);
            logWarn('indexing', 'Error analyzing file', { error: msg });
            return createErrorResponse(`Error analyzing file: ${msg}`);
          }
        }

        case 'refresh': {
          try {
            const { getProjectRoot } = await import('../../lib/config.js');
            const { reindexFiles } = await import('../../commands/reindex.js');
            const projectRoot = getProjectRoot();
            const result = await reindexFiles(projectRoot);

            if (result.reindexed === 0 && result.cleaned === 0 && result.errors === 0) {
              return createToolResponse(`All ${result.total} indexed files are up to date.`);
            }

            const lines = [...result.details];
            if (result.reindexed > 0) lines.push(`Reindexed: ${result.reindexed}`);
            if (result.cleaned > 0) lines.push(`Cleaned: ${result.cleaned} deleted entries`);
            if (result.errors > 0) lines.push(`Errors: ${result.errors}`);

            return createToolResponse(lines.join('\n'));
          } catch (error) {
            const msg = getErrorMessage(error);
            logWarn('indexing', 'Error during reindex', { error: msg });
            return createErrorResponse(`Error during reindex: ${msg}`);
          }
        }

        case 'symbols': {
          try {
            const fs = await import('fs');
            const path = await import('path');

            const absolutePath = path.default.resolve(file!);
            if (!fs.default.existsSync(absolutePath)) {
              return createErrorResponse(`File not found: ${file}`);
            }

            const content = fs.default.readFileSync(absolutePath, 'utf-8');
            const { parseCode } = await import('../../lib/tree-sitter/parser.js');
            const { extractSymbols } = await import('../../lib/tree-sitter/extractor.js');
            const { getLanguageForExtension } = await import('../../lib/tree-sitter/types.js');

            const ext = absolutePath.split('.').pop() || '';
            const language = getLanguageForExtension(ext);
            if (!language) {
              return createErrorResponse(
                `Unsupported language for extension .${ext}. Supported: ts, js, py, go, rs, java, kt, c, cpp, cs, php, rb, swift`
              );
            }

            const tree = await parseCode(content, language);
            if (!tree) {
              return createErrorResponse(
                `Failed to parse ${file} — tree-sitter grammar not available for ${language}`
              );
            }

            try {
              let symbols = await extractSymbols(tree, content, language);

              if (type !== 'all') {
                symbols = symbols.filter((s) => s.type === type);
              }

              if (symbols.length === 0) {
                return createToolResponse(
                  `No ${type === 'all' ? '' : type + ' '}symbols found in ${file}`
                );
              }

              const lines = symbols.map((s) => {
                const sig = s.signature ? `: ${s.signature}` : '';
                const doc = s.docComment ? ` — ${s.docComment.split('\n')[0]}` : '';
                return `  ${s.type} **${s.name}**${sig} (L${s.startRow + 1}-${s.endRow + 1})${doc}`;
              });

              return createToolResponse(
                `${symbols.length} symbols in ${file} (${language}):\n\n${lines.join('\n')}`
              );
            } finally {
              tree.delete();
            }
          } catch (error) {
            return createErrorResponse(
              `Error extracting symbols: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }

        case 'scan': {
          try {
            const { scanCode } = await import('../../commands/scan-code.js');
            const result = await scanCode({ filterPath: scanPath, force });

            const lines = [
              `Scanned: ${result.totalScanned} files (source: ${result.source})`,
              `Code files: ${result.totalCode}`,
              `Indexed: ${result.indexed} (${result.newCount} new, ${result.updatedCount} updated)`,
              `Unchanged: ${result.unchanged}`,
              `Chunks generated: ${result.chunks}`,
            ];

            if (result.skippedSize > 0) lines.push(`Skipped (too large): ${result.skippedSize}`);
            if (result.skippedExtension > 0)
              lines.push(`Skipped (extension): ${result.skippedExtension}`);
            if (result.skippedIgnore > 0)
              lines.push(`Skipped (.succignore): ${result.skippedIgnore}`);
            if (result.errors > 0) {
              lines.push(`Errors: ${result.errors}`);
              for (const detail of result.errorDetails.slice(0, 10)) {
                lines.push(`  - ${detail}`);
              }
            }

            return createToolResponse(lines.join('\n'));
          } catch (error: unknown) {
            const msg = getErrorMessage(error);
            logWarn('indexing', 'Error during scan', { error: msg });
            return createErrorResponse(msg);
          }
        }

        default:
          return createErrorResponse(`Unknown action: ${action}`);
      }
    }
  );
}