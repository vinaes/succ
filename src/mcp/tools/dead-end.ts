/**
 * MCP Dead-End Tracking tool
 *
 * succ_dead_end: Record a failed approach to prevent retrying it.
 * Stores "tried X, didn't work because Y" knowledge.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { saveMemory, searchMemories, closeDb } from '../../lib/storage/index.js';
import { getConfig, isGlobalOnlyMode } from '../../lib/config.js';
import { getEmbedding } from '../../lib/embeddings.js';
import { scoreMemory, passesQualityThreshold, formatQualityScore } from '../../lib/quality.js';
import { scanSensitive, formatMatches } from '../../lib/sensitive-filter.js';
import { projectPathParam, applyProjectPath } from '../helpers.js';

export function registerDeadEndTools(server: McpServer) {
  server.registerTool(
    'succ_dead_end',
    {
      description:
        'Record a failed approach to prevent retrying it. Stores "tried X, didn\'t work because Y" knowledge. Dead-ends are automatically boosted in recall results so AI agents see them before retrying a failed approach.\n\nExamples:\n- succ_dead_end(approach="Redis for sessions", why_failed="Memory too high for VPS", tags=["infra"])',
      inputSchema: {
        approach: z.string().describe('What was tried (e.g., "Using Redis for session storage")'),
        why_failed: z
          .string()
          .describe('Why it failed (e.g., "Memory usage too high for our VPS tier")'),
        context: z
          .string()
          .optional()
          .describe('Additional context (file paths, error messages, etc.)'),
        tags: z.array(z.string()).optional().default([]).describe('Tags for categorization'),
        project_path: projectPathParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ approach, why_failed, context, tags, project_path }) => {
      await applyProjectPath(project_path);
      if (isGlobalOnlyMode()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Dead-end tracking requires a project with .succ/ initialized. Run `succ init` first.',
            },
          ],
          isError: true,
        };
      }

      try {
        const config = getConfig();

        // Compose dead-end content
        let content = `DEAD END: Tried "${approach}" — Failed because: ${why_failed}`;
        if (context) {
          content += `\nContext: ${context}`;
        }

        // Check for sensitive information
        if (config.sensitive_filter_enabled !== false) {
          const scanResult = scanSensitive(content);
          if (scanResult.hasSensitive) {
            if (config.sensitive_auto_redact) {
              content = scanResult.redactedText;
            } else {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `⚠ Sensitive information detected:\n${formatMatches(scanResult.matches)}\n\nDead-end not saved.`,
                  },
                ],
              };
            }
          }
        }

        // Get embedding for dedup check and saving
        const embedding = await getEmbedding(content);

        // Dedup: check if a similar dead-end already exists
        const existing = await searchMemories(embedding, 1, 0.85);
        if (existing.length > 0 && existing[0].content.startsWith('DEAD END:')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `⚠ Similar dead-end already recorded (id: ${existing[0].id}, ${(existing[0].similarity * 100).toFixed(0)}% similar):\n"${existing[0].content.substring(0, 120)}..."`,
              },
            ],
          };
        }

        // Score quality
        let qualityScore = null;
        if (config.quality_scoring_enabled !== false) {
          qualityScore = await scoreMemory(content);
          if (!passesQualityThreshold(qualityScore)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `⚠ Dead-end quality too low: ${formatQualityScore(qualityScore)}`,
                },
              ],
            };
          }
        }

        // Ensure 'dead-end' tag is always present
        const allTags = [...new Set([...tags, 'dead-end'])];

        const result = await saveMemory(content, embedding, allTags, 'dead-end-tracking', {
          type: 'dead_end',
          qualityScore: qualityScore
            ? { score: qualityScore.score, factors: qualityScore.factors }
            : undefined,
        });

        if (result.isDuplicate) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `⚠ Similar memory already exists (id: ${result.id}). Dead-end not saved as duplicate.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `✓ Dead-end recorded (id: ${result.id}):\n  Approach: ${approach}\n  Why failed: ${why_failed}${context ? `\n  Context: ${context.substring(0, 100)}` : ''}\n\nThis will be surfaced when similar approaches are considered in future sessions.`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error recording dead-end: ${error.message}`,
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
