import pLimit from 'p-limit';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getStorageDispatcher,
  hybridSearchMemories,
  hybridSearchGlobalMemories,
  getRecentMemories,
  getRecentGlobalMemories,
  closeDb,
  closeGlobalDb,
} from '../../../lib/storage/index.js';
import type { HybridMemoryResult } from '../../../lib/storage/index.js';
import {
  isGlobalOnlyMode,
  getReadinessGateConfig,
  getRetrievalConfig,
  getConfig,
} from '../../../lib/config.js';
import { getEmbedding } from '../../../lib/embeddings.js';
import { applyTemporalScoring, getTemporalConfig } from '../../../lib/temporal.js';
import { assessReadiness, formatReadinessHeader } from '../../../lib/readiness.js';
import {
  trackTokenSavings,
  trackMemoryAccess,
  projectPathParam,
  applyProjectPath,
  extractAnswerFromResults,
  createErrorResponse,
} from '../../helpers.js';
import { logWarn } from '../../../lib/fault-logger.js';
import { getErrorMessage } from '../../../lib/errors.js';
import { extractTemporalSubqueriesAsync } from './temporal-query.js';

interface ExtendedMemoryResult extends HybridMemoryResult {
  isGlobal?: boolean;
  project?: string;
  _isDeadEnd?: boolean;
}

/** Composite key for audit maps — prevents local/global ID collisions on SQLite. */
const auditKey = (id: number, isGlobal: boolean): string =>
  `${isGlobal ? 'global' : 'local'}:${id}`;

