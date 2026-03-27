import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'path';
import {
  saveMemory,
  saveGlobalMemory,
  closeDb,
  closeGlobalDb,
} from '../../../lib/storage/index.js';
import { getConfig, getProjectRoot, isGlobalOnlyMode } from '../../../lib/config.js';
import { getEmbedding } from '../../../lib/embeddings.js';
import { scoreMemory, passesQualityThreshold, formatQualityScore } from '../../../lib/quality.js';
import { scanSensitive, formatMatches } from '../../../lib/sensitive-filter.js';
import { parseDuration } from '../../../lib/temporal.js';
import { logWarn } from '../../../lib/fault-logger.js';
import { projectPathParam, applyProjectPath } from '../../helpers.js';
import { rememberWithLLMExtraction } from './memory-helpers.js';

export function registerRememberTool(server: McpServer): void {
  server.registerTool(
    'succ_remember',
    {
      description:
        'Save important information to long-term memory. By default, uses LLM to extract structured facts from content. Use extract=false to save content as-is. In projects without .succ/, automatically saves to global memory. Use valid_until for temporary info.\n\nExamples:\n- Save a decision: succ_remember(content="Chose JWT over sessions", type="decision", tags=["architecture"])\n- With file context: succ_remember(content="handleAuth uses bcrypt", files=["src/auth.ts"])\n- Temp workaround: succ_remember(content="Rate limiter disabled for load test", valid_until="7d")',
      inputSchema: {
        content: z.string().describe('The information to remember'),
        tags: z
          .array(z.string())
          .optional()
          .default([])
          .describe(
            'Tags for categorization (e.g., ["decision", "architecture"]). ' +
              'Special: "hook-rule" makes this a dynamic pre-tool rule. ' +
              'Add "tool:{Name}" to filter by tool (Bash/Edit/Skill/etc), ' +
              '"match:{regex}" to filter by input. ' +
              'Set the type parameter to "error" to deny, "pattern" to ask confirmation.'
          ),
        source: z
          .string()
          .optional()
          .describe('Source context (e.g., "user request", "bug fix", file path)'),
        type: z
          .enum(['observation', 'decision', 'learning', 'error', 'pattern', 'dead_end'])
          .optional()
          .default('observation')
          .describe(
            'Memory type: observation (facts), decision (choices), learning (insights), error (failures), pattern (recurring themes), dead_end (failed approaches)'
          ),
        global: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'Save to global memory (shared across all projects). Auto-enabled if project has no .succ/'
          ),
        valid_from: z
          .string()
          .optional()
          .describe(
            'When this fact becomes valid. Use ISO date (2025-03-01) or duration from now (7d, 2w, 1m). For scheduled changes.'
          ),
        valid_until: z
          .string()
          .optional()
          .describe(
            'When this fact expires. Use ISO date (2025-12-31) or duration from now (7d, 30d). For sprint goals, temp workarounds.'
          ),
        files: z
          .array(z.string())
          .optional()
          .describe(
            'File paths this memory relates to. Adds file:{basename} tags for auto-recall on edit.'
          ),
        extract: z
          .boolean()
          .optional()
          .describe(
            'Extract structured facts using LLM (default: from config, typically true). Set to false to save content as-is.'
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
    async ({
      content,
      tags,
      source,
      type,
      global: useGlobal,
      valid_from,
      valid_until,
      files,
      extract,
      project_path,
    }) => {
      await applyProjectPath(project_path);
      // Force global mode if project not initialized
      const globalOnlyMode = isGlobalOnlyMode();
      if (globalOnlyMode && !useGlobal) {
        useGlobal = true;
      }

      // Add file:{basename} tags for file-linked memories
      if (files && files.length > 0) {
        const fileTags = files.map((f) => `file:${path.basename(f)}`);
        tags = [...new Set([...tags, ...fileTags])];
      }

      try {
        const config = getConfig();

        // Determine if LLM extraction should be used
        const configDefault = config.remember_extract_default !== false; // default true
        const useExtract = extract ?? configDefault;

        // If extraction is enabled, use LLM to extract structured facts
        if (useExtract) {
          return await rememberWithLLMExtraction({
            content,
            tags,
            source,
            type,
            useGlobal,
            valid_from,
            valid_until,
            config,
          });
        }

        // Check for sensitive information (non-interactive mode for MCP)
        if (config.sensitive_filter_enabled !== false) {
          const scanResult = scanSensitive(content);
          if (scanResult.hasSensitive) {
            if (config.sensitive_auto_redact) {
              // Auto-redact and continue
              content = scanResult.redactedText;
            } else {
              // Block - can't prompt user in MCP mode
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `⚠ Sensitive information detected:\n${formatMatches(scanResult.matches)}\n\nMemory not saved. Set "sensitive_auto_redact": true in config to auto-redact, or use CLI with --redact-sensitive flag.`,
                  },
                ],
              };
            }
          }
        }

        // Parse temporal validity periods
        let validFromDate: Date | undefined;
        let validUntilDate: Date | undefined;

        if (valid_from) {
          try {
            validFromDate = parseDuration(valid_from);
          } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid valid_from: ${errorMsg}. Use ISO date (2025-03-01) or duration (7d, 2w, 1m).`,
                },
              ],
              isError: true,
            };
          }
        }

        if (valid_until) {
          try {
            validUntilDate = parseDuration(valid_until);
          } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid valid_until: ${errorMsg}. Use ISO date (2025-12-31) or duration (7d, 30d).`,
                },
              ],
              isError: true,
            };
          }
        }

        const embedding = await getEmbedding(content);
        let qualityScore = null;
        if (config.quality_scoring_enabled !== false) {
          qualityScore = await scoreMemory(content);

          // Check if it passes the threshold
          if (!passesQualityThreshold(qualityScore)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `⚠ Memory quality too low: ${formatQualityScore(qualityScore)}\nThreshold: ${((config.quality_scoring_threshold ?? 0) * 100).toFixed(0)}%\nContent: "${content.substring(0, 100)}..."`,
                },
              ],
            };
          }
        }

        // Format validity period for display
        const validityStr =
          validFromDate || validUntilDate
            ? ` (valid: ${validFromDate ? validFromDate.toLocaleDateString() : '∞'} → ${validUntilDate ? validUntilDate.toLocaleDateString() : '∞'})`
            : '';

        if (useGlobal) {
          const projectName = path.basename(getProjectRoot());
          const result = await saveGlobalMemory(content, embedding, tags, source, projectName, {
            type,
          });

          const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
          const qualityStr = qualityScore ? ` ${formatQualityScore(qualityScore)}` : '';
          if (result.isDuplicate) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `⚠ Similar global memory exists (id: ${result.id}, ${((result.similarity || 0) * 100).toFixed(0)}% similar). Skipped duplicate.`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `✓ Remembered globally (id: ${result.id})${tagStr}${qualityStr}${validityStr} (project: ${projectName}):\n"${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`,
              },
            ],
          };
        }

        const result = await saveMemory(content, embedding, tags, source, {
          type,
          qualityScore: qualityScore
            ? { score: qualityScore.score, factors: qualityScore.factors }
            : undefined,
          validFrom: validFromDate,
          validUntil: validUntilDate,
        });

        const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
        const typeStr = type !== 'observation' ? ` (${type})` : '';
        const qualityStr = qualityScore ? ` ${formatQualityScore(qualityScore)}` : '';
        if (result.isDuplicate) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `⚠ Similar memory exists (id: ${result.id}, ${((result.similarity || 0) * 100).toFixed(0)}% similar). Skipped duplicate.`,
              },
            ],
          };
        }

        // Log to progress file (fire-and-forget)
        try {
          const { appendRawEntry } = await import('../../../lib/progress-log.js');
          await appendRawEntry(
            `manual | +1 fact (${type}) | topics: ${tags.join(', ') || 'untagged'}`
          );
        } catch (error) {
          logWarn('mcp-memory', 'Unable to append raw progress entry after remember save', {
            error: error instanceof Error ? error.message : String(error),
          });
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `✓ Remembered${typeStr} (id: ${result.id})${tagStr}${qualityStr}${validityStr}:\n"${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`,
            },
          ],
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logWarn('mcp-memory', 'Error saving memory', { error: errorMsg });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error saving memory: ${errorMsg}`,
            },
          ],
          isError: true,
        };
      } finally {
        closeDb();
        closeGlobalDb();
      }
    }
  );
}
