/**
 * MCP Review tool
 *
 * - succ_review: Generate review context pack from git diff
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { generateReviewContext } from '../../lib/review/context-pack.js';
import { projectPathParam, applyProjectPath } from '../helpers.js';
import { closeDb } from '../../lib/storage/index.js';
import { logWarn } from '../../lib/fault-logger.js';
import { getErrorMessage } from '../../lib/errors.js';

export function registerReviewTools(server: McpServer) {
  server.registerTool(
    'succ_review',
    {
      description:
        'Generate a review context pack from a git diff. Returns summary, changed symbols, related code, relevant memories, recent history, review focus areas, and blast-radius estimate.\n\nExamples:\n- Review last commit: succ_review(diff_ref="HEAD~1")\n- Review branch diff: succ_review(diff_ref="main..HEAD")\n- Review staged changes: succ_review(diff_ref="--cached")',
      inputSchema: {
        diff_ref: z
          .string()
          .default('HEAD~1')
          .describe(
            'Git diff reference (e.g., "HEAD~1", "main..feature", "--cached" for staged changes)'
          ),
        max_related: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(10)
          .describe('Maximum number of related symbols to return (default: 10, max: 100)'),
        max_memories: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(10)
          .describe('Maximum number of relevant memories to return (default: 10, max: 100)'),
        skip_llm: z
          .boolean()
          .optional()
          .default(false)
          .describe('Skip LLM summary generation (faster, less detailed)'),
        project_path: projectPathParam,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ diff_ref, max_related, max_memories, skip_llm, project_path }) => {
      try {
        await applyProjectPath(project_path);
        const pack = await generateReviewContext(diff_ref, {
          maxRelatedSymbols: max_related,
          maxMemories: max_memories,
          generateLLMSummary: !skip_llm,
        });

        // Format as readable markdown
        const sections: string[] = [];

        // Summary
        sections.push(`## Review Context Pack\n\n${pack.summary}`);

        // Stats
        sections.push(
          `### Changes: ${pack.diffStats.files} files, +${pack.diffStats.additions} -${pack.diffStats.deletions}`
        );

        // Changed files
        if (pack.changedFiles.length > 0) {
          const fileList = pack.changedFiles
            .map((f) => {
              const status = f.isNew ? ' (new)' : f.isDeleted ? ' (deleted)' : '';
              return `- ${f.path}${status}: +${f.additions} -${f.deletions}`;
            })
            .join('\n');
          sections.push(`### Changed Files\n${fileList}`);
        }

        // Changed symbols
        if (pack.changedSymbols.length > 0) {
          const symList = pack.changedSymbols.map((s) => `- ${s.file}: \`${s.symbol}\``).join('\n');
          sections.push(`### Changed Symbols\n${symList}`);
        }

        // Related code
        if (pack.relatedSymbols.length > 0) {
          const relList = pack.relatedSymbols
            .map((s) => `- ${s.file}: \`${s.symbol}\` (${(s.similarity * 100).toFixed(0)}% match)`)
            .join('\n');
          sections.push(`### Related Code (Not in Diff)\n${relList}`);
        }

        // Relevant memories
        if (pack.relevantMemories.length > 0) {
          const memList = pack.relevantMemories
            .map(
              (m) =>
                `- [#${m.id}] ${m.content.substring(0, 150)}${m.content.length > 150 ? '...' : ''}`
            )
            .join('\n');
          sections.push(`### Relevant Memories\n${memList}`);
        }

        // Recent history
        if (pack.recentHistory.length > 0) {
          const histList = pack.recentHistory
            .map((h) => `- ${h.file}:\n  ${h.commits.slice(0, 3).join('\n  ')}`)
            .join('\n');
          sections.push(`### Recent History\n${histList}`);
        }

        // Review focus
        if (pack.reviewFocus.length > 0) {
          const focusList = pack.reviewFocus.map((f) => `- ${f}`).join('\n');
          sections.push(`### Review Focus Areas\n${focusList}`);
        }

        // Blast radius
        sections.push(`### Blast Radius: ${pack.blastRadius}`);

        return {
          content: [
            {
              type: 'text' as const,
              text: sections.join('\n\n'),
            },
          ],
        };
      } catch (error) {
        logWarn('review', 'Review context generation failed', {
          error: getErrorMessage(error),
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error generating review context: ${getErrorMessage(error)}`,
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