export function registerRecallTool(server: McpServer): void {
  server.registerTool(
    'succ_recall',
    {
      description:
        'Recall relevant memories from past sessions using hybrid search (BM25 + semantic). Searches both project-local and global (cross-project) memories. Works even in projects without .succ/ (global-only mode). Use as_of_date for point-in-time queries.\n\nExamples:\n- Find decisions: succ_recall(query="authentication", tags=["decision"])\n- Recent only: succ_recall(query="bug fix", since="last week", limit=3)\n- Point-in-time: succ_recall(query="API design", as_of_date="2025-06-01")',
      inputSchema: {
        query: z.string().describe('What to recall (semantic search)'),
        limit: z
          .number()
          .optional()
          .describe('Maximum number of memories (default: from config, typically 10)'),
        tags: z.array(z.string()).optional().describe('Filter by tags (e.g., ["decision"])'),
        since: z
          .string()
          .optional()
          .describe('Only memories after this date (ISO format or "yesterday", "last week")'),
        as_of_date: z
          .string()
          .optional()
          .describe(
            'Point-in-time query: show memories as they were valid on this date. For post-mortems, audits, debugging past state. ISO format (2024-06-01).'
          ),
        extract: z
          .string()
          .optional()
          .describe(
            'Extract a specific answer from results using LLM. Instead of returning raw results, returns a concise answer to this question. Adds latency but saves 50-80% output tokens.'
          ),
        history: z
          .boolean()
          .optional()
          .describe(
            'When true, includes edit/mutation history for each returned memory. Shows create/update/delete/merge events over time.'
          ),
        project_path: projectPathParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, limit: rawLimit, tags, since, as_of_date, extract, history, project_path }) => {
      try {
        await applyProjectPath(project_path);
        const globalOnlyMode = isGlobalOnlyMode();
        const retrievalConfig = getRetrievalConfig();
        const limit = rawLimit ?? retrievalConfig.default_top_k;
        // Special case: "*" means "show recent memories" (no semantic search)
        const isWildcard = query === '*' || query === '**' || query.trim() === '';

        // Parse relative date strings
        let sinceDate: Date | undefined;
        if (since) {
          const now = new Date();
          const lower = since.toLowerCase();
          if (lower === 'yesterday') {
            sinceDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          } else if (lower === 'last week' || lower === 'week') {
            sinceDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          } else if (lower === 'last month' || lower === 'month') {
            sinceDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          } else if (lower === 'today') {
            sinceDate = new Date(now.setHours(0, 0, 0, 0));
          } else {
            sinceDate = new Date(since);
            if (isNaN(sinceDate.getTime())) {
              sinceDate = undefined;
            }
          }
        }

        // For wildcard queries, just get recent memories without semantic search
        if (isWildcard) {
          const recentLocal = globalOnlyMode ? [] : await getRecentMemories(limit);
          const recentGlobal = await getRecentGlobalMemories(limit);

          // Apply tag filter if specified
          let filteredLocal = recentLocal;
          let filteredGlobal = recentGlobal;
          if (tags && tags.length > 0) {
            filteredLocal = recentLocal.filter((m) => {
              const memTags = Array.isArray(m.tags) ? m.tags : [];
              return tags.some((t) => memTags.includes(t));
            });
            filteredGlobal = recentGlobal.filter((m) => {
              const memTags = Array.isArray(m.tags) ? m.tags : [];
              return tags.some((t) => memTags.includes(t));
            });
          }

          // Apply date filter if specified
          if (sinceDate) {
            filteredLocal = filteredLocal.filter((m) => new Date(m.created_at) >= sinceDate!);
            filteredGlobal = filteredGlobal.filter((m) => new Date(m.created_at) >= sinceDate!);
          }

          const parseTags = (t: string | string[] | null): string[] => {
            if (!t) return [];
            if (Array.isArray(t)) return t;
            return t
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
          };

          const allRecent = [
            ...filteredLocal.map((m) => ({ ...m, tags: parseTags(m.tags), isGlobal: false })),
            ...filteredGlobal.map((m) => ({ ...m, isGlobal: true })),
          ].slice(0, limit);

          if (allRecent.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: globalOnlyMode
                    ? 'No global memories found.'
                    : 'No memories found. Use succ_remember to save memories.',
                },
              ],
            };
          }

          const localCount = filteredLocal.length;
          const globalCount = filteredGlobal.length;

          // Fetch audit history for wildcard results if requested
          const wildcardAuditMap = new Map<
            string,
            Array<{ event_type: string; changed_by: string; created_at: string }>
          >();
          if (history) {
            try {
              const dispatcher = await getStorageDispatcher();
              const auditReadLimit = pLimit(5);
              const localIds = allRecent
                .filter((r) => !r.isGlobal && r.id)
                .map((r) => r.id as number);
              const globalIds = allRecent
                .filter((r) => r.isGlobal && r.id)
                .map((r) => r.id as number);
              const auditSettled = await Promise.allSettled([
                ...localIds.map((id) =>
                  auditReadLimit(async () => ({
                    key: auditKey(id, false),
                    events: await dispatcher.getAuditHistory(id, false),
                  }))
                ),
                ...globalIds.map((id) =>
                  auditReadLimit(async () => ({
                    key: auditKey(id, true),
                    events: await dispatcher.getAuditHistory(id, true),
                  }))
                ),
              ]);
              for (const result of auditSettled) {
                if (result.status === 'fulfilled' && result.value.events.length > 0) {
                  wildcardAuditMap.set(
                    result.value.key,
                    result.value.events.map((e) => ({
                      event_type: e.event_type,
                      changed_by: e.changed_by,
                      created_at: e.created_at,
                    }))
                  );
                } else if (result.status === 'rejected') {
                  logWarn('mcp-memory', 'Failed to fetch audit history for wildcard entry', {
                    error: getErrorMessage(result.reason),
                  });
                }
              }
            } catch (histError) {
              logWarn('mcp-memory', 'Failed to fetch audit history for wildcard recall', {
                error: getErrorMessage(histError),
              });
            }
          }

          const formatted = allRecent
            .map((m, i) => {
              const tagStr =
                m.tags.length > 0 ? ` [[${m.tags.map((t: string) => `"${t}"`).join(', ')}]]` : '';
              const date = new Date(m.created_at).toLocaleDateString();
              const scope = m.isGlobal ? '[GLOBAL] ' : '';
              const source = m.source ? ` (from: ${m.source})` : '';
              const matchPct =
                'similarity' in m && m.similarity
                  ? ` (${Math.round(m.similarity * 100)}% match)`
                  : '';

              // Append audit history if available
              let historyStr = '';
              const wKey = m.id ? auditKey(m.id as number, !!m.isGlobal) : '';
              if (history && wKey && wildcardAuditMap.has(wKey)) {
                const events = wildcardAuditMap.get(wKey)!;
                historyStr =
                  '\n\n**Edit History:**\n' +
                  events
                    .map(
                      (e: { event_type: string; changed_by: string; created_at: string }) =>
                        `- ${new Date(e.created_at).toLocaleString()}: ${e.event_type} (by ${e.changed_by})`
                    )
                    .join('\n');
              }

              const srcCtx =
                'source_context' in m && m.source_context
                  ? `\n<source-context>\n${m.source_context}\n</source-context>\n`
                  : '';
              return `### ${i + 1}. ${scope}${date}${tagStr}${source}${matchPct}\n\n${m.content}${historyStr}${srcCtx}\n`;
            })
            .join('\n---\n\n');

          return {
            content: [
              {
                type: 'text' as const,
                text: `Found ${allRecent.length} recent memories (${localCount} local, ${globalCount} global):\n\n${formatted}`,
              },
            ],
          };
        }

        const queryEmbedding = await getEmbedding(query);

        // ── Temporal query decomposition: multi-pass retrieval for time-spanning questions ──
        const isTemporalQuery =
          /\b(between|after|before|days|weeks|months|since|how long|how many days|when did|first time|last time|started|ended|began|stopped)\b/i.test(
            query
          ) ||
          /\b(между|после|до|перед|дней|недель|месяцев|с тех пор|сколько дней|сколько времени|когда|впервые|в первый раз|в последний раз|начал[аиось]?|закончил[аиось]?|прекратил[аиось]?)\b/i.test(
            query
          );

        let localResults: HybridMemoryResult[];

        if (isTemporalQuery && !globalOnlyMode) {
          // Extract key entities from query for separate searches
          // e.g., "How many days between starting project X and deploying it?"
          // → subqueries: ["starting project X", "deploying project X"]
          const subQueries = await extractTemporalSubqueriesAsync(query);

          if (subQueries.length > 1) {
            // Multi-pass: search for each entity separately, merge results
            const allSubResults = new Map<number, HybridMemoryResult>();

            // Compute all subquery embeddings in parallel
            const subEmbeddings = await Promise.all(subQueries.map((sq) => getEmbedding(sq)));

            // Run all subquery searches in parallel
            const subSearchResults = await Promise.all(
              subQueries.map((sq, i) =>
                hybridSearchMemories(sq, subEmbeddings[i], limit, 0.2, retrievalConfig.bm25_alpha)
              )
            );

            for (const subResults of subSearchResults) {
              for (const r of subResults) {
                if (
                  !allSubResults.has(r.id) ||
                  r.similarity > allSubResults.get(r.id)!.similarity
                ) {
                  allSubResults.set(r.id, r);
                }
              }
            }

            // Also include results from the original query
            const originalResults = await hybridSearchMemories(
              query,
              queryEmbedding,
              limit,
              0.3,
              retrievalConfig.bm25_alpha
            );
            for (const r of originalResults) {
              if (!allSubResults.has(r.id) || r.similarity > allSubResults.get(r.id)!.similarity) {
                allSubResults.set(r.id, r);
              }
            }

            localResults = Array.from(allSubResults.values())
              .sort((a, b) => b.similarity - a.similarity)
              .slice(0, limit * 2);
          } else {
            localResults = await hybridSearchMemories(
              query,
              queryEmbedding,
              limit * 2,
              0.3,
              retrievalConfig.bm25_alpha
            );
          }
        } else if (retrievalConfig.graph_ppr_enabled && !globalOnlyMode) {
          // Graph-enhanced search: BM25 + vector + PPR as third signal
          try {
            const { graphEnhancedSearchMemories } =
              await import('../../../lib/db/hybrid-search.js');
            localResults = await graphEnhancedSearchMemories(
              query,
              queryEmbedding,
              limit * 2,
              0.3,
              retrievalConfig.bm25_alpha,
              retrievalConfig.graph_ppr_weight
            );
          } catch (err) {
            logWarn('recall', 'Graph-enhanced search failed, falling back to standard', {
              error: getErrorMessage(err),
            });
            localResults = await hybridSearchMemories(
              query,
              queryEmbedding,
              limit * 2,
              0.3,
              retrievalConfig.bm25_alpha
            );
          }
        } else {
          // Standard single-pass search
          localResults = globalOnlyMode
            ? []
            : await hybridSearchMemories(
                query,
                queryEmbedding,
                limit * 2,
                0.3,
                retrievalConfig.bm25_alpha
              );
        }

        // ── Query expansion: LLM-generated alternative queries for broader recall ──
        if (
          retrievalConfig.query_expansion_enabled &&
          !globalOnlyMode &&
          query.split(/\s+/).length > 5
        ) {
          try {
            const { expandQuery } = await import('../../../lib/query-expansion.js');
            const expandedQueries = await expandQuery(query, retrievalConfig.query_expansion_mode);
            if (expandedQueries.length > 0) {
              // Compute all expansion embeddings + searches in parallel
              const eqEmbeddings = await Promise.all(expandedQueries.map((eq) => getEmbedding(eq)));
              const eqSearchResults = await Promise.all(
                expandedQueries.map((eq, i) =>
                  hybridSearchMemories(eq, eqEmbeddings[i], limit, 0.3, retrievalConfig.bm25_alpha)
                )
              );

              const existingIdx = new Map(localResults.map((r, i) => [r.id, i]));
              for (const eqResults of eqSearchResults) {
                for (const r of eqResults) {
                  const idx = existingIdx.get(r.id);
                  if (idx === undefined) {
                    existingIdx.set(r.id, localResults.length);
                    localResults.push(r);
                  } else if (r.similarity > localResults[idx].similarity) {
                    // Keep the higher similarity score
                    localResults[idx].similarity = r.similarity;
                  }
                }
              }
              localResults.sort((a, b) => b.similarity - a.similarity);
              localResults = localResults.slice(0, limit * 2);
            }
          } catch (err) {
            logWarn('mcp-memory', 'Query expansion failed', {
              error: getErrorMessage(err),
            });
          }
        }

        // Helper to parse tags (can be string or array depending on backend)
        const parseTags = (t: string | string[] | null): string[] => {
          if (!t) return [];
          if (Array.isArray(t)) return t;
          return t
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        };

        // Apply tag filter if specified
        if (tags && tags.length > 0) {
          localResults = localResults.filter((m) => {
            const memTags = parseTags(m.tags);
            return tags.some((t) => memTags.includes(t));
          });
        }

        // Apply date filter if specified
        if (sinceDate) {
          localResults = localResults.filter((m) => new Date(m.created_at) >= sinceDate!);
        }

        // Apply point-in-time validity filter (as_of_date)
        let asOfDateObj: Date | undefined;
        if (as_of_date) {
          asOfDateObj = new Date(as_of_date);
          if (isNaN(asOfDateObj.getTime())) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid as_of_date: "${as_of_date}". Use ISO format (2024-06-01).`,
                },
              ],
              isError: true,
            };
          }

          localResults = localResults.filter((m) => {
            const createdAt = new Date(m.created_at);
            if (createdAt > asOfDateObj!) return false;

            if (m.valid_from) {
              const validFrom = new Date(m.valid_from);
              if (validFrom > asOfDateObj!) return false;
            }

            if (m.valid_until) {
              const validUntil = new Date(m.valid_until);
              if (validUntil < asOfDateObj!) return false;
            }

            return true;
          });
        }

        localResults = localResults.slice(0, limit);

        // Global memories now use hybrid search (BM25 + vector)
        const globalResults = await hybridSearchGlobalMemories(
          query,
          queryEmbedding,
          limit,
          0.3,
          retrievalConfig.bm25_alpha,
          tags,
          sinceDate
        );

        // Merge and sort by similarity
        let allResults = [
          ...localResults.map((r) => ({ ...r, tags: parseTags(r.tags), isGlobal: false })),
          ...globalResults.map((r) => ({ ...r, isGlobal: true })),
        ]
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, limit);

        // Apply temporal scoring if enabled (time decay + access boost)
        // Auto-skip: when all results are <24h old, decay adds noise not signal
        const temporalConfig = getTemporalConfig();
        if (temporalConfig.enabled && !as_of_date) {
          const now = Date.now();
          const DAY_MS = 24 * 60 * 60 * 1000;
          const allRecent =
            retrievalConfig.temporal_auto_skip &&
            allResults.length > 0 &&
            allResults.every((r) => now - new Date(r.created_at).getTime() < DAY_MS);

          if (!allRecent) {
            const scoredResults = applyTemporalScoring(
              allResults.map((r) => ({
                ...r,
                last_accessed: r.last_accessed || null,
                access_count: r.access_count || 0,
                valid_from: r.valid_from || null,
                valid_until: r.valid_until || null,
              })),
              temporalConfig
            );
            allResults = scoredResults;
          }
        }

        // Apply dead-end boost: surface dead-end memories higher in results
        const config = getConfig();
        const deadEndBoost = config.dead_end_boost ?? 0.15;
        if (deadEndBoost > 0) {
          allResults = allResults.map((r) => {
            const memType = r.type;
            const memTags = Array.isArray(r.tags) ? r.tags : [];
            const isDeadEnd = memType === 'dead_end' || memTags.includes('dead-end');
            if (isDeadEnd) {
              return {
                ...r,
                similarity: Math.min(1.0, r.similarity + deadEndBoost),
                _isDeadEnd: true,
              } as ExtendedMemoryResult;
            }
            return r;
          });
          allResults.sort((a, b) => b.similarity - a.similarity);
        }

        // Apply centrality boost: well-connected memories rank higher
        if (config.graph_centrality?.enabled && allResults.length > 0) {
          try {
            const { applyCentralityBoost } = await import('../../../lib/graph/centrality.js');
            allResults = await applyCentralityBoost(allResults, config.graph_centrality);
          } catch (error) {
            logWarn('mcp-memory', 'Centrality boost skipped due runtime error', {
              error: getErrorMessage(error),
            });
          }
        }

        // Quality boost: higher-quality memories rank higher
        if (retrievalConfig.quality_boost_enabled && allResults.length > 0) {
          const weight = retrievalConfig.quality_boost_weight;
          allResults = allResults.map((r) => {
            const result = r as ExtendedMemoryResult;
            const qs =
              'quality_score' in result && typeof result.quality_score === 'number'
                ? result.quality_score
                : null;
            if (qs != null && qs > 0) {
              const factor = 1 - weight + weight * qs;
              return { ...result, similarity: result.similarity * factor };
            }
            return result;
          });
          allResults.sort((a, b) => b.similarity - a.similarity);
        }

        // MMR diversity reranking: reduce near-duplicate results
        if (retrievalConfig.mmr_enabled && allResults.length > 1) {
          try {
            const { applyMMR } = await import('../../../lib/mmr.js');
            const { getMemoryEmbeddingsByIds } = await import('../../../lib/storage/index.js');
            const embMap = await getMemoryEmbeddingsByIds(allResults.map((r) => r.id));

            const mmrInput = allResults.map((r) => ({
              ...r,
              embedding: embMap.get(r.id) || null,
            }));

            allResults = applyMMR(
              mmrInput,
              Array.from(queryEmbedding),
              retrievalConfig.mmr_lambda,
              limit
            );
          } catch (error) {
            logWarn('mcp-memory', 'MMR reranking skipped due runtime error', {
              error: getErrorMessage(error),
            });
          }
        }

        if (allResults.length === 0) {
          // Try to show recent memories as fallback
          const recentLocal = await getRecentMemories(2);
          const recentGlobal = await getRecentGlobalMemories(2);

          const recent = [
            ...recentLocal.map((m) => ({ ...m, isGlobal: false })),
            ...recentGlobal.map((m) => ({ ...m, isGlobal: true })),
          ].slice(0, 3);

          if (recent.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `No memories found for "${query}". Memory is empty.`,
                },
              ],
            };
          }

          // Fetch audit history for fallback memories if requested
          const fallbackAuditMap = new Map<
            string,
            Array<{ event_type: string; changed_by: string; created_at: string }>
          >();
          if (history) {
            try {
              const dispatcher = await getStorageDispatcher();
              const auditReadLimit = pLimit(5);
              const localFallbackIds = recent
                .filter((r) => !r.isGlobal && r.id)
                .map((r) => r.id as number);
              const globalFallbackIds = recent
                .filter((r) => r.isGlobal && r.id)
                .map((r) => r.id as number);
              const fallbackSettled = await Promise.allSettled([
                ...localFallbackIds.map((id) =>
                  auditReadLimit(async () => ({
                    key: auditKey(id, false),
                    events: await dispatcher.getAuditHistory(id, false),
                  }))
                ),
                ...globalFallbackIds.map((id) =>
                  auditReadLimit(async () => ({
                    key: auditKey(id, true),
                    events: await dispatcher.getAuditHistory(id, true),
                  }))
                ),
              ]);
              for (const result of fallbackSettled) {
                if (result.status === 'fulfilled' && result.value.events.length > 0) {
                  fallbackAuditMap.set(
                    result.value.key,
                    result.value.events.map((e) => ({
                      event_type: e.event_type,
                      changed_by: e.changed_by,
                      created_at: e.created_at,
                    }))
                  );
                } else if (result.status === 'rejected') {
                  logWarn('mcp-memory', 'Failed to fetch audit history for fallback entry', {
                    error: getErrorMessage(result.reason),
                  });
                }
              }
            } catch (histError) {
              logWarn('mcp-memory', 'Failed to fetch audit history for fallback memories', {
                error: getErrorMessage(histError),
              });
            }
          }

          const recentFormatted = recent
            .map((m, i) => {
              const memTags = parseTags(m.tags);
              const tagStr = memTags.length > 0 ? ` [${memTags.join(', ')}]` : '';
              const date = new Date(m.created_at).toLocaleDateString();
              const scope = m.isGlobal ? '[GLOBAL] ' : '';
              let historyStr = '';
              const fbKey = m.id ? auditKey(m.id as number, !!m.isGlobal) : '';
              if (history && fbKey && fallbackAuditMap.has(fbKey)) {
                const events = fallbackAuditMap.get(fbKey)!;
                historyStr =
                  '\n  Edit History: ' +
                  events
                    .map(
                      (e) =>
                        `${new Date(e.created_at).toLocaleString()}: ${e.event_type} (by ${e.changed_by})`
                    )
                    .join('; ');
              }
              return `${i + 1}. ${scope}(${date})${tagStr}: ${m.content.substring(0, 150)}${m.content.length > 150 ? '...' : ''}${historyStr}`;
            })
            .join('\n');

          return {
            content: [
              {
                type: 'text' as const,
                text: `No memories matching "${query}". Here are recent memories:\n\n${recentFormatted}`,
              },
            ],
          };
        }

        // Track token savings for recall
        await trackTokenSavings(
          'recall',
          query,
          allResults.map((m) => ({ file_path: `memory:${m.id || 'unknown'}`, content: m.content }))
        );

        // Track memory access for retention decay (local memories only)
        const localMemoryIds = allResults
          .filter((r) => !r.isGlobal && r.id)
          .map((r) => r.id as number);
        await trackMemoryAccess(localMemoryIds, limit, localResults.length + globalResults.length);

        // Fetch audit history if requested
        const auditMap = new Map<
          string,
          Array<{ event_type: string; changed_by: string; created_at: string }>
        >();
        if (history) {
          try {
            const dispatcher = await getStorageDispatcher();
            const auditReadLimit = pLimit(5);
            const localIds = allResults
              .filter((r) => !r.isGlobal && r.id)
              .map((r) => r.id as number);
            const globalIds = allResults
              .filter((r) => r.isGlobal && r.id)
              .map((r) => r.id as number);
            const auditSettled = await Promise.allSettled([
              ...localIds.map((id) =>
                auditReadLimit(async () => ({
                  key: auditKey(id, false),
                  events: await dispatcher.getAuditHistory(id, false),
                }))
              ),
              ...globalIds.map((id) =>
                auditReadLimit(async () => ({
                  key: auditKey(id, true),
                  events: await dispatcher.getAuditHistory(id, true),
                }))
              ),
            ]);
            for (const result of auditSettled) {
              if (result.status === 'fulfilled' && result.value.events.length > 0) {
                auditMap.set(
                  result.value.key,
                  result.value.events.map((e) => ({
                    event_type: e.event_type,
                    changed_by: e.changed_by,
                    created_at: e.created_at,
                  }))
                );
              } else if (result.status === 'rejected') {
                logWarn('mcp-memory', 'Failed to fetch audit history for entry', {
                  error: getErrorMessage(result.reason),
                });
              }
            }
          } catch (histError) {
            logWarn('mcp-memory', 'Failed to fetch audit history', {
              error: getErrorMessage(histError),
            });
          }
        }

        const formatted = allResults
          .map((m, i) => {
            const similarity = (m.similarity * 100).toFixed(0);
            const memTags = Array.isArray(m.tags) ? m.tags : parseTags(m.tags);
            const tagStr = memTags.length > 0 ? ` [${memTags.join(', ')}]` : '';
            const date = new Date(m.created_at).toLocaleDateString();
            const sourceStr = m.source ? ` (from: ${m.source})` : '';
            const scope = m.isGlobal ? ' [GLOBAL]' : '';
            const projectStr =
              m.isGlobal && 'project' in m && m.project ? ` (project: ${m.project})` : '';

            // Show temporal validity info if present
            const result = m as ExtendedMemoryResult;
            const validFrom = result.valid_from;
            const validUntil = result.valid_until;
            let validityStr = '';
            if (validFrom || validUntil) {
              const fromStr = validFrom ? new Date(validFrom).toLocaleDateString() : '∞';
              const untilStr = validUntil ? new Date(validUntil).toLocaleDateString() : '∞';
              validityStr = ` [valid: ${fromStr} → ${untilStr}]`;
            }

            // Dead-end warning prefix
            const deadEndPrefix = result._isDeadEnd ? '**WARNING: Dead End** ' : '';

            // Append audit history if available
            let historyStr = '';
            const mKey = m.id ? auditKey(m.id as number, !!m.isGlobal) : '';
            if (history && mKey && auditMap.has(mKey)) {
              const events = auditMap.get(mKey)!;
              historyStr =
                '\n\n**Edit History:**\n' +
                events
                  .map(
                    (e: { event_type: string; changed_by: string; created_at: string }) =>
                      `- ${new Date(e.created_at).toLocaleString()}: ${e.event_type} (by ${e.changed_by})`
                  )
                  .join('\n');
            }

            // Source context: the original conversation/code excerpt that produced this memory
            const sourceCtx =
              result.source_context
                ? `\n\n<source-context>\n${result.source_context}\n</source-context>`
                : '';

            return `### ${i + 1}. ${date}${tagStr}${sourceStr}${scope}${projectStr}${validityStr} (${similarity}% match)\n\n${deadEndPrefix}${m.content}${historyStr}${sourceCtx}`;
          })
          .join('\n\n---\n\n');

        const localCount = allResults.filter((r) => !r.isGlobal).length;
        const globalCount = allResults.filter((r) => r.isGlobal).length;
        const asOfStr = as_of_date ? ` (as of ${as_of_date})` : '';
        const summary = `Found ${allResults.length} memories (${localCount} local, ${globalCount} global)${asOfStr}`;

        // Readiness gate: assess result confidence
        const memGateConfig = getReadinessGateConfig();
        let memReadinessHeader = '';
        if (memGateConfig.enabled) {
          const assessment = assessReadiness(allResults, 'memories', memGateConfig);
          memReadinessHeader = formatReadinessHeader(assessment);
          if (memReadinessHeader) memReadinessHeader += '\n\n';
        }

        const recallHint =
          "> These are verified facts from the user's project and past sessions. Prefer these over general knowledge when answering.\n\n";

        // Smart Result Compression: extract specific answer via LLM
        if (extract && allResults.length > 0) {
          const answer = await extractAnswerFromResults(formatted, extract, 'succ_recall');
          return {
            content: [
              {
                type: 'text' as const,
                text: `${summary} for "${query}" (extracted):\n\n${answer}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `${memReadinessHeader}${recallHint}${summary} for "${query}":\n\n${formatted}`,
            },
          ],
        };
      } catch (error) {
        const errorMsg = getErrorMessage(error);
        logWarn('mcp-memory', 'Error recalling memories', { error: errorMsg });
        return createErrorResponse(`Error recalling memories: ${errorMsg}`);
      } finally {
        closeDb();
        closeGlobalDb();
      }
    }
  );
}
