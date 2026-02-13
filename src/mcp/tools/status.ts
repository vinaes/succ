/**
 * MCP Status tools
 *
 * - succ_status: Get index status, memory stats, daemon statuses
 * - succ_stats: Get token savings statistics
 * - succ_score: Get AI-readiness score
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getStats,
  getRecentGlobalMemories,
  getMemoryStats,
  getAllMemoriesForRetention,
  getStaleFileCount,
  getTokenStatsAggregated,
  getWebSearchSummary,
  getStorageDispatcher,
  closeDb,
  type TokenEventType,
} from '../../lib/storage/index.js';
import {
  getDaemonStatuses,
  isGlobalOnlyMode,
  getIdleReflectionConfig,
  getRetentionConfig,
  getProjectRoot,
} from '../../lib/config.js';
import { formatTokens, compressionPercent } from '../../lib/token-counter.js';
import { analyzeRetention } from '../../lib/retention.js';
import { projectPathParam, applyProjectPath } from '../helpers.js';

export function registerStatusTools(server: McpServer) {
  // Tool: succ_status - Get index status
  server.tool(
    'succ_status',
    'Get the current status of succ (indexed files, memories, last update, daemon statuses). Shows global-only mode if project not initialized.',
    {
      project_path: projectPathParam,
    },
    async ({ project_path }) => {
      await applyProjectPath(project_path);
      const globalOnlyMode = isGlobalOnlyMode();

      try {
        // In global-only mode, show limited status with debug info
        if (globalOnlyMode) {
          const globalMemStats = await getRecentGlobalMemories(1);
          const globalCount = globalMemStats.length > 0 ? 'available' : 'empty';

          return {
            content: [
              {
                type: 'text' as const,
                text: `## Mode\n  Global-only (no .succ/ in this project)\n  Run \`succ init\` to enable full features\n\n## Global Memory\n  Status: ${globalCount}\n  Use succ_recall and succ_remember for cross-project memories\n\nTip: Pass project_path to succ tools to access project-local data.`,
              },
            ],
          };
        }

        const stats = await getStats();
        const memStats = await getMemoryStats();
        const daemons = await getDaemonStatuses();

        // Format type breakdown
        const typeBreakdown = Object.entries(memStats.by_type)
          .map(([type, count]) => `    ${type}: ${count}`)
          .join('\n');

        // Format daemon statuses
        const daemonLines = daemons
          .map((d) => {
            const statusIcon = d.running ? '🟢' : '⚫';
            const pidInfo = d.running && d.pid ? ` (PID: ${d.pid})` : '';
            return `  ${statusIcon} ${d.name}: ${d.running ? 'running' : 'stopped'}${pidInfo}`;
          })
          .join('\n');

        const status = [
          '## Documents',
          `  Files indexed: ${stats.total_files}`,
          `  Total chunks: ${stats.total_documents}`,
          `  Last indexed: ${stats.last_indexed || 'Never'}`,
          '',
          '## Memories',
          `  Total: ${memStats.total_memories}`,
          typeBreakdown ? `  By type:\n${typeBreakdown}` : '',
          memStats.oldest_memory
            ? `  Oldest: ${new Date(memStats.oldest_memory).toLocaleDateString()}`
            : '',
          memStats.newest_memory
            ? `  Newest: ${new Date(memStats.newest_memory).toLocaleDateString()}`
            : '',
          memStats.stale_count > 0
            ? `  ⚠ Stale (>30 days): ${memStats.stale_count} - consider cleanup with succ_forget`
            : '',
        ];

        // Index freshness (only show if stale files detected)
        try {
          const projectRoot = getProjectRoot();
          const freshness = await getStaleFileCount(projectRoot);
          if (freshness.stale > 0 || freshness.deleted > 0) {
            status.push(
              '',
              '## Index Freshness',
              `  Indexed files: ${freshness.total}`,
              freshness.stale > 0 ? `  Stale (modified since indexing): ${freshness.stale}` : '',
              freshness.deleted > 0
                ? `  Missing (deleted since indexing): ${freshness.deleted}`
                : '',
              '  Run `succ reindex` to refresh'
            );
          }
        } catch {
          // Skip freshness check if it fails
        }

        // Retention health (lightweight analysis)
        try {
          const retentionMemories = await getAllMemoriesForRetention();
          if (retentionMemories.length > 0) {
            const retConfig = getRetentionConfig();
            const analysis = analyzeRetention(retentionMemories, {
              use_temporal_decay: retConfig.use_temporal_decay,
              keep_threshold: retConfig.keep_threshold,
              delete_threshold: retConfig.delete_threshold,
            });
            const retStats = analysis.stats;
            status.push(
              '',
              '## Retention Health',
              `  Keep: ${retStats.keepCount} | Warn: ${retStats.warnCount} | Cleanup: ${retStats.deleteCount}`,
              `  Avg effective score: ${retStats.avgEffectiveScore}`
            );
            if (retStats.deleteCount > 0) {
              status.push(
                `  ⚠ ${retStats.deleteCount} memories below threshold - run \`succ retention --auto-cleanup --dry-run\``
              );
            }
          }
        } catch {
          // Skip retention health if it fails
        }

        // Session counters (in-memory, no DB query)
        try {
          const d = await getStorageDispatcher();
          const sc = d.getSessionCounters();
          const totalOps =
            sc.memoriesCreated +
            sc.globalMemoriesCreated +
            sc.memoriesDuplicated +
            sc.recallQueries +
            sc.searchQueries +
            sc.codeSearchQueries;
          if (totalOps > 0) {
            const typesList = Object.entries(sc.typesCreated)
              .map(([t, n]) => `${t} (${n})`)
              .join(', ');
            status.push(
              '',
              '## Current Session',
              `  Memories created: ${sc.memoriesCreated + sc.globalMemoriesCreated}${sc.memoriesCreated > 0 && sc.globalMemoriesCreated > 0 ? ` (${sc.memoriesCreated} local, ${sc.globalMemoriesCreated} global)` : ''}`,
              sc.memoriesDuplicated > 0 ? `  Duplicates skipped: ${sc.memoriesDuplicated}` : '',
              `  Recall queries: ${sc.recallQueries}`,
              `  Search queries: ${sc.searchQueries}`,
              sc.codeSearchQueries > 0 ? `  Code search queries: ${sc.codeSearchQueries}` : '',
              sc.webSearchQueries > 0
                ? `  Web searches: ${sc.webSearchQueries} ($${(sc.webSearchCostUsd || 0).toFixed(4)})`
                : '',
              typesList ? `  Types: ${typesList}` : '',
              `  Session started: ${new Date(sc.startedAt).toLocaleTimeString()}`
            );
          }
        } catch {
          /* ignore */
        }

        // Web search history
        try {
          const wsSummary = await getWebSearchSummary();
          if (wsSummary.total_searches > 0) {
            status.push(
              '',
              '## Web Searches',
              `  Total: ${wsSummary.total_searches} ($${wsSummary.total_cost_usd.toFixed(4)})`,
              `  Today: ${wsSummary.today_searches} ($${wsSummary.today_cost_usd.toFixed(4)})`
            );
          }
        } catch {
          /* ignore */
        }

        status.push('', '## Daemons', daemonLines);

        const statusText = status.filter(Boolean).join('\n');

        return {
          content: [
            {
              type: 'text' as const,
              text: statusText,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error getting status: ${error.message}`,
            },
          ],
          isError: true,
        };
      } finally {
        closeDb();
      }
    }
  );

  // Tool: succ_stats - Get token savings statistics
  server.tool(
    'succ_stats',
    'Get token savings statistics. Shows how many tokens were saved by using RAG search instead of loading full files.',
    {
      project_path: projectPathParam,
    },
    async ({ project_path }) => {
      await applyProjectPath(project_path);
      try {
        const idleConfig = getIdleReflectionConfig();
        const summaryEnabled = idleConfig.operations?.session_summary ?? true;

        const aggregated = await getTokenStatsAggregated();

        const lines: string[] = ['## Token Savings\n'];

        // Session Summaries
        const sessionStats = aggregated.find((s) => s.event_type === 'session_summary');
        lines.push('### Session Summaries');
        if (!summaryEnabled) {
          lines.push('  Status: disabled');
        } else if (sessionStats) {
          lines.push(`  Sessions: ${sessionStats.query_count}`);
          lines.push(`  Transcript: ${formatTokens(sessionStats.total_full_source_tokens)} tokens`);
          lines.push(`  Summary: ${formatTokens(sessionStats.total_returned_tokens)} tokens`);
          lines.push(
            `  Compression: ${compressionPercent(sessionStats.total_full_source_tokens, sessionStats.total_returned_tokens)}`
          );
          lines.push(`  Saved: ${formatTokens(sessionStats.total_savings_tokens)} tokens`);
        } else {
          lines.push('  No session summaries recorded yet.');
        }

        // RAG Queries
        lines.push('\n### RAG Queries');

        const ragTypes: TokenEventType[] = ['recall', 'search', 'search_code'];
        let hasRagStats = false;
        let ragTotalQueries = 0;
        let ragTotalReturned = 0;
        let ragTotalSaved = 0;

        for (const type of ragTypes) {
          const stat = aggregated.find((s) => s.event_type === type);
          if (stat) {
            hasRagStats = true;
            ragTotalQueries += stat.query_count;
            ragTotalReturned += stat.total_returned_tokens;

            if (stat.total_savings_tokens > 0) {
              ragTotalSaved += stat.total_savings_tokens;
              lines.push(
                `  ${type.padEnd(12)}: ${stat.query_count} queries, ${formatTokens(stat.total_returned_tokens)} returned, ${formatTokens(stat.total_savings_tokens)} saved`
              );
            } else {
              lines.push(
                `  ${type.padEnd(12)}: ${stat.query_count} queries, ${formatTokens(stat.total_returned_tokens)} returned`
              );
            }
          }
        }

        if (!hasRagStats) {
          lines.push('  No RAG queries recorded yet.');
        }

        // Web Searches
        try {
          const wsSummary = await getWebSearchSummary();
          if (wsSummary.total_searches > 0) {
            lines.push('\n### Web Searches');
            for (const [tool, stats] of Object.entries(wsSummary.by_tool)) {
              const shortName = tool.replace('succ_', '');
              lines.push(
                `  ${shortName.padEnd(16)}: ${stats.count} queries, $${stats.cost.toFixed(4)}`
              );
            }
            lines.push(
              `  Today: ${wsSummary.today_searches} searches, $${wsSummary.today_cost_usd.toFixed(4)}`
            );
          }
        } catch {
          /* ignore */
        }

        // Total — compute from aggregated data (same logic as CLI stats.ts)
        const sessionSaved = sessionStats?.total_savings_tokens || 0;
        const totalSaved = sessionSaved + ragTotalSaved;

        lines.push('\n### Total');
        if (totalSaved > 0) {
          lines.push(`  Total saved: ${formatTokens(totalSaved)} tokens`);
        } else if (ragTotalQueries > 0) {
          lines.push(`  Queries: ${ragTotalQueries}, ${formatTokens(ragTotalReturned)} returned`);
          lines.push("  No token savings yet (recall-only queries don't compute savings).");
        } else {
          lines.push('  No stats recorded yet.');
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: lines.join('\n'),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error getting stats: ${error.message}`,
            },
          ],
          isError: true,
        };
      } finally {
        closeDb();
      }
    }
  );

  // Tool: succ_score - Get AI-readiness score
  server.tool(
    'succ_score',
    'Get the AI-readiness score for the project. Shows how well-prepared the project is for AI collaboration, with metrics for brain vault, memories, code index, and more.',
    {
      project_path: projectPathParam,
    },
    async ({ project_path }) => {
      await applyProjectPath(project_path);
      try {
        const { calculateAIReadinessScore, formatAIReadinessScore } =
          await import('../../lib/ai-readiness.js');
        const result = await calculateAIReadinessScore();
        return {
          content: [
            {
              type: 'text' as const,
              text: formatAIReadinessScore(result),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error calculating score: ${error.message}`,
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
